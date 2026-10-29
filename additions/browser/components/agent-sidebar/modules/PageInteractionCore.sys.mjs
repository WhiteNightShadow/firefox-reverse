import { computeAccessibleName, getRole, isInaccessible } from "./PageAccessibility.sys.mjs";

const TARGETS = "a[href],button,input,textarea,select,summary,[role],[tabindex],[contenteditable=true]";
const LEGACY_TEXT_TARGETS = "a,button,[role=button],input[type=submit],input[type=button],[onclick],summary,label,li,span,div";
const clean = value => String(value || "").replace(/\s+/g, " ").trim();
const bounded = (value, fallback, max) => Math.max(1, Math.min(max, Math.floor(Number(value) || fallback)));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const MAX_TYPED = 2000;
const TYPING_BUDGET_MS = 10000;

// US layout with Firefox keyCodes ('-' is 173, '=' is 61, ';' is 59).
const SHIFTED = { "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/" };
const PUNCTUATION = { "`": ["Backquote", 192], "-": ["Minus", 173], "=": ["Equal", 61], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 59], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191] };
const NAMED_KEYS = { Enter: ["Enter", 13], Backspace: ["Backspace", 8], Shift: ["ShiftLeft", 16] };

/** The physical key that types `character` on a US keyboard, or null for text that needs an input method. */
export function keyFor(character) {
  if (character === " ") return { key: " ", code: "Space", keyCode: 32, shift: false };
  if (/^[a-zA-Z]$/.test(character)) {
    return { key: character, code: "Key" + character.toUpperCase(), keyCode: character.toUpperCase().charCodeAt(0), shift: character !== character.toLowerCase() };
  }
  const base = SHIFTED[character] ?? character;
  if (/^[0-9]$/.test(base)) return { key: character, code: "Digit" + base, keyCode: base.charCodeAt(0), shift: base !== character };
  const punctuation = PUNCTUATION[base];
  return punctuation ? { key: character, code: punctuation[0], keyCode: punctuation[1], shift: base !== character } : null;
}

let timer;
const sleep = ms => new Promise(resolve => (timer ||= ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs")).setTimeout(resolve, ms));

/**
 * Input through the same paths Firefox's WebDriver uses: the mouse through Window.synthesizeMouseEvent and the
 * keyboard through nsITextInputProcessor. Pages receive trusted pointer/mouse/keyboard/input sequences, and the
 * browser performs the default actions itself (focus on mousedown, click on mouseup, implicit submission on Enter).
 */
export class NativeInput {
  constructor(win, { wait = sleep, random = Math.random, createTip, nonPrintableFlag } = {}) {
    this.win = win;
    this.wait = wait;
    this.random = random;
    this.createTip = createTip || (() => Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor));
    this.nonPrintableFlag = nonPrintableFlag;
    this.pointer = null;
  }

  mouse(type, x, y, clickCount) {
    if (typeof this.win.synthesizeMouseEvent !== "function") throw new Error("native_input_unavailable");
    this.win.synthesizeMouseEvent(type, x, y, { button: 0, clickCount }, { toWindow: true, isDOMEventSynthesized: false });
  }

  /** Moves along a curved, eased path whose duration follows Fitts's law, ending exactly on (x, y). */
  async move(x, y, size = 24) {
    const width = this.win.innerWidth;
    const height = this.win.innerHeight;
    const start = this.pointer || { x: Math.round(width * (0.25 + 0.5 * this.random())), y: Math.round(height * (0.25 + 0.5 * this.random())) };
    const dx = x - start.x;
    const dy = y - start.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 3) {
      const duration = Math.min(650, 90 + 130 * Math.log2(1 + distance / Math.max(8, size)));
      const steps = clamp(Math.round(distance / 20), 4, 24);
      const bend = (this.random() - 0.5) * 0.35 * distance;
      const [nx, ny] = [-dy / distance, dx / distance];
      const c1 = [start.x + dx * 0.3 + nx * bend, start.y + dy * 0.3 + ny * bend];
      const c2 = [start.x + dx * 0.75 + nx * bend * 0.5, start.y + dy * 0.75 + ny * bend * 0.5];
      for (let step = 1; step < steps; step++) {
        const t = step / steps;
        const e = t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
        const u = 1 - e;
        const px = u ** 3 * start.x + 3 * u * u * e * c1[0] + 3 * u * e * e * c2[0] + e ** 3 * x;
        const py = u ** 3 * start.y + 3 * u * u * e * c1[1] + 3 * u * e * e * c2[1] + e ** 3 * y;
        this.mouse("mousemove", clamp(Math.round(px), 0, width - 1), clamp(Math.round(py), 0, height - 1), 0);
        await this.wait((duration / steps) * (0.7 + 0.6 * this.random()));
      }
    }
    this.mouse("mousemove", x, y, 0);
    this.pointer = { x, y };
  }

  /** Settles, presses, holds and releases at (x, y); the browser turns down/up into the click. */
  async press(x, y) {
    await this.wait(30 + 70 * this.random());
    this.mouse("mousedown", x, y, 1);
    await this.wait(55 + 75 * this.random());
    this.mouse("mouseup", x, y, 1);
  }

  async click(x, y, size) {
    await this.move(x, y, size);
    await this.press(x, y);
  }

  // The transaction kind WebDriver uses in content processes: a non-test transaction there cannot dispatch
  // non-printable keys (Enter, Shift, Backspace) because their edit commands come from the parent widget.
  // Events stay trusted and keep their default actions; only the chrome-only Event.isSynthesized differs.
  begin() {
    const tip = this.createTip();
    if (!tip.beginInputTransactionForTests(this.win)) throw new Error("input_busy: another input method is composing in this window");
    return tip;
  }

  named(tip, name, phase) {
    const [code, keyCode] = NAMED_KEYS[name];
    tip[phase](new this.win.KeyboardEvent("", { key: name, code, keyCode }), this.nonPrintableFlag ?? Ci.nsITextInputProcessor.KEY_NON_PRINTABLE_KEY);
  }

  async key(name) {
    const tip = this.begin();
    this.named(tip, name, "keydown");
    await this.wait(40 + 50 * this.random());
    this.named(tip, name, "keyup");
  }

  /** One key per printable ASCII character; other text is committed through a composition, as an IME does. */
  async type(text, { delayMs = 60, multiline = false } = {}) {
    const tip = this.begin();
    const gap = () => this.wait(delayMs * (0.4 + 0.6 * this.random()));
    let composed = "";
    const commit = async () => {
      if (!composed) return;
      tip.commitCompositionWith(composed);
      composed = "";
      await gap();
    };
    for (const character of text) {
      if (character === "\r" || (character === "\n" && !multiline)) continue;
      if (character === "\n") {
        await commit();
        this.named(tip, "Enter", "keydown");
        this.named(tip, "Enter", "keyup");
        await gap();
        continue;
      }
      const key = keyFor(character);
      if (!key) {
        composed += character;
        continue;
      }
      await commit();
      if (key.shift) this.named(tip, "Shift", "keydown");
      const event = new this.win.KeyboardEvent("", { key: key.key, code: key.code, keyCode: key.keyCode });
      tip.keydown(event);
      await this.wait(delayMs * (0.4 + 0.4 * this.random()));
      tip.keyup(event);
      if (key.shift) this.named(tip, "Shift", "keyup");
      await gap();
    }
    await commit();
  }
}

export class PageInteractionCore {
  constructor(win, input = new NativeInput(win)) {
    this.win = win;
    this.input = input;
    this.elements = new Map();
    this.ids = new WeakMap();
    this.sequence = 0;
    this.styleOptions = { getComputedStyle: win.getComputedStyle.bind(win) };
  }

  visible(element) {
    return element.isConnected && element.ownerDocument === this.win.document &&
      !!element.getClientRects().length && !isInaccessible(element, this.styleOptions);
  }

  id(element) {
    let id = this.ids.get(element);
    if (!id || !this.elements.has(id)) {
      id = String(++this.sequence);
      this.ids.set(element, id);
      this.elements.set(id, new WeakRef(element));
      if (this.elements.size > 1000) this.elements.delete(this.elements.keys().next().value);
    }
    return id;
  }

  describe(element) {
    const rect = element.getBoundingClientRect();
    return { id: this.id(element), tag: element.localName, role: getRole(element),
      name: clean(computeAccessibleName(element)).slice(0, 160),
      disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
  }

  scan(args = {}) {
    for (const key of ["selector", "scope", "role", "name", "label", "text"]) {
      if (args[key] !== undefined && (typeof args[key] !== "string" || args[key].length > 2000)) throw new Error("invalid_locator: strings must be at most 2000 characters");
    }
    const limit = bounded(args.limit, 40, 120);
    const maxNodes = bounded(args.maxNodes, 4000, 10000);
    const document = this.win.document;
    const scope = args.scope ? document.querySelector(args.scope) : document;
    if (!scope) throw new Error("scope_not_found: choose an existing CSS scope in this frame");
    const selector = args.selector || (args.text ? "*" : TARGETS);
    const matches = [];
    const stack = [scope];
    let visited = 0;
    let truncated = false;
    const compare = (value, query) => args.exact === false ? clean(value).includes(clean(query)) : clean(value) === clean(query);
    while (stack.length) {
      const root = stack.pop();
      const walker = document.createTreeWalker(root, 1);
      for (let element = root.nodeType === 1 ? root : walker.nextNode(); element; element = walker.nextNode()) {
        if (++visited > maxNodes) { truncated = true; break; }
        if (element.shadowRoot) stack.push(element.shadowRoot);
        if (!element.matches(selector) || !this.visible(element)) continue;
        if (args.role && getRole(element) !== args.role) continue;
        if (args.name !== undefined && !compare(computeAccessibleName(element), args.name)) continue;
        if (args.label !== undefined) {
          const label = [...(element.labels || [])].map(item => item.textContent).join(" ") || element.getAttribute("aria-label") || "";
          if (!compare(label, args.label)) continue;
        }
        if (args.text !== undefined && !compare(element.textContent, args.text)) continue;
        if (matches.length === limit) { truncated = true; break; }
        matches.push(this.describe(element));
      }
      if (truncated) break;
    }
    return { ok: true, url: document.URL, title: document.title, elements: matches, visited: Math.min(visited, maxNodes), truncated };
  }

  resolve(args) {
    if (args.id) {
      const element = this.elements.get(String(args.id))?.deref();
      if (!element || !element.isConnected || element.ownerDocument !== this.win.document) throw new Error("stale_ref: element detached; refresh snapshot");
      return element;
    }
    if (!["selector", "role", "name", "label", "text"].some(key => args[key] !== undefined)) throw new Error("locator_required");
    const found = this.scan({ ...args, limit: 2 });
    if (found.elements.length > 1) throw new Error("ambiguous_target: refine locator or use a snapshot ref");
    if (found.truncated) throw new Error("incomplete_search: narrow scope before acting");
    if (!found.elements.length) throw new Error("target_not_found");
    return this.elements.get(found.elements[0].id).deref();
  }

  /** The old selector/text contract: first selector match, else the shortest exact, then partial, visible text match. */
  resolveLegacy(args, action) {
    const document = this.win.document;
    let element = null;
    if (args.selector) {
      try { element = document.querySelector(args.selector); } catch {}
    }
    if (!element && args.text && action === "click") {
      const shown = item => !!(item.offsetWidth || item.offsetHeight || item.getClientRects().length);
      const exact = [];
      const partial = [];
      for (const item of document.querySelectorAll(LEGACY_TEXT_TARGETS)) {
        if (!shown(item)) continue;
        const value = (item.innerText || item.textContent || "").trim();
        if (value === args.text) exact.push(item);
        else if (value && value.includes(args.text)) partial.push(item);
      }
      element = (exact.length ? exact : partial).sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0] || null;
    }
    if (!element) throw new Error(action === "type" ? "target_not_found: no input matches the selector" : "target_not_found: selector/text matched nothing");
    return element;
  }

  hits(element, x, y) {
    const root = element.getRootNode();
    const hit = (typeof root.elementFromPoint === "function" ? root : this.win.document).elementFromPoint(x, y);
    if (!hit) return false;
    // Pressing a label activates its control, so a label drawn over an input still reaches the input.
    return hit === element || element.contains(hit) || [...(element.labels || [])].some(label => label === hit || label.contains(hit));
  }

  /** A point in the element's first box that hit-testing resolves to the element; a pointer cannot press what covers it. */
  point(element) {
    const box = [...element.getClientRects()].find(rect => rect.width >= 1 && rect.height >= 1);
    if (!box) throw new Error("target_hidden: refresh snapshot");
    const left = Math.max(box.left, 0);
    const top = Math.max(box.top, 0);
    const right = Math.min(box.right, this.win.innerWidth - 1);
    const bottom = Math.min(box.bottom, this.win.innerHeight - 1);
    if (right < left || bottom < top) throw new Error("target_offscreen: scroll it into view first");
    const fractions = [[0.5 + (this.input.random() - 0.5) * 0.3, 0.5 + (this.input.random() - 0.5) * 0.3]];
    for (const fx of [0.5, 0.25, 0.75]) for (const fy of [0.5, 0.25, 0.75]) fractions.push([fx, fy]);
    for (const [fx, fy] of fractions) {
      const x = Math.round(left + (right - left) * fx);
      const y = Math.round(top + (bottom - top) * fy);
      if (this.hits(element, x, y)) return { x, y, size: Math.min(box.width, box.height) };
    }
    const root = element.getRootNode();
    const cover = (typeof root.elementFromPoint === "function" ? root : this.win.document).elementFromPoint(Math.round((left + right) / 2), Math.round((top + bottom) / 2));
    const label = cover ? cover.localName + (cover.id ? "#" + cover.id : "") + (typeof cover.className === "string" && cover.className.trim() ? "." + cover.className.trim().split(/\s+/).slice(0, 2).join(".") : "") : "nothing";
    throw new Error(`target_obscured: covered by ${label.slice(0, 120)}; close the overlay or pick the element on top`);
  }

  async pressElement(element) {
    let target = this.point(element);
    await this.input.move(target.x, target.y, target.size);
    if (!this.hits(element, target.x, target.y)) {
      target = this.point(element);
      await this.input.move(target.x, target.y, target.size);
    }
    await this.input.press(target.x, target.y);
    return target;
  }

  async act(action, args) {
    const win = this.win;
    if (action === "click" && (args.x !== undefined || args.y !== undefined)) {
      if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.y < 0 || args.x >= win.innerWidth || args.y >= win.innerHeight) throw new Error("invalid_coordinates: use viewport CSS pixels in the selected frame");
      if (["id", "selector", "role", "name", "label", "text", "scope", "exact"].some(key => args[key] !== undefined)) throw new Error("ambiguous_locator: coordinates cannot be combined with an element locator");
      const target = win.document.elementFromPoint(args.x, args.y);
      if (!target) throw new Error("target_not_found");
      if (target.matches("iframe,frame")) throw new Error("frame_target: choose that frameId before coordinate clicking");
      if (typeof win.synthesizeMouseEvent !== "function") throw new Error("coordinate_input_unavailable");
      await this.input.click(args.x, args.y);
      return { ok: true, clicked: true, coordinateSpace: "frame-viewport-css", x: args.x, y: args.y };
    }
    if (action === "scroll" && !["id", "selector", "role", "name", "label", "text"].some(key => args[key] !== undefined)) {
      if (args.toBottom) win.scrollTo(0, win.document.documentElement.scrollHeight);
      else if (args.toTop) win.scrollTo(0, 0);
      else win.scrollBy(Number(args.dx) || 0, args.dy === undefined ? Math.round(win.innerHeight * 0.8) : Number(args.dy) || 0);
      return { ok: true, y: win.scrollY };
    }
    const locator = { ...args };
    if (action === "type") delete locator.text;
    const element = args.legacy ? this.resolveLegacy(locator, action) : this.resolve(locator);
    if (args.legacy ? !element.getClientRects().length : !this.visible(element)) throw new Error("target_hidden: refresh snapshot");
    if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") throw new Error("target_disabled");
    element.scrollIntoView({ block: "center", inline: "center" });
    if (action === "click") {
      const { x, y } = await this.pressElement(element);
      return { ok: true, clicked: true, tag: element.localName, x, y, ...(args.legacy ? { text: clean(element.innerText || element.value || element.textContent).slice(0, 80) } : {}) };
    }
    if (action === "scroll") return { ok: true, scrolled: true };
    if (action !== "type") throw new Error("unsupported_action");
    const input = element.localName === "input";
    if (!(input || element.localName === "textarea") || element.readOnly || (input && ["file", "button", "submit", "reset", "checkbox", "radio", "hidden"].includes(element.type))) throw new Error("target_not_editable");
    if (typeof args.text !== "string") throw new Error("text_required");
    const characters = [...args.text];
    if (characters.length > MAX_TYPED) throw new Error(`text_too_long: page_type types at most ${MAX_TYPED} characters; set longer values with page_eval`);
    const requested = args.delayMs === undefined ? 60 : clamp(Math.floor(Number(args.delayMs) || 0), 0, 500);
    const delayMs = Math.min(requested, Math.floor(TYPING_BUDGET_MS / Math.max(1, characters.length)));
    if (element.getRootNode().activeElement !== element) {
      try {
        await this.pressElement(element);
      } catch (error) {
        if (!/^target_obscured/.test(error.message)) throw error;
      }
    }
    if (element.getRootNode().activeElement !== element) element.focus();
    element.select();
    if (characters.length) await this.input.type(args.text, { delayMs, multiline: !input });
    else await this.input.key("Backspace");
    const expected = input ? args.text.replace(/[\r\n]/g, "") : args.text.replace(/\r/g, "");
    const valueMatches = element.value === expected;
    if (args.submit) await this.input.key("Enter");
    return { ok: true, filled: true, length: characters.length, valueMatches, submitted: !!args.submit };
  }
}
