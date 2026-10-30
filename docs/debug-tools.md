# 快照断点、控制台与站点数据

三个面向调试的工具，都不改页面、不注入脚本：`debug_breakpoint`在引擎层下断点，`page_console`读引擎缓存的控制台消息，`clear_site_data`走firefox自己的清除站点数据服务。

## 快照断点（debug_breakpoint）

命中时不暂停页面：读这一帧的实参、`this`、作用域链上的变量和调用栈，存最近几条，页面照常往下跑。适合“想看某行跑到时局部变量是什么”“这个请求是哪段代码、带着什么状态发出去的”。

三种定位方式：

| 方式 | 参数 | 说明 |
| --- | --- | --- |
| 源码片段 | `text`（+`scriptUrl`、`occurrence`） | 给一段独一无二的代码文本，断在它之后第一个可下断的位置；混淆或压缩成一行的代码不用数行号 |
| 行号 | `scriptUrl` + `line`（+`column`） | 同一行有多个语句时用列号挑 |
| 请求 | `xhr`（url子串或带`*`的fnmatch） | fetch/xhr/beacon发出那一刻抓发起它的页面调用帧；内容进程里的请求通知同步处于页面的js栈中，所以不用往页面装任何东西 |

流程：`start`→触发（交互或`page_navigate`重载）→`query`→`stop`。

- `condition`：在命中帧里求值的js表达式，真才记录（如`u !== 'skip'`）；求值抛错的那次不记，计入`conditionErrors`。
- `vars`：逗号分隔的变量名，沿作用域链找到后深序列化（`depth`、`maxArr`控制大小）；其余变量只给一行预览，`scopeDepth`控制往外看几层。
- 每条命中：`fn`、`url:line:column`、`arguments`、`this`、`scopes`（从最内层往外）、`vars`、`stack`（最上面是命中帧）；xhr模式另有`request.url`、`request.method`。
- 跨导航存活：新全局自动接管，目标脚本重新编译时重新下断。热路径上命中超过2000次、或开了10分钟没停，会自动卸掉。
- 和`signer_trace`的分工：`signer_trace`按函数抓每次调用的入参；`debug_breakpoint`按位置抓那一刻的完整局部状态。

## 控制台（page_console）

引擎按文档缓存最近1000条`console.*`调用，页面加载时打的日志也在，不用提前开；脚本错误和警告来自引擎（`source: "engine"`）。

- `level`、`pattern`（正则）、`since`（上次结果最后一条的`t`，增量读）、`limit`（默认50，最多200）。
- `clear: true`清掉该文档缓存的`console.*`记录；引擎错误不清。
- 只含当前顶层文档，iframe里的不在内。

## 清站点数据（clear_site_data）

按站点清数据，默认当前标签页的站点，也可指定`site`。`what`可选：`cookies`、`storage`（localStorage、indexeddb、cache api、service worker）、`cache`、`permissions`、`auth`（http认证）、`hsts`、`all`；默认cookies+storage+cache。

清完页面内存里的状态还在（已加载脚本持有的token、已建立的连接），要从干净状态重跑就`reload: true`或`page_navigate`重新打开。

## 验证

- `dev/selftest-page-debugger.mjs`：文本定位、三种模式的下断位置、快照内容、条件过滤、环形缓冲、脚本重编译后重新下断、时间盒、停止。
- `scripts/verify-page-interaction.mjs`在真实浏览器里检查：断在内联脚本的指定文本上，命中拿到实参、作用域预览、深序列化的变量和调用栈，页面不停；请求断点抓到发起fetch的那一帧和请求信息；控制台读到`console.log/warn/error`和未捕获异常，按级别、正则、`since`过滤；清站点数据后cookie和localStorage都不在了。
