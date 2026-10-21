# macOS 启动排查

适用于 [Issue #18](https://github.com/WhiteNightShadow/firefox-reverse/issues/18) 一类启动反馈。2026-10-19，@odtu945 已确认 v0.26.1 ARM64 应用未修改，通过 `MOZ_APP_DATA` 使用 `~/Library/Application Support/FirefoxReverse` 后完整重启仍可启动，且独立目录已有书签和模型配置；原 Firefox 目录从未创建成功。这些材料已足以进入候选包验证，不需要重复索取同样的信息。

Mozilla 已记录 [macOS 27 对 Firefox 数据目录的访问限制](https://bugzilla.mozilla.org/show_bug.cgi?id=2068208)，也有[允许显式 profile 在注册表不可读时启动的上游修复](https://bugzilla.mozilla.org/show_bug.cgi?id=2069536)。上游后者不等于普通启动的目录创建问题已解决。本仓候选改动只处理默认数据根目录选择，不扩大系统权限、不绕过 profile 锁。

## v0.26.2-preview.1 候选行为

- 只作用于 macOS 默认 Firefox 应用命名空间；Windows/Linux、自定义 `App.Profile`、显式 `MOZ_APP_DATA` 保持原选择。显式 `MOZ_LOCAL_APP_DATA` 优先。
- 可用的旧 `Firefox` 根目录继续使用。仅遇到 `EACCES/EPERM` 对应的访问拒绝才考虑 `FirefoxReverse`：旧根已确认不存在，或备用根有可读、格式有效且包含 profile 的 `profiles.ini`。无法读取不等于不存在。
- 复用备用根时原地使用，绝不复制、删除、重建旧 profile。选择记录为备用根下的空文件 `.frx-appdata-v1`，以后普通启动继续使用该根，缓存对应 `~/Library/Caches/FirefoxReverse`。显式环境变量仍可覆盖选择。
- 磁盘满、只读卷、I/O 错误、路径被文件占用、备用注册表损坏/不可读均不触发静默换目录。旧根访问被拒且无可识别备用 profile 时仍停止并提示诊断，不创建一套可能掩盖旧数据的空 profile。
- 当前工作机是 macOS 26.7.1 ARM64。预览包需要报告者在撤下临时 LaunchAgent/环境变量后验证 macOS 27，Issue #18 保持开放；不能把合成权限故障测试等同于该系统实测。

**已有临时方案的测试者：** 先完整退出浏览器，保留独立数据目录及备份，只停用自己添加的 LaunchAgent 并清除临时启动变量，不删除 `profiles.ini`、书签或模型配置。正常打开预览包后核对原书签、原模型配置和重启持久性；失败时可以恢复原变量继续使用独立目录。不要分享模型 Key。

## 先区分错误

- “Firefox 配置文件无法加载/可能丢失或不可访问”通常来自 Firefox 的 **profile 用户数据目录**。它不是 `fingerprint.json`，创建一个同名 JSON 文件不能代替目录。
- 指纹配置不可读或格式错误：本轮 C++ 会记录 Invalid 并停用覆盖，环境管理器会显示保存/打开错误；不要把它和 profile 缺失混为一谈。
- `application.ini`、XUL 缺失或签名验证失败：属于应用包/安装完整性问题。

## 只读检查

在仓库目录运行（需要 Python 3）：

```sh
python3 scripts/diagnose-macos-startup.py \
  --app "/Applications/Firefox Reverse.app" \
  --output /tmp/firefox-reverse-startup.json
```

工具只读取系统版本、架构、应用元数据、签名状态、profile 注册项及目录可访问性，不读取 cookies、登录信息、模型 Key 或完整偏好设置，不删除锁或修改 profile。只在指定 `--output` 时写诊断报告；分享前仍请检查个人路径。

若诊断提示安装默认项指向不存在的目录，可完整退出 Firefox Reverse 后打开原生配置管理器，手动选择仍存在的 profile：

```sh
open -n -a "/Applications/Firefox Reverse.app" --args -new-instance -P
```

不要直接删除 `profiles.ini`、`installs.ini`、整个 Firefox 数据目录或正在使用的锁。创建新 profile 会得到独立空环境，不会把旧书签、cookie 自动搬进去。

当前锁定的 Firefox 153 基线已忽略 `-no-remote`；有效的独立实例参数是 `-new-instance`，它不绕过 profile 锁，不修复丢失数据。不能仅凭增加 `-no-remote` 后成功就断定实例冲突，直接命令启动与 Finder 的环境也可能不同。

v0.26.0 对未显式指定 profile 的交互启动增加有限恢复入口：仅当默认目录确认不存在或不是目录，才显示原生 Profile Manager 由用户选择；权限探测异常、无头启动、reset、显式 `-profile` 和重启路径保持原行为，不自动创建空 profile。

反馈时请附：Firefox-Reverse 版本及包文件名、Intel/Apple Silicon、`sw_vers` 输出、完整弹窗截图、启动方式（双击/MCP/环境管理）及脱敏诊断结果。本轮本地开发机为 macOS 26.7.1 ARM64；其他系统结果需对应机器验证。
