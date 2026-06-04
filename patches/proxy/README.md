# patches/proxy/

进程级 HTTP / SOCKS 代理，按规则路由。运行时配置来自 `settings/proxy.json`。

## 关键 Firefox 源文件

- `netwerk/base/nsIProtocolProxyService.idl`
- `netwerk/base/nsProtocolProxyService.cpp`
- `netwerk/socket/nsSOCKSIOLayer.cpp`

## 配置示例

见 [../../settings/proxy.example.json](../../settings/proxy.example.json)。
