/* dev/selftest-config.mjs — Node 下验证 ConfigStore 内存 backend 的存取逻辑。
 *   node dev/selftest-config.mjs
 * 不随 omni.ja 打包。
 */
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";

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

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
