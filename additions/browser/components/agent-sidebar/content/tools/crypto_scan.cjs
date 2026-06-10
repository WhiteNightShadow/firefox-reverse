#!/usr/bin/env node
/* crypto_scan.cjs — 通用密码学指纹扫描器（站点无关、零三方依赖、纯分析无副作用）。
 *
 * 目标：给一段数据/源码，自动识别用了哪些加密原语，省去人工暴力扫常量。
 * 识别的全是**公开标准常量/结构特征**，对所有站点一视同仁——绝不硬编码任何单站点的逻辑/表/字段。
 *
 * 输入(CLI 或 导出函数 scan(input, opts))：
 *   - hex 字符串（如 "56544b42..."）
 *   - 字节数组（[108,71,200,...] 或 Uint8Array）
 *   - utf8 字符串 / JS 源码文本
 *   - 文件路径（CLI: 第一个参数；--file=PATH）；JSON 数组文件也按字节解释
 * 同一输入按**多种解释**并行扫描：
 *   - 若像 hex → 解出 bytes 再扫
 *   - 原始 bytes（数组/Buffer/把 utf8 当 latin1 字节）
 *   - JS 源码里的数字字面量（0x.. 十六进制 + 十进制），凑成"逻辑常量集合"扫 IV/K/delta
 *   - 文本里的 64 字符字母表 → base64 表比对
 *
 * 输出 JSON：{ ok, interpretations:[...], findings:[{primitive, evidence, offsetOrLocation, confidence}] }
 *
 * 用法：
 *   node crypto_scan.cjs <文件路径|hex字符串|'[1,2,3]'>
 *   node crypto_scan.cjs --file=path/to/data
 *   node crypto_scan.cjs --str='var T="...64个字符的字母表..."'  # 直接把参数当字符串/源码扫
 *   node crypto_scan.cjs                              # 无参 → 跑内置自检示例
 */
'use strict';
const fs = require('fs');

/* ============================ 公开标准常量库（全部可公开查证，非站点特定） ============================ */

// TEA/XTEA/XXTEA magic delta = floor(2^32 / 黄金比例)
const DELTA = 0x9e3779b9; // =2654435769；有符号 = -1640531527

// MD5 初始 IV（小端魔数）
const MD5_IV = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
// MD5 64 个正弦常量 K[i] = floor(abs(sin(i+1)) * 2^32)（取前若干 + 几个特征值做命中提示）
const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
];

// SHA-1 IV（含特征尾 0xc3d2e1f0）+ 4 个轮常量 K
const SHA1_IV = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
const SHA1_K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

// SHA-256 IV（前 8 个素数平方根小数部分）+ K 表头
const SHA256_IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
];

// 国密 SM3 IV
const SM3_IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];
// 国密 SM4 系统参数 FK + CK 表头（用于密钥扩展），SM4 S-box 头
const SM4_FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc];
const SM4_CK0 = [0x00070e15, 0x1c232a31, 0x383f464d, 0x545b6269];
const SM4_SBOX_HEAD = [0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7];

// AES 标准 S-box 头 + Te0 表头（用于查表实现）
const AES_SBOX_HEAD = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5];
const AES_TE0_HEAD = [0xc66363a5, 0xf87c7c84, 0xee777799, 0xf67b7b8d]; // 经典 4KB 查表实现 Te0[0..]

// CRC32 反射多项式
const CRC32_POLY = 0xedb88320;

// 标准 base64 / base64url 字母表
const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/* ============================ 输入归一化：把各种输入摊成多种"解释" ============================ */

// 判断字符串是否像纯 hex（偶数长、只含 hex 字符、长度够）
function looksLikeHex(s) {
  const t = s.replace(/\s+/g, '');
  return t.length >= 8 && t.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(t);
}
function hexToBytes(s) {
  const t = s.replace(/\s+/g, '');
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
  return out;
}
// 把 utf8/latin1 字符串当字节序列（用 latin1 保留 0..255 原值）
function strToBytes(s) {
  return Uint8Array.from(Buffer.from(s, 'latin1'));
}

// 从 JS 源码/文本里抽取所有数字字面量（0x..、十进制、含负号），转成无符号 32 位集合
function extractLiterals(text) {
  const set = new Set();
  const push = (n) => {
    if (!Number.isFinite(n)) return;
    // 归一化到无符号 32 位（处理有符号写法，如 -1640531527 → 0x9e3779b9）
    const u = (n >>> 0);
    set.add(u);
    set.add(n >>> 0);
    // 也保留 64 位低 32 位（应对超 32 位字面量，少见）
    if (n > 0xffffffff) set.add((n % 0x100000000) >>> 0);
  };
  // 0x 十六进制
  let m;
  const reHex = /0[xX]([0-9a-fA-F]+)/g;
  while ((m = reHex.exec(text))) { const n = parseInt(m[1], 16); if (Number.isFinite(n)) push(n); }
  // 十进制（含负号），排除明显的浮点小数尾
  const reDec = /-?\b\d{2,}\b/g;
  while ((m = reDec.exec(text))) { const n = parseInt(m[0], 10); if (Number.isFinite(n) && Math.abs(n) <= 0xffffffff) push(n); }
  return set;
}

/* ============================ 字节序列上的指纹检测 ============================ */

// 在字节流里读 32 位（LE / BE）
function rd32(bytes, off, le) {
  if (off + 4 > bytes.length) return null;
  if (le) return ((bytes[off]) | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | (bytes[off + 3])) >>> 0;
}

// 在字节流里找一个 32 位常量（LE 和 BE 都试），返回首个命中的 {offset, endian} 或 null
function findU32(bytes, target, opts) {
  opts = opts || {};
  for (let off = 0; off + 4 <= bytes.length; off++) {
    if (opts.le !== false && rd32(bytes, off, true) === (target >>> 0)) return { offset: off, endian: 'LE' };
    if (opts.be !== false && rd32(bytes, off, false) === (target >>> 0)) return { offset: off, endian: 'BE' };
  }
  return null;
}

// 在字节流里找一段连续字节序列（用于 S-box 头），返回首个命中 offset 或 -1
function findByteSeq(bytes, seq) {
  outer: for (let off = 0; off + seq.length <= bytes.length; off++) {
    for (let i = 0; i < seq.length; i++) if (bytes[off + i] !== seq[i]) continue outer;
    return off;
  }
  return -1;
}

// 滑窗找连续 256 字节是 0..255 的全排列（RC4 / 类 RC4 S-box）
function findPermutation256(bytes) {
  const N = 256;
  if (bytes.length < N) return null;
  for (let off = 0; off + N <= bytes.length; off++) {
    const seen = new Uint8Array(256);
    let ok = true;
    for (let i = 0; i < N; i++) {
      const v = bytes[off + i];
      if (seen[v]) { ok = false; break; }
      seen[v] = 1;
    }
    if (ok) {
      // 是否恒等排列（0,1,2,...255）——刚初始化未经 KSA 的 RC4 也算特征，但标注一下
      let identity = true;
      for (let i = 0; i < N; i++) if (bytes[off + i] !== i) { identity = false; break; }
      return { offset: off, identity };
    }
  }
  return null;
}

// 在一组 32 位常量里，统计某常量数组有多少个命中（用于 IV/K 表）
function countHits(u32set, consts) {
  const hit = [];
  for (const c of consts) if (u32set.has(c >>> 0)) hit.push('0x' + (c >>> 0).toString(16).padStart(8, '0'));
  return hit;
}

// 把字节流的所有对齐 32 位值收成 set（LE+BE），供常量集合比对（IV/K 表在字节里通常对齐存放，
// 但为稳妥也做无对齐扫描时改用 findU32；这里集合法用于"命中计数"判断 IV/K 表整体存在）
function bytesToU32SetScan(bytes) {
  const set = new Set();
  for (let off = 0; off + 4 <= bytes.length; off++) {
    set.add(rd32(bytes, off, true));
    set.add(rd32(bytes, off, false));
  }
  return set;
}

/* ============================ base64 字母表检测 ============================ */

// 从文本里找所有长度 64 且 64 字符互不相同的候选字母表（base64 自定义表特征）
function findBase64Alphabets(text) {
  const out = [];
  const seen = new Set();        // 已收的核心 64 串去重
  const charsetSeen = new Set(); // 已收字母表的字符集合签名 → 抑制"同集合不同窗口"的滑窗近似重复
  // base64 字母表常见字符集合：字母数字 + 两个符号（+/ 或 -_ 或自定义）
  const re = /[A-Za-z0-9+/\-_=]{60,80}/g;
  let m;
  while ((m = re.exec(text))) {
    const s = m[0];
    // 优先取 start=0 的窗口（自定义表通常顶格写）。core 取前 64；若整段恰为 65 且末位是 padding('=')，
    // 末位被当 padding 自动剥掉。同一连续段内只产出一个候选，避免 [start=0,len=64] 与 [start=1,len=65] 重复。
    let picked = null;
    for (let len = 64; len <= 65 && len <= s.length && !picked; len++) {
      for (let start = 0; start + len <= s.length; start++) {
        const cand = s.substr(start, len);
        const core = cand.length === 65 ? cand.slice(0, 64) : cand; // 65 位时末位常是 padding 字符
        if (core.length !== 64) continue;
        if (new Set(core).size !== 64) continue; // 64 字符必须互异
        picked = { alphabet: core, full: cand, location: m.index + start };
        break;
      }
    }
    if (!picked) continue;
    if (seen.has(picked.alphabet)) continue;
    const sig = Array.from(new Set(picked.alphabet)).sort().join(''); // 字符集合签名
    if (charsetSeen.has(sig)) continue; // 同一字符集合在同段内的滑窗变体只留一个
    seen.add(picked.alphabet); charsetSeen.add(sig);
    out.push(picked);
  }
  return out;
}

function classifyBase64(alpha) {
  if (alpha === B64_STD) return { kind: 'standard base64 (RFC4648)', std: true };
  if (alpha === B64_URL) return { kind: 'standard base64url', std: true };
  // 与标准表同字符集但顺序被打乱 → 自定义置换表（典型的"魔改 base64"）
  const setA = new Set(alpha), setStd = new Set(B64_STD), setUrl = new Set(B64_URL);
  const sameAs = (other) => { if (setA.size !== other.size) return false; for (const c of setA) if (!other.has(c)) return false; return true; };
  if (sameAs(setStd)) return { kind: 'custom base64 alphabet (permuted standard charset +/)', std: false };
  if (sameAs(setUrl)) return { kind: 'custom base64 alphabet (permuted base64url charset -_)', std: false };
  return { kind: 'custom base64 alphabet (non-standard charset)', std: false };
}

/* ============================ 主扫描 ============================ */

// 对单个"字节解释"扫描所有字节型指纹
function scanBytes(bytes, label, findings) {
  if (!bytes || !bytes.length) return;
  const where = (off) => ({ interpretation: label, offset: off });

  // RC4 / 类 RC4 S-box：256 字节全排列
  const perm = findPermutation256(bytes);
  if (perm) {
    findings.push({
      primitive: perm.identity ? 'RC4/类RC4 S-box (256-permutation, 恒等初始态)' : 'RC4/类RC4 S-box (256-permutation)',
      evidence: perm.identity
        ? '连续 256 字节构成 0..255 全排列，且为恒等序列(0,1,..,255) — 可能是 KSA 前的初始 S 数组'
        : '连续 256 字节构成 0..255 的全排列(每值恰现一次) — RC4 类流密码 S-box 特征',
      offsetOrLocation: where(perm.offset),
      confidence: perm.identity ? 'medium' : 'high',
    });
  }

  // AES S-box / Te 表
  const aesSboxOff = findByteSeq(bytes, AES_SBOX_HEAD);
  if (aesSboxOff >= 0) findings.push({
    primitive: 'AES (S-box)',
    evidence: 'AES 标准 S-box 头 0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5',
    offsetOrLocation: where(aesSboxOff), confidence: 'high',
  });
  for (const tev of AES_TE0_HEAD) { const h = findU32(bytes, tev); if (h) { findings.push({
    primitive: 'AES (查表实现 Te0)',
    evidence: 'AES Te0 查表常量 0x' + (tev >>> 0).toString(16) + ' (' + h.endian + ')',
    offsetOrLocation: where(h.offset), confidence: 'high',
  }); break; } }

  // SM4 S-box / 参数
  const sm4SboxOff = findByteSeq(bytes, SM4_SBOX_HEAD);
  if (sm4SboxOff >= 0) findings.push({
    primitive: 'SM4 (国密, S-box)',
    evidence: 'SM4 标准 S-box 头 0xd6,0x90,0xe9,0xfe,0xcc,0xe1,0x3d,0xb7',
    offsetOrLocation: where(sm4SboxOff), confidence: 'high',
  });

  // CRC32 多项式（单常量命中）；附带粗判 256 项表（off+表头多项式式特征不易，仅用多项式命中）
  const crcHit = findU32(bytes, CRC32_POLY);
  if (crcHit) findings.push({
    primitive: 'CRC32',
    evidence: 'CRC32 反射多项式 0xedb88320 (' + crcHit.endian + ')',
    offsetOrLocation: where(crcHit.offset), confidence: 'medium',
  });

  // 32 位魔数类（TEA delta / 哈希 IV·K）：用字节流对齐扫描的 u32 集合做命中计数
  const u32set = bytesToU32SetScan(bytes);
  scanU32Set(u32set, label + ' (bytes→u32)', findings, bytes);
}

// 对一组 32 位常量集合扫描魔数型指纹（既用于字节流取出的 u32，也用于源码字面量）
function scanU32Set(u32set, label, findings, bytesForOffset) {
  const loc = (val) => {
    // 若有原始字节，给出 delta/常量在字节流里的 offset；否则仅标 interpretation
    if (bytesForOffset) { const h = findU32(bytesForOffset, val); if (h) return { interpretation: label, offset: h.offset, endian: h.endian }; }
    return { interpretation: label };
  };

  // TEA/XTEA/XXTEA delta
  if (u32set.has(DELTA >>> 0)) findings.push({
    primitive: 'TEA/XTEA/XXTEA',
    evidence: 'magic delta 0x9e3779b9 (=2654435769 / 有符号 -1640531527)',
    offsetOrLocation: loc(DELTA), confidence: 'high',
  });

  // MD5：IV 全中(4) 或 任一正弦 K 命中 → 提示
  const md5iv = countHits(u32set, MD5_IV);
  const md5k = countHits(u32set, MD5_K);
  if (md5iv.length === 4 || md5k.length >= 1) findings.push({
    primitive: 'MD5',
    evidence: 'IV 命中 ' + md5iv.length + '/4 [' + md5iv.join(',') + ']; 正弦常量 K 命中 ' + md5k.length + ' 个' + (md5k.length ? ' [' + md5k.slice(0, 4).join(',') + (md5k.length > 4 ? ',…' : '') + ']' : ''),
    offsetOrLocation: loc(MD5_IV[0]),
    confidence: (md5iv.length === 4 || md5k.length >= 2) ? 'high' : 'medium',
  });

  // SHA-1：IV(含特征尾 0xc3d2e1f0) + K
  const sha1iv = countHits(u32set, SHA1_IV);
  const sha1k = countHits(u32set, SHA1_K);
  const sha1tail = u32set.has(0xc3d2e1f0);
  if ((sha1iv.length >= 4 && sha1tail) || sha1k.length >= 2) findings.push({
    primitive: 'SHA-1',
    evidence: 'IV 命中 ' + sha1iv.length + '/5' + (sha1tail ? ' (含特征尾 0xc3d2e1f0)' : '') + '; 轮常量 K 命中 ' + sha1k.length + '/4' + (sha1k.length ? ' [' + sha1k.join(',') + ']' : ''),
    offsetOrLocation: loc(0xc3d2e1f0),
    confidence: (sha1tail && sha1k.length >= 1) ? 'high' : 'medium',
  });

  // SHA-256：IV + K 表头
  const sh256iv = countHits(u32set, SHA256_IV);
  const sh256k = countHits(u32set, SHA256_K);
  if (sh256iv.length >= 4 || sh256k.length >= 2) findings.push({
    primitive: 'SHA-256',
    evidence: 'IV 命中 ' + sh256iv.length + '/8 [' + sh256iv.slice(0, 4).join(',') + (sh256iv.length > 4 ? ',…' : '') + ']; K 表头命中 ' + sh256k.length + '/8',
    offsetOrLocation: loc(SHA256_IV[0]),
    confidence: (sh256iv.length >= 6 || (sh256iv.length >= 2 && sh256k.length >= 2)) ? 'high' : 'medium',
  });

  // SM3：IV
  const sm3iv = countHits(u32set, SM3_IV);
  if (sm3iv.length >= 4) findings.push({
    primitive: 'SM3 (国密)',
    evidence: 'IV 命中 ' + sm3iv.length + '/8 [' + sm3iv.slice(0, 4).join(',') + (sm3iv.length > 4 ? ',…' : '') + ']',
    offsetOrLocation: loc(SM3_IV[0]),
    confidence: sm3iv.length >= 6 ? 'high' : 'medium',
  });

  // SM4：FK + CK 表头（密钥扩展常量）
  const sm4fk = countHits(u32set, SM4_FK);
  const sm4ck = countHits(u32set, SM4_CK0);
  if (sm4fk.length >= 2 || sm4ck.length >= 2) findings.push({
    primitive: 'SM4 (国密, 密钥扩展常量)',
    evidence: 'FK 系统参数命中 ' + sm4fk.length + '/4; CK 表头命中 ' + sm4ck.length + '/4',
    offsetOrLocation: loc(SM4_FK[0]),
    confidence: (sm4fk.length >= 2 && sm4ck.length >= 1) ? 'high' : 'medium',
  });
}

/**
 * 主入口：scan(input, opts)
 * input: 字符串(hex/源码/字母表) | 字节数组 | Uint8Array | Buffer
 * opts: { asString?:bool 强制只按字符串/源码解释; label?:string }
 * 返回 { ok, interpretations:[...], findings:[...] }
 */
function scan(input, opts) {
  opts = opts || {};
  const findings = [];
  const interpretations = [];

  // 1) 字节数组 / Uint8Array / Buffer 输入
  if (Array.isArray(input) || input instanceof Uint8Array || Buffer.isBuffer(input)) {
    const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
    interpretations.push('raw-bytes(len=' + bytes.length + ')');
    scanBytes(bytes, 'raw-bytes', findings);
    return finalize(findings, interpretations);
  }

  // 2) 字符串输入：按多种解释扫
  if (typeof input === 'string') {
    const text = input;

    // 2a) 若像 hex → 解码成字节再扫
    if (!opts.asString && looksLikeHex(text)) {
      const bytes = hexToBytes(text);
      interpretations.push('hex→bytes(len=' + bytes.length + ')');
      scanBytes(bytes, 'hex-bytes', findings);
    }

    // 2b) 若像 JSON 数组 → 当字节数组扫
    if (!opts.asString) {
      const trimmed = text.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr) && arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
            const bytes = Uint8Array.from(arr);
            interpretations.push('json-array→bytes(len=' + bytes.length + ')');
            scanBytes(bytes, 'json-bytes', findings);
          }
        } catch (_) { /* 不是合法 JSON 数组，忽略 */ }
      }
    }

    // 2c) 当 JS 源码/文本：抽数字字面量 → 扫魔数；找 base64 字母表
    const lits = extractLiterals(text);
    interpretations.push('source-literals(count=' + lits.size + ')');
    scanU32Set(lits, 'source-literals', findings, null);

    const alphas = findBase64Alphabets(text);
    if (alphas.length) interpretations.push('base64-alphabets(' + alphas.length + ')');
    for (const a of alphas) {
      const cls = classifyBase64(a.alphabet);
      findings.push({
        primitive: cls.std ? 'base64 (' + cls.kind + ')' : 'custom base64 alphabet',
        evidence: cls.kind + ' = "' + a.alphabet + '"',
        offsetOrLocation: { interpretation: 'text', location: a.location },
        confidence: cls.std ? 'high' : 'high',
      });
    }

    // 2d) 也把整段文本当 latin1 字节扫一遍（应对纯二进制被当字符串读进来的情况；hex/json 已单独处理）
    if (!opts.asString && !looksLikeHex(text)) {
      const bytes = strToBytes(text);
      // 只在文本里没解析出大量 base64/字面量、且长度可观时才扫字节，避免源码误报；这里始终扫但 dedup 会去重
      scanBytes(bytes, 'text-as-latin1-bytes', findings);
    }

    return finalize(findings, interpretations);
  }

  return { ok: false, error: 'unsupported input type: ' + typeof input, interpretations, findings };
}

// 去重 + 排序 + 收尾
function finalize(findings, interpretations) {
  const seen = new Set();
  const dedup = [];
  for (const f of findings) {
    const key = f.primitive + '|' + f.evidence;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(f);
  }
  const rank = { high: 0, medium: 1, low: 2 };
  dedup.sort((a, b) => (rank[a.confidence] ?? 9) - (rank[b.confidence] ?? 9));
  return { ok: true, interpretations, findings: dedup };
}

/* ============================ CLI / 自检 ============================ */

// 把 CLI 第一个参数解释成 input：文件路径优先，其次直接当字符串
function inputFromCli(argv) {
  let filePath = null, str = null, asString = false;
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--file=')) filePath = a.slice(7);
    else if (a.startsWith('--str=')) { str = a.slice(6); asString = true; }
    else if (a === '--string') asString = true;
    else rest.push(a);
  }
  if (str != null) return { input: str, opts: { asString } };
  if (filePath == null && rest.length) {
    // 第一个非选项参数：是已存在文件则读文件，否则当字符串
    const a = rest[0];
    if (fs.existsSync(a) && fs.statSync(a).isFile()) filePath = a;
    else return { input: a, opts: { asString } };
  }
  if (filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { input: raw, opts: { asString }, source: filePath };
  }
  return null;
}

function selfTest() {
  const out = {};
  // 内置示例 1：恒等 256 排列（验证 RC4 S-box 检出）
  const ident = Array.from({ length: 256 }, (_, i) => i);
  out.example_identity_sbox = scan(ident);
  // 内置示例 2：自定义 base64 字母表（permuted 标准字符集；构造一个非标准排列）
  out.example_custom_b64 = scan('var T="BADCFEHGJILKNMPORQTSVUXWZYbadcfehgjilknmporqtsvuxwzy1032547698+/";');
  // 内置示例 3：含 MD5 IV + delta 的源码字面量
  out.example_md5_tea_src = scan('var a=0x67452301,b=0xefcdab89,c=0x98badcfe,d=0x10325476,delta=0x9e3779b9;');
  // 内置示例 4：含 MD5 IV 的二进制（LE 字节）
  const md5buf = Buffer.alloc(16);
  md5buf.writeUInt32LE(0x67452301, 0); md5buf.writeUInt32LE(0xefcdab89, 4);
  md5buf.writeUInt32LE(0x98badcfe, 8); md5buf.writeUInt32LE(0x10325476, 12);
  out.example_md5_bytes = scan(md5buf);
  return out;
}

if (require.main === module) {
  const cli = inputFromCli(process.argv.slice(2));
  if (!cli) {
    // 无参 → 跑自检
    const r = selfTest();
    process.stdout.write(JSON.stringify({ ok: true, mode: 'self-test', results: r }, null, 2) + '\n');
    process.exit(0);
  }
  const res = scan(cli.input, cli.opts);
  if (cli.source) res.source = cli.source;
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
}

module.exports = { scan };
