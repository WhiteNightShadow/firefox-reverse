#!/usr/bin/env node
/* wasm_disasm.cjs — 用 wabt 把 .wasm 反汇编成 WAT（可读文本格式），落盘 + 回摘要。
 * 通用、站点无关。需工作目录装了 wabt（后端会自动 npm_install）。
 * 用法: node wasm_disasm.cjs <config.json>
 * config: { wasmPath, out, outRel?, func? }  func=导出名或函数索引 → 只抽该函数的 WAT 段
 * 输出: __WASM_DISASM_JSON__{ok,watPath,watLines,funcCount,exportCount,importCount,exports[],imports[],func?}
 */
const fs = require('fs');

function extractFunc(wat, idx) {
  const m = new RegExp('\\(func \\(;' + idx + ';\\)').exec(wat);
  if (!m) return null;
  let depth = 0, started = false;
  for (let j = m.index; j < wat.length; j++) {
    const c = wat[j];
    if (c === '(') { depth++; started = true; }
    else if (c === ')') { depth--; if (started && depth === 0) return wat.slice(m.index, j + 1); }
  }
  return wat.slice(m.index, m.index + 8000);
}

(async () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const wabt = await require('wabt')();
    const bytes = fs.readFileSync(cfg.wasmPath);
    const mod = wabt.readWasm(bytes, { readDebugNames: true });
    try { mod.applyNames(); } catch {}
    const wat = mod.toText({ foldExprs: false, inlineExport: false });
    fs.writeFileSync(cfg.out, wat);
    const exports = [];
    for (const m of wat.matchAll(/\(export "([^"]+)" \(func (\d+)\)\)/g)) exports.push({ name: m[1], func: +m[2] });
    const imports = [];
    for (const m of wat.matchAll(/\(import "([^"]*)" "([^"]*)"/g)) imports.push(m[1] + '.' + m[2]);
    const displayPath = cfg.outRel || cfg.out;
    const result = {
      ok: true,
      watPath: displayPath,
      watLines: wat.split('\n').length,
      funcCount: (wat.match(/\(func /g) || []).length,
      exportCount: exports.length,
      importCount: imports.length,
      exports: exports.slice(0, 80),
      imports: imports.slice(0, 80),
      note: '完整 WAT 已落盘。要看某函数：wasm_disasm(func=导出名或索引) 抽该段（另存独立文件，不塞进对话），或 fs_read(offset/limit)/code_search 在 .wat 里查。',
    };
    if (cfg.func != null && String(cfg.func) !== '') {
      let idx = /^\d+$/.test(String(cfg.func)) ? +cfg.func : (exports.find(e => e.name === cfg.func) || {}).func;
      if (idx != null) {
        const body = extractFunc(wat, idx);
        // ⚠ func.wat 最大 8000 字 ≈ TOOL_RESULT_CAP，加上 exports/imports 会超限被截断，LLM 收到残缺
        //   JSON → 超长思考 → 300s 超时。修法：另存独立 .func<N>.wat，只回摘要+路径+开头预览；
        //   模型用 fs_read(offset/limit) 或 code_search 按需读取片段。
        const funcOut = cfg.out.replace(/\.wat$/, '') + '.func' + idx + '.wat';
        const funcOutRel = displayPath.replace(/\.wat$/, '') + '.func' + idx + '.wat';
        if (body) { try { fs.writeFileSync(funcOut, body); } catch {} }
        result.func = {
          index: idx,
          query: cfg.func,
          funcPath: funcOutRel,            // 完整函数 WAT 独立文件路径
          lines: body ? body.split('\n').length : 0,
          // 只回前 600 字符预览，其余 fs_read(path, offset/limit) 切片读
          preview: body
            ? (body.slice(0, 600) + (body.length > 600 ? '\n…（已截断，完整见 funcPath，用 fs_read(path,offset,limit) 切片读）' : ''))
            : '(未在 WAT 里找到该 func 段)',
        };
        // func 已展示，摘要模式减少 exports/imports 条目（第一次调用已拿到完整列表）
        result.exports = exports.slice(0, 10);
        result.imports = imports.slice(0, 10);
        result.note = `函数 WAT 已另存至 ${funcOutRel}（${result.func.lines} 行）。` +
          'preview 是前 600 字；用 fs_read(path, offset, limit) 按偏移切片读，或 code_search("关键指令名", path) 定位特定模式。' +
          '**不要整读进对话**（几百行 WAT 超 token 上限会超时）。';
      } else {
        result.func = { error: '无法解析 func=' + cfg.func + '（用 exports 里的导出名或函数索引）' };
      }
    }
    console.log('__WASM_DISASM_JSON__' + JSON.stringify(result));
  } catch (e) {
    console.log('__WASM_DISASM_JSON__' + JSON.stringify({ ok: false, error: String(e && e.stack || e) }));
  }
})();
