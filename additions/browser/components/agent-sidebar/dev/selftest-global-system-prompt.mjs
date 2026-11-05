import assert from "node:assert/strict";
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import { loadAgentSession } from "./agent-session-harness.mjs";

const store = new ConfigStore();
const calls = [];
let restart = false;
const session = await loadAgentSession({
  configStore: store,
  agentLoop: {
    createRunState: () => ({ calls: new Map() }),
    async runAgentTurn(options) {
      calls.push(options.systemPrompt);
      if (restart) {
        restart = false;
        store.setGlobalSystemPrompt("changed during running turn");
        return { content: "checkpoint", stopReason: "max_rounds", messages: [] };
      }
      return { content: "done", stopReason: "final", messages: [] };
    },
  },
});
const run = async (systemPrompt = "built-in policy") => {
  await session.run("test-thread", { systemPrompt, convo: [{ role: "user", content: "task" }] });
  assert.equal(session.getState("test-thread").error, null);
  assert.equal(session.getState("test-thread").settled, true);
};

await run();
assert.equal(calls.at(-1), "built-in policy", "Empty setting preserves built-in prompt");
store.setGlobalSystemPrompt("  Reply in Chinese.\nKeep English technical terms.  ");
await run();
assert.equal(calls.at(-1), "built-in policy\n\nReply in Chinese.\nKeep English technical terms.");
await run("");
assert.equal(calls.at(-1), "Reply in Chinese.\nKeep English technical terms.");

restart = true;
await run();
assert.equal(calls.at(-2), calls.at(-1), "Automatic restart keeps the same prompt snapshot");
assert.equal(calls.at(-1).split("Reply in Chinese.").length, 2, "Automatic restart does not append twice");
await run();
assert.equal(calls.at(-1), "built-in policy\n\nchanged during running turn", "Next user turn reads latest setting");
store.setGlobalSystemPrompt(" \n\t ");
await run();
assert.equal(calls.at(-1), "built-in policy", "Whitespace-only setting restores built-in prompt");
store.setGlobalSystemPrompt("");
await run();
assert.equal(calls.at(-1), "built-in policy", "Clearing the setting removes custom instructions");
console.log("Global system prompt: default, append, reload, clear and automatic restart passed");
