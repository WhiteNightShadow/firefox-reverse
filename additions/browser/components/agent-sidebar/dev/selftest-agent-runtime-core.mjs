import { AgentRuntimeCore } from "../modules/AgentRuntimeCore.sys.mjs";

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) {
    pass++;
    console.log("OK  ", name);
  } else {
    fail++;
    console.error("FAIL", name);
  }
}

let now = 100;
let pendingTimer = null;
const core = new AgentRuntimeCore({
  now: () => now,
  setTimeout: callback => {
    pendingTimer = callback;
    return 1;
  },
  clearTimeout: () => {
    pendingTimer = null;
  },
});

const state = core.beginRun("thread-1", {
  usage: { requests: 0 },
  contextStrategy: "projected",
});
check("beginRun creates a running state", state.running && !state.settled);
check("re-entry is rejected", core.beginRun("thread-1") === null);

const snapshots = [];
const unsubscribe = core.subscribe("thread-1", snapshot => snapshots.push(snapshot));
core.pushDelta(state, "hello");
core.pushDelta(state, " world");
core.pushReasoning(state, "thinking");
core.applyEvent(state, { type: "tool_call", id: "c1", name: "page_info" });
core.applyEvent(state, {
  type: "tool_result",
  id: "c1",
  env: {
    ok: true,
    data: { count: 2 },
    media: [{ type: "image", dataUrl: "data:image/png;base64,AA==" }],
  },
});
core.notify(state);
const current = core.getState("thread-1");
check("stream text is reduced into one step", current.steps[0].text === "hello world");
check("reasoning is tracked separately", current.steps[1].kind === "think");
check("tool result and media are reduced", current.steps[2].status === "ok" && current.steps[2].images.length === 1);
check("subscribers receive snapshots", snapshots.length >= 2);

let confirmation = null;
state.pendingConfirm = {
  id: "confirm-1",
  name: "page_eval",
  args: {},
  resolve: value => {
    confirmation = value;
  },
};
check("confirmation is resolved by the core", core.respondConfirm("thread-1", "confirm-1", true, true));
check("approve-all is retained for the run", confirmation === true && state.approveAll === true);

const controller = new AbortController();
state.abort = controller;
check("abortThread reports an active cancellation", core.abortThread("thread-1"));
check("abort signal and state are updated", controller.signal.aborted && state.aborted);

core.settle(state);
check("settle publishes a terminal state", !state.running && state.settled && state.abort === null);
unsubscribe();

now += 1;
core.notifyThrottled(state);
check("throttled notifications use the injected timer", typeof pendingTimer === "function");

console.log(`\nAgentRuntimeCore selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
