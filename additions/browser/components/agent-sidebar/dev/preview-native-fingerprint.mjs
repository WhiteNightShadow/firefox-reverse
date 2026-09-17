import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({ absWorkingDir: root, bundle: true, write: false, format: "iife", stdin: { resolveDir: root, loader: "jsx", contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FingerprintForm} from './content/EnvironmentPane.jsx';
import {nativeFingerprintDefaults,validateNativeFingerprint} from './modules/NativeFingerprintPolicy.sys.mjs';
const f=value=>({value,enabled:true});
const config=nativeFingerprintDefaults({enabled:true,seed_mode:'persistent',navigator:{userAgent:f('Mozilla/5.0 Firefox/153.0'),platform:f('MacIntel'),language:f('zh-CN'),languages:f(['zh-CN','zh']),hardwareConcurrency:f(8)},screen:{width:f(1920)},window:{devicePixelRatio:f(2)},webgl:{},http:{userAgent:f('Mozilla/5.0 Firefox/153.0'),acceptLanguage:f('zh-CN,zh;q=0.9')},intl:{locale:f('zh-CN'),timezone:f('Asia/Shanghai')}},'0'.repeat(64));
function App(){const [fingerprint,setFingerprint]=useState(config);let error='';try{validateNativeFingerprint(fingerprint)}catch(e){error=e.message}return <main className="env-pane"><FingerprintForm fingerprint={fingerprint} setFingerprint={setFingerprint}/><output id="validation">{error || 'valid'}</output><script type="application/json" id="config">{JSON.stringify(fingerprint)}</script></main>}
createRoot(document.getElementById('root')).render(<App/>);
` } });
const css = await fs.readFile(path.join(root, "content/agent-panel.css"), "utf8");
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>Native fingerprint form preview</title><style>${css}\nbody{margin:0;background:white;color:#18181b}main{max-width:680px;padding:14px;margin:auto}#validation{display:block;margin-top:16px}</style><div id="root"></div><script>${result.outputFiles[0].text}</script>`);
});
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
