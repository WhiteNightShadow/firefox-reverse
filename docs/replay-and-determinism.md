# 离线回放与固定随机数

两个工具让同一个页面流程可以反复跑出同样的结果：`net_replay`用录好的响应回答请求，不碰线上；`page_determinism`固定页面的随机数，同输入得到同一个签名。两者独立使用，也可以一起用。

## 什么时候用

- 签名、指纹里混了随机nonce，同一输入每次结果都不同，node复刻没法和页面逐字节对比：先`page_determinism`。
- 要反复复跑同一个页面或签名流程，又不想打线上（限流、封号、数据会变），或者要在断网时继续分析：用`net_replay`。
- 对比改动前后的trace、让两次运行走同样的分支：两个一起开。

## 离线回放（net_replay）

流程：

1. `net_capture({action:"start", captureBody:true})`，把页面正常走一遍。响应体按解码后的内容录（gzip、br等已解开），单条8mb、总量64mb封顶，超出或没收完的响应不参与回放。`net_get({requestId, includeBody:true})`可以查看录到的请求体和响应体。
2. `net_replay({action:"start"})`。之后当前标签页的请求先查录制：查到就直接用录制作答，不走网络；没录到的默认拦截（`unmatched:"pass"`则照常联网）。
3. `page_navigate`刷新或重新触发请求，`net_replay({action:"log"})`看每条是`replayed`、`blocked`还是`passed`。
4. `net_replay({action:"stop"})`恢复联网。

匹配规则：

- 键是方法+url（去掉#片段）+请求体。`query`控制查询参数怎么比：`exact`原样，`ignore-order`忽略顺序，`ignore`整个忽略（时间戳、随机参数会变时用）。`matchBody:false`不比请求体。
- 同一个键录到多条时按录制顺序作答；`reuse:true`（默认）用完后一直回最后一条，`reuse:false`每条只用一次，用完按没录到处理。
- `urlPattern`、`ids`只取一部分录制来回放。
- `scope:"tab"`（默认）只管当前标签页，按标签页的browserId判断，跨进程导航后仍然有效；`scope:"all"`管整个浏览器。

`save`把录制存成工作目录里的har（默认`work/capture.har`），下次`net_replay({action:"start", source:"har", harPath:"work/capture.har"})`直接回放，浏览器重开也能用；别的工具导出的har只要带响应内容（`content.text`，二进制用base64）也能用。

原理：在`http-on-modify-request`阶段给通道设`nsIHttpChannelInternal.setResponseOverride`，与webdriver bidi的`network.provideResponse`同一机制，请求不建立连接，页面拿到的是正常的响应对象。录制的是解码后的内容，回放时去掉`Content-Encoding`、`Content-Length`等跟原始传输有关的响应头。

限制：只管http(s)请求，websocket、webrtc不回放；流式响应（sse等）要等收完才能录下。

## 固定随机数（page_determinism）

流程：

1. `page_determinism({action:"start", seed:"任意字符串"})`。之后当前标签页打开的每个文档（含iframe、跨进程导航后的文档）在页面脚本运行前设种子；当前已经打开的文档也立即从种子开头重新取数。
2. `page_navigate`重新打开页面，让页面从第一行脚本起就是确定的，再正常取签名。同一个种子、同样的输入，签名每次相同。
3. `page_determinism({action:"replica"})`把同一套算法的node版写进工作目录（默认`work/determinism-replica.cjs`）。复刻脚本里：

   ```js
   const { seeded } = require("./determinism-replica.cjs");
   const r = seeded("任意字符串");
   r.random();                              // 对应 Math.random()
   r.getRandomValues(new Uint8Array(16));   // 对应 crypto.getRandomValues()
   r.randomUUID();                          // 对应 crypto.randomUUID()
   ```

   按页面里的调用顺序取数，结果与页面逐位一致。
4. `page_determinism({action:"stop"})`恢复真随机：已打开的文档立即恢复，新文档不再设种子。

取数规则（`additions/dom/base/FrxDeterministicRandom.h`，与复刻代码一一对应）：

- 种子按utf-8字节做fnv-1a 64哈希，作为splitmix64的初值；前两个输出是`Math.random`的xorshift128+状态，后两个是crypto的状态。
- `Math.random`和spidermonkey原本的算法一样：取xorshift128+输出的低53位除以2^53。
- `getRandomValues`和`randomUUID`共用一条序列。`getRandomValues`每次调用从新的64位输出开始，低字节在前，用不完的字节丢弃；`randomUUID`取两个输出拼成32位十六进制，再按版本4设版本位和变体位。
- 每个文档都从种子开头算起，iframe和刷新后的新文档也一样。

原理：引擎层实现。`Math.random`直接设realm自己的生成器状态（新增`js::SetRealmMathRandomState`），jit内联的`Math.random`读的是同一份状态；页面看到的仍是原生函数，toString、属性描述符都没有变化，检测不到被改过。crypto在每个文档的`Crypto`对象上挂一条序列。父进程把配置写进sharedData并注册`AgentDeterminism` actor，新文档的`DOMWindowCreated`在页面脚本运行前触发，由内容进程设种子；新开的内容进程启动时也会带上配置。

限制：

- `Date.now`、`performance.now`等时间不固定，签名里的时间戳照常处理。
- worker、shared worker、service worker里的随机数不受影响。
- `crypto.subtle`生成密钥、blob url里的uuid等走系统随机数的地方不受影响。
- `page_eval`跑在自己的沙箱里，沙箱有自己的`Math`：要看页面那条序列写`window.Math.random()`。在`page_eval`里调`crypto.getRandomValues`用的是页面的`crypto`，会消耗页面那条序列。

## 验证

- `dev/selftest-network-replay.mjs`：匹配键、har往返、录制顺序与`reuse`、拦截与放行、标签页范围、停止。
- `dev/selftest-page-determinism.mjs`：复刻代码对浏览器实测的值、每个文档独立的序列、start/stop/replica、内容侧只给配置覆盖的标签页设种子。
- `scripts/verify-page-interaction.mjs`在真实浏览器里检查：gzip响应解码后录下、按录制作答且服务器没被访问、没录到的被拦截、har存取后回放、停止后恢复联网；设种子后页面、同源iframe、刷新后、跨站导航后的随机数都和node复刻逐位一致（含5万次循环走jit的累加和），中文种子同样一致，停止后恢复真随机。
