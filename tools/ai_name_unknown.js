#!/usr/bin/env node
/* ===========================================================================
 * ai_name_unknown.js —— 用 LLM 给 dispatcher_split.js 没识别出的 UNKNOWN
 *                       JSVMP opcode handler 自动命名（通用，不针对任何站点）。
 *
 * 流程: 读 handlers.json → 取 UNKNOWN handler 源码 → 拿【已命名】handler 做 few-shot
 *       → 批量喂 LLM → 解析 → 把 llm_name/llm_reason 合并回 JSON。
 *
 * 配置（与 Agent 侧边栏共用 settings/agent.json，复用 openai 协议）:
 *   优先 settings/agent.json，回退 settings/agent.example.json 结构。
 *   api_key 解析顺序: --api-key > 配置文件 > 环境变量(DEEPSEEK_API_KEY/OPENAI_API_KEY/JSVMP_LLM_API_KEY)
 *
 * 用法:
 *   node ai_name_unknown.js <handlers.json> [选项]
 *     --provider=deepseek|openai|custom   覆盖 active_provider
 *     --model=deepseek-chat               覆盖模型
 *     --batch=8                           每次请求多少个 handler（默认 8）
 *     --limit=N                           最多命名前 N 个 UNKNOWN（默认 全部）
 *     --apply                             把 llm_name 写回 inferred_name（标 source=llm）
 *     --out=file                          输出文件（默认 原地覆盖 handlers.json）
 *     --dry-run                           只打印将发送的 prompt，不调用 API
 *     --api-key=KEY / --base-url=URL      直接指定
 * =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

// --------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { batch: 8, limit: Infinity };
  for (const a of argv) {
    if (a.startsWith('--provider=')) o.provider = a.slice(11);
    else if (a.startsWith('--model=')) o.model = a.slice(8);
    else if (a.startsWith('--batch=')) o.batch = parseInt(a.slice(8), 10);
    else if (a.startsWith('--limit=')) o.limit = parseInt(a.slice(8), 10);
    else if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--api-key=')) o.apiKey = a.slice(10);
    else if (a.startsWith('--base-url=')) o.baseUrl = a.slice(11);
    else if (!a.startsWith('--') && !o.handlers) o.handlers = a;
  }
  return o;
}

// 读取 settings/agent(.example).json，解析出 {baseUrl, chatPath, apiKey, model}
function loadLlmConfig(opts) {
  const settingsDir = path.resolve(__dirname, '..', 'settings');
  let cfg = null;
  for (const name of ['agent.json', 'agent.example.json']) {
    const p = path.join(settingsDir, name);
    if (fs.existsSync(p)) { try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (_) {} }
  }
  const provName = opts.provider || (cfg && cfg.active_provider) || 'deepseek';
  const prov = (cfg && cfg.providers && cfg.providers[provName]) || {};
  const envKey = process.env.JSVMP_LLM_API_KEY
    || process.env[(provName.toUpperCase()) + '_API_KEY']
    || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  return {
    provider: provName,
    baseUrl: opts.baseUrl || prov.base_url || 'https://api.deepseek.com',
    chatPath: prov.chat_path || '/v1/chat/completions',
    apiKey: opts.apiKey || prov.api_key || envKey || '',
    model: opts.model || prov.default_model || 'deepseek-chat',
  };
}

// --------------------------------------------------------------------------
// Prompt 构建：few-shot(已命名) + 待命名批次
function buildMessages(fewshot, batch) {
  const sys = [
    'You are an expert at reverse-engineering JSVMP (JavaScript VM-protection) bytecode.',
    'You are given handler bodies of a virtual machine dispatcher. Registers are ALREADY normalized:',
    '  stack = operand stack, sp = stack pointer, pc = program counter,',
    '  bytecode = bytecode stream, consts = constant pool, thisArg = `this`.',
    'For each handler, output a SHORT UPPERCASE opcode mnemonic (e.g. PUSH_CONST, ADD, SUB,',
    'GET_PROP, SET_PROP, CALL_FUNCTION, JUMP, JUMP_IF_FALSE, NEW_OBJECT, STRING_XOR_DECODE,',
    'RETURN, TYPEOF, BUILD_ARRAY) plus a one-line reason. Be consistent with the examples.',
    'Respond with ONLY a JSON array, no markdown: [{"op_key":"...","name":"...","reason":"...","confidence":0.0-1.0}]',
  ].join('\n');

  let fs1 = 'Known handlers (naming style reference):\n';
  for (const f of fewshot) fs1 += `  ${f.name}: ${f.source.replace(/\s+/g, ' ').slice(0, 120)}\n`;

  const items = batch.map(b => ({ op_key: String(b.op_key), source: b.source.replace(/\s+/g, ' ').slice(0, 800) }));
  const usr = fs1 + '\nName these UNKNOWN handlers (return JSON array):\n' + JSON.stringify(items, null, 2);

  return [{ role: 'system', content: sys }, { role: 'user', content: usr }];
}

// 从 LLM 回复中抽出 JSON 数组（容忍 ```json fenced / 前后噪声）
function parseLlmJson(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const lb = s.indexOf('['), rb = s.lastIndexOf(']');
  if (lb >= 0 && rb > lb) s = s.slice(lb, rb + 1);
  try { return JSON.parse(s); } catch (_) { return null; }
}

async function callLlm(cfg, messages) {
  const url = cfg.baseUrl.replace(/\/$/, '') + cfg.chatPath;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, stream: false }),
  });
  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}

// --------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.handlers) {
    console.error('用法: node ai_name_unknown.js <handlers.json> [--provider=] [--model=] [--batch=8] [--limit=N] [--apply] [--out=] [--dry-run]');
    process.exit(2);
  }
  const H = JSON.parse(fs.readFileSync(opts.handlers, 'utf8'));
  const handlers = H.handlers || {};
  const entries = Object.entries(handlers);
  const known = entries.filter(([, v]) => v.inferred_name && v.inferred_name !== 'UNKNOWN');
  let unknown = entries.filter(([, v]) => v.inferred_name === 'UNKNOWN').map(([k, v]) => ({ op_key: k, source: v.source || '' }));
  if (Number.isFinite(opts.limit)) unknown = unknown.slice(0, opts.limit);

  console.error(`[*] ${opts.handlers}: ${known.length} 已命名, ${unknown.length} 待 LLM 命名 (batch=${opts.batch})`);
  if (unknown.length === 0) { console.error('[*] 无 UNKNOWN，无需命名'); return; }

  // few-shot: 取若干风格多样的已命名 handler
  const fewshot = known.slice(0, 12).map(([, v]) => ({ name: v.inferred_name, source: v.source || '' }));

  const cfg = loadLlmConfig(opts);
  console.error(`[*] provider=${cfg.provider} model=${cfg.model} base=${cfg.baseUrl} key=${cfg.apiKey ? '已配置' : '(空)'}`);

  // 分批
  const batches = [];
  for (let i = 0; i < unknown.length; i += opts.batch) batches.push(unknown.slice(i, i + opts.batch));

  if (opts.dryRun) {
    const msgs = buildMessages(fewshot, batches[0]);
    console.error(`\n[dry-run] 共 ${batches.length} 批，下面是第 1 批 prompt:\n`);
    console.log('--- SYSTEM ---\n' + msgs[0].content);
    console.log('\n--- USER ---\n' + msgs[1].content);
    console.error(`\n[dry-run] 未调用 API。去掉 --dry-run 并配置 api_key 即可真实命名。`);
    return;
  }
  if (!cfg.apiKey) { console.error('FATAL: 未配置 api_key（settings/agent.json 或环境变量 DEEPSEEK_API_KEY），用 --dry-run 可先看 prompt'); process.exit(1); }

  const results = {};
  for (let bi = 0; bi < batches.length; bi++) {
    const msgs = buildMessages(fewshot, batches[bi]);
    process.stderr.write(`[*] 批 ${bi + 1}/${batches.length} (${batches[bi].length} 个) ... `);
    try {
      const content = await callLlm(cfg, msgs);
      const arr = parseLlmJson(content);
      if (!arr) { console.error('解析失败，跳过'); continue; }
      let n = 0;
      for (const r of arr) {
        if (r && r.op_key != null && r.name) { results[String(r.op_key)] = r; n++; }
      }
      console.error(`得到 ${n} 个命名`);
    } catch (e) { console.error('错误: ' + e.message); }
  }

  // 合并
  let applied = 0;
  for (const [k, r] of Object.entries(results)) {
    if (!handlers[k]) continue;
    handlers[k].llm_name = r.name;
    handlers[k].llm_reason = r.reason || '';
    handlers[k].llm_confidence = r.confidence != null ? r.confidence : null;
    if (opts.apply && handlers[k].inferred_name === 'UNKNOWN') {
      handlers[k].inferred_name = r.name;
      handlers[k].name_source = 'llm';
      applied++;
    }
  }
  if (H._meta) {
    H._meta.llm_named = Object.keys(results).length;
    if (opts.apply) {
      const total = Object.keys(handlers).length;
      const named = Object.values(handlers).filter(v => v.inferred_name && v.inferred_name !== 'UNKNOWN').length;
      H._meta.identified = named;
      H._meta.identified_pct = (100 * named / total).toFixed(1) + '%';
    }
  }

  const outFile = opts.out || opts.handlers;
  fs.writeFileSync(outFile, JSON.stringify(H, null, 2));
  console.error(`[*] LLM 命名 ${Object.keys(results).length} 个${opts.apply ? `，应用 ${applied} 个到 inferred_name` : '（仅写 llm_name，未 --apply）'} → ${outFile}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
