/* AgentRuntimeCore.sys.mjs — platform-neutral Agent session state kernel.
 *
 * This module deliberately has no Firefox imports. It owns only in-memory
 * session state, event reduction, subscriptions, confirmations, cancellation,
 * and multi-window reservations. Persistence, LLM creation, tools, and browser
 * lifecycle belong to host/session adapters.
 */

export const DEFAULT_NOTIFY_THROTTLE_MS = 50;
export const DEFAULT_RESERVATION_TTL_MS = 8000;

export function textFromSteps(steps) {
  return (steps || [])
    .filter(x => x && x.kind === "text" && typeof x.text === "string" && x.text.trim())
    .map(x => x.text)
    .join("\n")
    .trim();
}

export function slimifySteps(steps) {
  return (steps || []).map(s => {
    if (s.images && s.images.length) {
      const { images, ...rest } = s; // eslint-disable-line no-unused-vars
      return { ...rest, shot: images.length };
    }
    if (s.kind === "think" && s.text && s.text.length > 800) {
      return { ...s, text: s.text.slice(0, 800) + "…（思考已截断）" };
    }
    return s;
  });
}

function summarizeEnvelope(env) {
  if (!env) return "";
  if (!env.ok) return (env.error ? String(env.error) : "失败").slice(0, 80);
  const data = env.data;
  if (data == null) return "ok";
  if (typeof data === "object") {
    for (const key of ["count", "savedCount", "total", "enabled", "requests", "hits", "records", "urls"]) {
      if (data[key] != null) {
        return key + "=" + (Array.isArray(data[key]) ? data[key].length : JSON.stringify(data[key]).slice(0, 40));
      }
    }
    return "ok";
  }
  return String(data).slice(0, 60);
}

export class AgentRuntimeCore {
  constructor({
    now = () => Date.now(),
    setTimeout = globalThis.setTimeout && globalThis.setTimeout.bind(globalThis),
    clearTimeout = globalThis.clearTimeout && globalThis.clearTimeout.bind(globalThis),
    createUsage = () => ({}),
    notifyThrottleMs = DEFAULT_NOTIFY_THROTTLE_MS,
    reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
  } = {}) {
    if (typeof now !== "function") {
      throw new TypeError("AgentRuntimeCore: now must be a function");
    }
    if (typeof setTimeout !== "function" || typeof clearTimeout !== "function") {
      throw new TypeError("AgentRuntimeCore: timer functions are required");
    }
    if (typeof createUsage !== "function") {
      throw new TypeError("AgentRuntimeCore: createUsage must be a function");
    }
    this.now = now;
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.createUsage = createUsage;
    this.notifyThrottleMs = notifyThrottleMs;
    this.reservationTtlMs = reservationTtlMs;
    this.sessions = new Map();
  }

  _newState() {
    return {
      running: false,
      settled: false,
      steps: [],
      _curText: -1,
      _curThink: -1,
      content: "",
      error: null,
      aborted: false,
      abort: null,
      subs: new Set(),
      reservation: null,
      pendingConfirm: null,
      approveAll: false,
      _notifyTimer: null,
      _lastNotify: 0,
      checkpointSeq: 0,
      usage: this.createUsage(),
      lastUsage: null,
      contextStrategy: "projected",
      contextProjected: false,
    };
  }

  getOrInit(threadId) {
    let state = this.sessions.get(threadId);
    if (!state) {
      state = this._newState();
      this.sessions.set(threadId, state);
    }
    return state;
  }

  beginRun(threadId, { usage = {}, contextStrategy = "projected" } = {}) {
    const state = this.getOrInit(threadId);
    if (state.running) {
      return null;
    }
    state.running = true;
    state.settled = false;
    state.steps = [];
    state._curText = -1;
    state._curThink = -1;
    state.content = "";
    state.error = null;
    state.aborted = false;
    state.abort = null;
    state.pendingConfirm = null;
    state.approveAll = false;
    state.checkpointSeq = 0;
    state.usage = usage;
    state.lastUsage = null;
    state.contextStrategy = contextStrategy === "legacy" ? "legacy" : "projected";
    state.contextProjected = false;
    if (state._notifyTimer) {
      this.clearTimeout(state._notifyTimer);
      state._notifyTimer = null;
    }
    state._lastNotify = 0;
    return state;
  }

  settle(state) {
    state.running = false;
    state.settled = true;
    state.abort = null;
    state.pendingConfirm = null;
    this.notify(state);
  }

  isRunning(threadId) {
    const state = this.sessions.get(threadId);
    return !!(state && state.running);
  }

  listRunning() {
    const out = [];
    for (const [id, state] of this.sessions) {
      if (state && state.running) {
        out.push({ id, nSteps: (state.steps || []).length, checkpointSeq: state.checkpointSeq || 0 });
      }
    }
    return out;
  }

  snapshot(state) {
    return {
      running: state.running,
      settled: state.settled,
      steps: state.steps.slice(),
      error: state.error,
      aborted: state.aborted,
      content: state.content,
      checkpointSeq: state.checkpointSeq || 0,
      usage: { ...state.usage },
      lastUsage: state.lastUsage ? { ...state.lastUsage } : null,
      contextStrategy: state.contextStrategy || "projected",
      contextProjected: state.contextProjected === true,
      pendingConfirm: state.pendingConfirm
        ? { id: state.pendingConfirm.id, name: state.pendingConfirm.name, args: state.pendingConfirm.args }
        : null,
    };
  }

  getState(threadId) {
    const state = this.sessions.get(threadId);
    return state ? this.snapshot(state) : null;
  }

  notify(state) {
    if (state._notifyTimer) {
      this.clearTimeout(state._notifyTimer);
      state._notifyTimer = null;
    }
    state._lastNotify = this.now();
    const current = this.snapshot(state);
    for (const callback of state.subs) {
      try {
        callback(current);
      } catch {
        // A sidebar document may have been destroyed without unsubscribing.
      }
    }
  }

  notifyThrottled(state) {
    const since = this.now() - (state._lastNotify || 0);
    if (since >= this.notifyThrottleMs) {
      this.notify(state);
    } else if (!state._notifyTimer) {
      state._notifyTimer = this.setTimeout(() => {
        state._notifyTimer = null;
        this.notify(state);
      }, this.notifyThrottleMs - since);
    }
  }

  pushDelta(state, chunk) {
    const index = state._curText;
    if (index >= 0 && state.steps[index] && state.steps[index].kind === "text") {
      state.steps[index] = { ...state.steps[index], text: state.steps[index].text + chunk };
    } else {
      state.steps.push({ kind: "text", text: chunk });
      state._curText = state.steps.length - 1;
      state._curThink = -1;
    }
  }

  pushReasoning(state, chunk) {
    const index = state._curThink;
    if (index >= 0 && state.steps[index] && state.steps[index].kind === "think") {
      state.steps[index] = { ...state.steps[index], text: state.steps[index].text + chunk };
    } else {
      state.steps.push({ kind: "think", text: chunk });
      state._curThink = state.steps.length - 1;
      state._curText = -1;
    }
  }

  applyEvent(state, event) {
    if (event.type === "round") {
      state._curText = -1;
      state._curThink = -1;
    } else if (event.type === "tool_call") {
      state.steps.push({ kind: "tool", id: event.id, name: event.name, status: "running" });
      state._curText = -1;
      state._curThink = -1;
    } else if (event.type === "tool_result") {
      const index = state.steps.findIndex(
        item => item.kind === "tool" && item.id === event.id && item.status === "running"
      );
      if (index >= 0) {
        const images =
          event.env && Array.isArray(event.env.media)
            ? event.env.media.filter(item => item && item.type === "image" && item.dataUrl).map(item => item.dataUrl)
            : null;
        state.steps[index] = {
          ...state.steps[index],
          status: event.env && event.env.ok ? "ok" : "err",
          summary: summarizeEnvelope(event.env),
          ...(images && images.length ? { images } : {}),
        };
      }
    }
  }

  subscribe(threadId, callback) {
    const state = this.getOrInit(threadId);
    state.subs.add(callback);
    try {
      callback(this.snapshot(state));
    } catch {
      // Ignore a subscriber that disappeared during initial delivery.
    }
    return () => {
      state.subs.delete(callback);
      if (state.subs.size === 0) {
        state.reservation = null;
      }
    };
  }

  respondConfirm(threadId, id, approved, all) {
    const state = this.sessions.get(threadId);
    if (!state || !state.pendingConfirm || state.pendingConfirm.id !== id) {
      return false;
    }
    if (all && approved) {
      state.approveAll = true;
    }
    const resolve = state.pendingConfirm.resolve;
    state.pendingConfirm = null;
    this.notify(state);
    resolve(!!approved);
    return true;
  }

  abortThread(threadId) {
    const state = this.sessions.get(threadId);
    if (!state || !state.abort) {
      return false;
    }
    try {
      state.abort.abort();
    } catch {
      // AbortController implementations are allowed to be idempotent.
    }
    if (state.pendingConfirm && typeof state.pendingConfirm.resolve === "function") {
      const resolve = state.pendingConfirm.resolve;
      state.pendingConfirm = null;
      try {
        resolve(false);
      } catch {
        // The confirmation waiter may already have settled.
      }
    }
    state.aborted = true;
    this.notify(state);
    return true;
  }

  abortAll() {
    for (const state of this.sessions.values()) {
      try {
        state.abort?.abort();
      } catch {
        // Best effort during host shutdown.
      }
    }
  }

  acquireThread(candidateIds, owner) {
    const token = owner || "anon";
    const now = this.now();
    for (const id of candidateIds || []) {
      if (!id) continue;
      const state = this.getOrInit(id);
      const reservation = state.reservation;
      const liveOther =
        reservation &&
        reservation.owner !== token &&
        now - reservation.ts < this.reservationTtlMs;
      if (!liveOther) {
        state.reservation = { owner: token, ts: now };
        return id;
      }
    }
    return null;
  }

  renewThread(threadId, owner) {
    const state = this.sessions.get(threadId);
    if (!state) return false;
    const token = owner || "anon";
    if (!state.reservation) {
      state.reservation = { owner: token, ts: this.now() };
      return true;
    }
    if (state.reservation.owner !== token) return false;
    state.reservation.ts = this.now();
    return true;
  }

  releaseThread(threadId, owner) {
    const state = this.sessions.get(threadId);
    if (!state || !state.reservation) return;
    if (owner && state.reservation.owner !== owner) return;
    state.reservation = null;
  }
}
