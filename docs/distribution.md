# 发布与可见性策略

## 阶段

| 阶段 | 仓库可见性 | Release 可见性 | 触发条件 |
|------|-----------|----------------|----------|
| **private**（当前） | 私有 | 私有 | 默认 |
| **internal-test** | 私有 | 私有（邀请协作者可下载） | 至少 1 个核心模块跑通 |
| **public-beta** | 公开 | 公开（标 prerelease） | 6 大模块全部可用 + 多端编译通过 |
| **public-release** | 公开 | 公开（正式版） | 经过实战站点验证（如目标站点/NMPA 等） |

## 渠道

主渠道：**本仓库的 GitHub Releases**。

- 单 release 单文件最大 2 GB，Firefox 二进制压缩后 80-200 MB，完全够用。
- 私有仓库的 Releases 也是私有的——仅协作者可见/下载。
- Release tag 命名：`v<firefox-upstream-major>.<minor>.<patch>-rN`，例如 `v135.0.0-r1`。

## 产物清单

每次 release 应包含：

```
# 二进制（多端预编译包）
firefox-reverse-<version>-linux-x64.tar.xz
firefox-reverse-<version>-linux-x64.tar.xz.sha256
firefox-reverse-<version>-macos-arm64.dmg
firefox-reverse-<version>-macos-arm64.dmg.sha256
firefox-reverse-<version>-macos-x64.dmg
firefox-reverse-<version>-macos-x64.dmg.sha256
firefox-reverse-<version>-windows-x64.zip
firefox-reverse-<version>-windows-x64.zip.sha256

# 源码 tarball（已应用补丁，用户可跳过 bootstrap 直接 ./mach build）
firefox-reverse-<version>-source.tar.xz
firefox-reverse-<version>-source.tar.xz.sha256

# 元信息
SOURCES.md         # 对应的 upstream firefox ref + 本仓库 commit
CHANGELOG.md       # 本版相对上版的变更
```

## 用户自己编译的两条路径

**为什么不直接把上游 firefox 源码 vendor 进 firefox-reverse？**
源码 ~5 GB（不含历史）/ ~30 GB（含），超过 GitHub 仓库实用上限；上游每天数百 commit，同步成本天文数字；业界（camoufox / Brave / Tor Browser / LibreWolf / Mullvad）都用补丁集模式。

下面两条路径满足"用户想自己编"的需求：

### 路径 A：从仓库 clone

适合想跟踪本仓库更新的开发者。

```bash
git clone <firefox-reverse>
cd firefox-reverse
./scripts/bootstrap.sh        # 拉上游 mozilla-firefox/firefox
./scripts/apply-patches.sh    # 应用我们的补丁
./scripts/build.sh            # ./mach build 包装
./scripts/package.sh
```

依赖按 Mozilla 官方文档装：`./mach bootstrap` 会自动处理大部分。**完全不需要 firefox-reverse-build 仓库**。

### 路径 B：下载 patched-source tarball

适合一次性编一个固定版本的用户。

```bash
# 从 Releases 下载 firefox-reverse-<version>-source.tar.xz
tar -xf firefox-reverse-<version>-source.tar.xz
cd firefox-reverse-<version>
./mach bootstrap --no-interactive --application-choice browser
./mach build
./mach package
```

跳过 bootstrap + patch 步骤，直接编。Mozilla 官方对自家源码也是这么发的。

### 平台依赖参考

- Linux：https://firefox-source-docs.mozilla.org/setup/linux_build.html
- macOS：https://firefox-source-docs.mozilla.org/setup/macos_build.html
- Windows：https://firefox-source-docs.mozilla.org/setup/windows_build.html

## CI 发布流程（规划）

1. `firefox-reverse-build/` 的 CI 在 firefox-reverse 打 tag 时触发。
2. 矩阵编译四个平台，产物上传到 GitHub Releases drafts。
3. 本人手工审核 + 发布。

## 私有阶段获取产物

私有阶段没有 public release。本人/协作者获取产物：

- 自己跑 `firefox-reverse-build/scripts/build-{linux,macos,windows}.sh`
- 产物在 `firefox-reverse-build/dist/<platform>/`

## 公开门槛清单

切换 private → public-beta 前需要：

- [ ] 至少在 1 个目标平台编译跑通
- [ ] 至少 3 个模块产出可用 trace（建议 property-trace / network-analysis / cookie-js-analysis）
- [ ] License 明确（与 mozilla 上游 MPL-2.0 兼容）
- [ ] README 去除内部测试相关的临时说明
- [ ] 仓库内不含敏感字符串（密钥、内网地址）
