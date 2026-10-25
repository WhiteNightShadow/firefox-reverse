# macos 27启动问题的根因诊断与预览版实测

来源：[@odtu945](https://github.com/odtu945)在[issue #18](https://github.com/WhiteNightShadow/firefox-reverse/issues/18)中的三条评论：[2026-10-14根因分析](https://github.com/WhiteNightShadow/firefox-reverse/issues/18#issuecomment-6160616483)、[2026-10-19补充与复现](https://github.com/WhiteNightShadow/firefox-reverse/issues/18#issuecomment-6260668594)、[2026-10-22预览版实测](https://github.com/WhiteNightShadow/firefox-reverse/issues/18#issuecomment-6330635318)。以下为原文摘录。

## 环境

> | 项 | 值 |
> | --- | --- |
> | 版本 / 安装包 | v0.26.1，`firefox-reverse-v0.26.1-macos-arm64.dmg` |
> | 架构 | Apple Silicon（arm64） |
> | 系统 | macOS 27.0.1（Build 26A434） |
> | 启动方式 | 双击 App、`open -a`、终端直接执行二进制，均失败（现象见下） |
> | 弹窗全文 | 标题「配置文件缺失」，正文「无法加载您的 Firefox 配置文件。它可能已经丢失，或是无法访问。」 |

## 根因

> **macOS 27.0.1 会在 `~/Library/Application Support` 下按名字（不区分大小写）拒绝创建名为 `Firefox` 的目录，`mkdir` 返回 `Operation not permitted`（EPERM）。**
>
> 而 Firefox-Reverse 的用户数据目录由 `Resources/application.ini` 的 `[App] Name=Firefox` 决定，恰为 `~/Library/Application Support/Firefox`。首次启动时 profile 引导链在任何用户交互之前就需要创建该目录，必然失败 → `SelectStartupProfile`/加锁流程拿不到目录 → 弹出 `profileMissing` 对话框。
>
> **这就是「配置文件缺失」的直接来源——不是配置文件丢了，是系统不让建。** 也解释了为何作者在 macOS 26.7.1 无法复现（该拦截不存在于 26.x），而报告者与我都使用 macOS 27。

## 复现

```sh
mkdir "$HOME/Library/Application Support/Firefox"   # → Operation not permitted（firefox/FIREFOX 同样被拒；Chrome 等名字正常 → 按名字定向拦截）
open -a "Firefox Reverse"                            # 即弹「配置文件缺失」
```

## 修复建议

> 机制：nsXREDirProvider::GetUserDataDirectory() 开头即读 MOZ_APP_DATA（mozilla::GetFileFromEnv），设置后整体替代默认数据目录推导。我本机 workaround 用的正是它，行为已验证。
>
> 插入点：必须早于 profile service 首次读取 profiles.ini（即 nsAppRunner.cpp 中 SelectStartupProfile 调用之前，比您 0005 补丁所在的 wasDefaultSelection 块更早）：探测默认数据根目录（App Support + application.ini 的 Name=Firefox）能否创建；失败则 setenv("MOZ_APP_DATA",   ~/Library/Application Support/FirefoxReverse) 后继续启动，stderr 留一条日志。
>
> 触发条件放宽为「创建失败或存在但非目录」，而非仅 EPERM：同时覆盖 27 的拦截和用户误建同名普通文件的场景；≤26 用户默认路径可用时探针不触发，零影响。
>
> 边界：默认目录若有历史数据需提示一次性迁移； ~/.firefox-reverse/environments 与此目录无关，不受影响。
>
> 验证：打补丁后清除所有环境变量直接 open -a → 应正常启动、数据落在 FirefoxReverse/。预览包出来后我再做真实拦截环境的端到端复测。

## 预览版实测（v0.26.2-preview.1）

> 维护者要求的全部验证项（无变量启动、数据保留、关闭重开、重启后启动）均已通过，从我的真实拦截环境看 v0.26.2-preview.1 可转正式修复
