/* request-template.js — 实打目标接口的脚手架（P6 验证）。fs_copy 到 work/ 后改：
 * ① BASE/QUERY 用 net_get 抓的真实请求当模版 ② COOKIE 从浏览器抓的静态值 ③ genSign 接你补环境算出的签名。
 * 退出判据：返回非空有效 body（非错误码），换多组输入再验稳定性。 */
'use strict';

// ① 真实请求模版（net_get 抓的目标请求：URL/headers/cookie 原样搬，先能通再逐个剥参数）
const BASE = 'https://www.example.com/api/path';
const QUERY = {            // 除签名外的参数，多数固定/可从浏览器拿
  aid: '24',
  app_name: 'xxx_web',
  msToken: 'PASTE_FROM_BROWSER',  // 服务端下发的静态值，直接抓来用
  // ... 其它业务参数
};
const COOKIE = 'ttwid=PASTE; msToken=PASTE; ...';  // ② 从浏览器抓的静态 cookie
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ③ 你的签名生成（接补环境 loader 或纯算实现）。返回 {参数名: 值}，会并进 query。
function genSign(queryStr) {
  // const sign = require('./node-env-loader-or-pure-algo').sign(fullUrl);
  // return { a_bogus: sign };
  return {};
}

function buildUrl() {
  const qs = new URLSearchParams(QUERY).toString();
  const fullNoSign = BASE + '?' + qs;
  const sign = genSign(qs);              // 签名常依赖"不含签名的完整 query/url"
  const all = new URLSearchParams({ ...QUERY, ...sign }).toString();
  return BASE + '?' + all;
}

(async () => {
  const url = buildUrl();
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, 'Cookie': COOKIE, 'Referer': 'https://www.example.com/', 'Accept': 'application/json' },
  });
  const text = await resp.text();
  console.log('status:', resp.status, '| len:', text.length);
  console.log('body head:', text.slice(0, 300));
  // 判据：status 200 且 body 非空有效（不是 {"data":null} / 错误码）= 签名对了
})();
