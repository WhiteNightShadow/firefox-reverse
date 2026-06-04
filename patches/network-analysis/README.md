# patches/network-analysis/

网络层请求/响应捕获，含完整字段 + 调用栈 + 时序。

## 关键 Firefox 源文件

- `netwerk/protocol/http/nsHttpChannel.cpp`
- `netwerk/protocol/websocket/WebSocketChannel.cpp`
- `dom/fetch/Fetch.cpp`
- `dom/xhr/XMLHttpRequest.cpp`

## 输出

`settings.trace.network_dir/network-<pid>-<timestamp>.jsonl`

每行字段：

```
ts, request_id, kind(http|ws|fetch|xhr),
method, url, headers, body,
status, response_headers, response_body,
timing, initiator_stack
```
