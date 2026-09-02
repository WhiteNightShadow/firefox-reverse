/* dev/selftest-config.mjs — Node 下验证 ConfigStore 内存 backend 的存取逻辑。
 *   node dev/selftest-config.mjs
 * 不随 omni.ja 打包。
 */
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import {
  normalizeReasoningEffort,
  REASONING_EFFORT_VALUES,
} from "../modules/ReasoningEffort.sys.mjs";

const cs = new ConfigStore();
let fail = 0;

function check(name, got, want) {
  const ok = got === want;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`
  );
  if (!ok) {
    fail++;
  }
}

console.log("isPersistent:", cs.isPersistent, "(Node 下应为 false → 内存 backend)\n");

check("默认 activeProvider", cs.getActiveProvider(), "deepseek");
cs.setActiveProvider("openai");
check("set/get activeProvider", cs.getActiveProvider(), "openai");

check("默认 apiKey 为空", cs.getApiKey("deepseek"), "");
cs.setApiKey("deepseek", "sk-test-123");
check("set/get apiKey", cs.getApiKey("deepseek"), "sk-test-123");
cs.clearApiKey("deepseek");
check("clear apiKey", cs.getApiKey("deepseek"), "");

check("默认 model 为空", cs.getModel("deepseek"), "");
cs.setModel("deepseek", "deepseek-reasoner");
check("set/get model", cs.getModel("deepseek"), "deepseek-reasoner");

check("默认 custom reasoning effort", cs.getCustomReasoningEffort(), "auto");
cs.setCustomReasoningEffort("HIGH");
check("custom reasoning effort 规范化", cs.getCustomReasoningEffort(), "high");
cs.setCustomReasoningEffort("unsupported-level");
check("无效 custom reasoning effort 回退 auto", cs.getCustomReasoningEffort(), "auto");
check("reasoning effort 支持 max", REASONING_EFFORT_VALUES.includes("max"), true);
check("normalize 可用自定义 fallback", normalizeReasoningEffort("bad", "medium"), "medium");

check("默认启用 Provider 提示缓存", cs.getPromptCacheMode(), "auto");
cs.setPromptCacheMode("off");
check("提示缓存可关闭", cs.getPromptCacheMode(), "off");
cs.setPromptCacheTtl("1h");
check("缓存 TTL 持久化", cs.getPromptCacheTtl(), "1h");
check("默认使用持久化上下文投影", cs.getContextStrategy(), "projected");
cs.setContextStrategy("legacy");
check("上下文策略可一键回退旧模式", cs.getContextStrategy(), "legacy");

const migrated = cs.listModelProfiles();
check("旧配置自动迁移成一条命名配置", migrated.length, 1);
const accountA = cs.updateModelProfile(migrated[0].id, {
  name: "GPT 渠道账号 A",
  provider: "custom",
  apiKey: "sk-account-a",
  baseUrl: "https://gateway.example.com/v1",
  protocol: "openai",
  model: "gpt-test",
  reasoningEffort: "high",
});
cs.setActiveModelProfileId(accountA.id);
const accountB = cs.createModelProfile({
  name: "GPT 渠道账号 B",
  provider: "custom",
  apiKey: "sk-account-b",
  baseUrl: "https://gateway.example.com/v1",
  protocol: "openai",
  model: "gpt-test",
});
check("同渠道可保存多账号", cs.listModelProfiles().length, 2);
check("新建配置自动选中", cs.getActiveModelProfileId(), accountB.id);
check("当前配置读取账号 B Key", cs.getApiKey("custom"), "sk-account-b");
cs.setActiveModelProfileId(accountA.id);
check("历史配置切回账号 A", cs.getApiKey("custom"), "sk-account-a");
const copy = cs.duplicateModelProfile(accountA.id);
check("复制配置生成独立 id", copy.id === accountA.id, false);
cs.deleteModelProfile(copy.id);
check("删除复制项不影响原配置", cs.listModelProfiles().length, 2);

const oldPrefs = new Map([
  ["extensions.firefox-reverse.agent.activeProvider", "deepseek"],
  ["extensions.firefox-reverse.agent.key.deepseek", "legacy-deepseek"],
  ["extensions.firefox-reverse.agent.model.deepseek", "deepseek-v4-flash"],
  ["extensions.firefox-reverse.agent.key.custom", "legacy-custom"],
  ["extensions.firefox-reverse.agent.model.custom", "gpt-legacy"],
  ["extensions.firefox-reverse.agent.custom.baseUrl", "https://legacy.example.com/v1"],
]);
const migrationStore = new ConfigStore({
  persistent: false,
  getString: (key, def = "") => oldPrefs.has(key) ? oldPrefs.get(key) : def,
  setString: (key, value) => void oldPrefs.set(key, value),
  clear: key => void oldPrefs.delete(key),
});
const migratedAll = migrationStore.listModelProfiles();
check("迁移当前渠道和其它已保存渠道", migratedAll.length, 2);
check("迁移保留其它渠道 Key", migratedAll.find(p => p.provider === "custom")?.apiKey, "legacy-custom");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
