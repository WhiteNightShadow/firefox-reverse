# patches/fingerprint/

可配置的浏览器指纹随机化。运行时配置来自 `settings/fingerprint.json`。

## 覆盖字段

详见 [../../docs/features.md#1-指纹随机化fingerprint](../../docs/features.md)。

## 关键 Firefox 源文件

- `dom/base/Navigator.cpp` / `Navigator.webidl`
- `dom/base/Screen.cpp`
- `dom/canvas/CanvasRenderingContext2D.cpp`
- `dom/canvas/WebGLContext.cpp`
- `dom/media/webaudio/AudioContext.cpp`
- `intl/locale/LocaleService.cpp`

## 实现思路

1. 在 binding 层读取 `settings/fingerprint.json`（启动时一次）。
2. 每次 getter 调用时返回配置覆盖值（若开启该字段）。
3. 噪声类（canvas / audio）走每会话固定种子，避免同会话二次读取不一致暴露。
