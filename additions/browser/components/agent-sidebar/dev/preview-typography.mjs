import http from "node:http";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({ absWorkingDir: root, bundle: true, write: false, format: "iife", stdin: { resolveDir: root, loader: "jsx", contents: String.raw`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import SettingsPane from './content/SettingsPane.jsx';import MarkdownContent from './content/MarkdownContent.jsx';
import {ConfigStore} from './modules/ConfigStore.sys.mjs';import{applySidebarFontScale}from'./modules/SidebarTypography.sys.mjs';
const store=new ConfigStore({persistent:true,getString:(k,d)=>localStorage.getItem(k)??d,setString:(k,v)=>localStorage.setItem(k,v),clear:k=>localStorage.removeItem(k)});
applySidebarFontScale(document,store.getSidebarFontScale());
function App(){const[settings,setSettings]=useState(true);return settings?<SettingsPane store={store} providers={[{id:'deepseek',label:'DeepSeek',defaultModel:'test-model',models:[]}]} fetchModels={async()=>[]} onClose={()=>setSettings(false)}/>:<main className="agent-panel"><header className="agent-panel__bar"><span>Agent</span><button onClick={()=>setSettings(true)}>设置</button></header><div className="agent-panel__messages"><MarkdownContent children={'## 字号验证\n\n聊天正文、**重点内容**与设置保持同一比例。\n\n| 字段 | 内容 |\n| --- | --- |\n| 环境 | Firefox 原生一致模式 |\n\n'+String.fromCharCode(96).repeat(3)+'js\nconst fingerprint = {enabled: true};\n'+String.fromCharCode(96).repeat(3)}/></div></main>}
createRoot(document.getElementById('root')).render(<App/>);
` } });
const css = await fs.readFile(new URL("../content/agent-panel.css", import.meta.url), "utf8");
const server=http.createServer((_req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<!doctype html><meta charset="utf-8"><title>Typography QA</title><style>${css}</style><div id="root"></div><script>${result.outputFiles[0].text}</script>`);});
server.listen(Number(process.env.PORT || 0),"127.0.0.1",()=>console.log(`http://127.0.0.1:${server.address().port}`));
process.once("SIGTERM",()=>{server.closeAllConnections();server.close();});
