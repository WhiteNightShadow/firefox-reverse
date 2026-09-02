import {
  buildProjectionInput,
  chooseProjectionCutoff,
  messagesSize,
  normalizeContextProjection,
  planContextProjection,
  projectMessages,
} from "../modules/ContextProjection.sys.mjs";

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass++;
    console.log("  ✓", message);
  } else {
    fail++;
    console.error("  ✗ FAIL:", message);
  }
};

const messages = [];
for (let i = 0; i < 30; i++) {
  messages.push({ role: i % 2 ? "assistant" : "user", content: `${i}:` + "x".repeat(4000) });
}

const cutoff = chooseProjectionCutoff(messages, { keepRecentChars: 18000, minRecentMessages: 6 });
ok(Number.isInteger(cutoff) && cutoff > 0 && messages[cutoff].role === "user", "cutoff is a safe user boundary");

const plan = planContextProjection(messages, null, { triggerChars: 30000, keepRecentChars: 18000 });
ok(plan && plan.cutoff === cutoff, "oversized history produces a projection plan");

const projection = {
  version: 1,
  summary: "Goal and confirmed facts",
  cutoff,
  sourceCount: cutoff,
  createdAt: 1,
  updatedAt: 2,
  strategy: "projected",
};
const projected = projectMessages(messages, projection);
ok(projected[0].role === "user" && projected[1].role === "assistant", "projected history preserves task anchor then summary");
ok(projected[2].role === "user" && messagesSize(projected) < messagesSize(messages), "projected tail starts safely and is smaller");
ok(messages.length === 30 && messages[0].content.length > 3000, "full history remains untouched");

const nextPlan = { cutoff: cutoff + 2, previous: normalizeContextProjection(projection, messages.length) };
const input = buildProjectionInput(messages, nextPlan, { maxChars: 12000 });
ok(input.includes("Previous continuation record") && input.includes("New history to incorporate"), "incremental projection carries previous summary");
ok(input.length <= 12100, "projection source is bounded");

const corrupt = projectMessages(messages, { version: 1, cutoff: 999, summary: "bad" });
ok(corrupt.length === messages.length, "corrupt projection falls back to full history");
ok(planContextProjection(messages.slice(-4), null, { triggerChars: 1 }) === null, "too-short history is never projected");

const fiftyTurns = [];
for (let i = 0; i < 100; i++) {
  fiftyTurns.push({ role: i % 2 ? "assistant" : "user", content: "z".repeat(3000) });
}
const fiftyPlan = planContextProjection(fiftyTurns, null, { triggerChars: 60000, keepRecentChars: 24000 });
const fiftyProjected = projectMessages(fiftyTurns, {
  version: 1,
  summary: "bounded summary",
  cutoff: fiftyPlan.cutoff,
  sourceCount: fiftyPlan.cutoff,
  createdAt: 1,
  updatedAt: 1,
});
ok(messagesSize(fiftyProjected) < 40000, "50-turn projected input remains bounded");
ok(messagesSize(fiftyProjected) < messagesSize(fiftyTurns) / 5, "50-turn projection cuts real input by more than 80%");

console.log(`\nContext projection selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
