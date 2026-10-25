# 发布流程

v0.26.2（2026-10-24编译验收，10-25发布）是按这套流程走通的，后续正式版和预览版都照此执行。流程有变化时先改这份文档。早期规划见[distribution.md](distribution.md)，已不适用。

## 原则

- 顺序固定：先编译、验收，再提pr、合并，最后发布。合并前release只建草稿。
- 六个包出自同一个提交，即版本号提交。它就是包里的SourceStamp，tag也打在这个提交上。之后只能追加不进包的文档提交，代码一改就要重新出包。
- 验收只用最终包：mac是ad-hoc重签后的dmg，其他平台是编译机产出的原包。每一步都核对sha256和源码。
- 内容沙箱保持关闭，这是浏览器的核心能力。windows靠phase-b在`main()`里注入`MOZ_DISABLE_CONTENT_SANDBOX=1`，任何构建改动都不能让沙箱重新生效。
- 运行时测试只用临时profile和临时数据目录。要在维护者真实的profile上做覆盖安装检查，先征得维护者同意。
- 日志、发布说明和验证摘要里不写api key、cookie和个人数据；查配置只输出计数。

## 1. 定版本

1. 维护者定版本号和类型（正式版或预览版）。
2. 版本号提交把以下三处改成新版本号（不带`v`）。包里的`extensions.firefox-reverse.version`必须等于tag，`scripts/verify-windows-package.py`会核对：
   - `package.json`
   - `package-lock.json`（两处）
   - `preferences/frx-locale.js`
3. 本机跑`bash scripts/selftest-agent-tools.sh`，全部通过后再出包。

## 2. 编译机出包

编译机怎么准备见[build-host.md](build-host.md)。出包用`scripts/release-build.sh`：它在锁定基线源码树上打补丁，按`configs/`编译，做zh-CN重打包，再按发布文件名放进候选目录。任何一步失败都会停下。

1. 把版本号提交放到编译机上：新克隆一份本仓库，detach到版本号提交。github不通时，在本机打bundle传过去：
   ```sh
   git bundle create frx-<版本>-source.bundle <分支>
   git bundle verify frx-<版本>-source.bundle
   ```
2. 在这份检出里激活源码，每次发布做一次：
   ```sh
   UPSTREAM_DIR=<源码树> scripts/release-build.sh activate
   ```
   它先确认没有目标在编译、源码树HEAD是锁定基线`cebc55aab4d2661d1f6c2d1526362947ec4016c1`、检出是干净的，然后：
   - `npm ci`，打侧栏bundle要用esbuild；
   - 跑`scripts/selftest-agent-tools.sh`；
   - 用`scripts/apply-patches.sh`打补丁，前后都确认检出没被改动；
   - 跑`scripts/check-branding-assets.mjs`；
   - 把版本号提交写进`<源码树>/.frx-release-applied`。激活一开始就会删掉旧标记，中途失败时`build`不会用只打了一半补丁的源码树。
3. BuildID取开编时的`date -u +%Y%m%d%H%M%S`，五个目标共用一个。
4. 逐个目标编译，目标是`macos-arm64`、`macos-x86_64`、`linux-x86_64`、`linux-arm64`、`windows-x86_64`：
   ```sh
   UPSTREAM_DIR=<源码树> FRX_L10N_BASE=<l10n目录> MOZ_BUILD_DATE=<BuildID> scripts/release-build.sh build <目标>
   ```
   它会：
   - 核对源码树、l10n检出和`.frx-release-applied`，同一个目标不能同时编两份；
   - 生成这次用的mozconfig，存成候选目录里的`mozconfig.<目标>`；
   - 设好`MOZ_SOURCE_REPO`、`MOZ_SOURCE_CHANGESET`和`MOZ_BUILD_DATE`，依次跑`./mach configure`、`scripts/verify-branding.py`、`scripts/force-build-id-relink.sh`、`./mach build`，再确认`application.ini`里的`SourceStamp`和`BuildID`；
   - 排队跑`scripts/repack-zh-cn.sh`，只取这次新打出的包，按下表改名放进候选目录。候选目录默认是`dist/v<版本>-candidate`，可以用`FRX_DIST_DIR`改；
   - 检查包：linux跑`scripts/verify-linux-package.sh`；windows跑`scripts/verify-windows-installer.py`，用7-Zip取出安装程序的整个`core/`，和zip里的`firefox/`逐文件比sha256，不运行安装向导，报告写进`windows-installer-check.json`。v0.26.2是50个文件全部一致；
   - 把sha256写进`<目标>.sha256`。
5. 控制并行数，最多同时编三个。v0.26.2五个目标同时编时，mac x86_64和linux x86_64的rustc（gkrust的lto）被oom杀掉，这两个单独重编就过了。

ci按`firefox-reverse-<tag>-<平台>.<扩展名>`从release下载候选包，文件名必须严格照下表：

| 平台 | 文件名 |
| --- | --- |
| macos apple silicon | `firefox-reverse-v<版本>-macos-arm64.dmg` |
| macos intel | `firefox-reverse-v<版本>-macos-x86_64.dmg` |
| windows x86_64 | `firefox-reverse-v<版本>-windows-x86_64.zip`、`firefox-reverse-v<版本>-windows-x86_64-installer.exe` |
| linux x86_64 | `firefox-reverse-v<版本>-linux-x86_64.tar.xz` |
| linux arm64 | `firefox-reverse-v<版本>-linux-arm64.tar.xz` |

## 3. 拉回本机，重签mac包

1. 把六个包下载到一个新建的空目录，逐个核对sha256和编译机上的`<目标>.sha256`一致。
2. 两个dmg分别重打并做ad-hoc签名，输出就是最终包。重签后sha256会变，之后一律用重签后的值：
   ```sh
   bash scripts/macos-repack-adhoc-dmg.sh <原dmg> <输出dmg> arm64
   bash scripts/macos-repack-adhoc-dmg.sh <原dmg> <输出dmg> x86_64
   ```
3. 除安装程序外的五个包，在本机各跑一次`scripts/prepare-native-candidate.py`，命令见第5步第2条，换掉`PACKAGE_TARGET`和包名。要用python 3.11以上，mac包还要用`hdiutil`和`codesign`，所以放在本机跑。它核对：
   - sha256、二进制架构和品牌资源；
   - `application.ini`的`SourceStamp`、`BuildID`，以及`frx-locale.js`里的版本号；
   - 内容沙箱：`security.sandbox.content.level`为0，windows的`firefox.exe`里有`MOZ_DISABLE_CONTENT_SANDBOX=1`注入；
   - `moz.build`登记的全部侧栏模块，入库的逐字节等于提交，构建生成的（如`PageAccessibility.sys.mjs`）只查存在；
   - 侧栏bundle、样式和退出通道的启动登记。

   ci会在四个平台上再跑一遍。
4. 给六个最终包写`SHA256SUMS.txt`，再写`checksums.json`，内容是文件名到sha256的映射，触发ci时要用。

## 4. 草稿release和原生ci

1. 建草稿，target指向版本号提交：
   ```sh
   gh release create v<版本> --draft --target <版本号提交> --title "Firefox-Reverse v<版本>" --notes "<临时说明>" <六个最终包>
   ```
2. 把分支推到github（之后用它提pr），在这个分支上触发“Validate Release Packages”：
   ```sh
   gh workflow run validate-windows-package.yml --ref <分支> \
     -f release_tag=v<版本> \
     -f package_sha256=<windows zip的sha256> \
     -f source_commit=<版本号提交> \
     -f build_id=<BuildID> \
     -f package_checksums="$(cat checksums.json)" \
     -f mcp_commit=<frx-director-mcp提交>
   ```
   workflow用触发分支上的验证脚本，包的身份另外按`source_commit`逐字节绑定。main上的旧验证脚本可能不认识这一版新增的模块，所以要在这个分支上触发。v0.26.2触发时，分支HEAD就是版本号提交，`mcp_commit`是`e1e325271687c4cf1afa3d507e1022d59d187dc8`。
3. 矩阵在windows-latest、ubuntu-24.04、ubuntu-24.04-arm、macos-15-intel上分别跑：
   - 包身份核对；
   - 原生指纹；
   - 页面交互；
   - 全局提示词；
   - 环境生命周期（退出通道、进程身份核对、重启后状态恢复，见第5步第5条）。

   另有`native-windows`任务跑`scripts/verify-windows-package.py`，做启动、截图和ledger验证。全部通过才能继续。记下各平台的指纹、页面和提示词项数，写进发布说明。

## 5. 本机mac arm64验收

ci矩阵里没有apple silicon，这一项在本机跑。macos没有`timeout`，长任务可以用`perl -e 'alarm shift; exec @ARGV' <秒> <命令>`限时。

1. 准备版本号提交的干净检出，在`additions/browser/components/agent-sidebar`里执行`npm ci && npm run build`，生成侧栏bundle。ci里的“Rebuild exact-source sidebar”也是这样做的。frx-director-mcp检出到同一个固定提交，也执行`npm ci && npm run build`。
2. 把最终arm64 dmg放进检出里的`candidate/`，核对包身份并解出应用。脚本会把`FRX_TEST_BINARY`、`FRX_TEST_XUL_SHA`、`FRX_TEST_BUNDLE_SHA`写进`GITHUB_ENV`指向的文件：
   ```sh
   RELEASE_TAG=v<版本> PACKAGE_TARGET=macos-arm64 SOURCE_COMMIT=<版本号提交> EXPECTED_BUILD_ID=<BuildID> \
   PACKAGE_CHECKSUMS='{"firefox-reverse-v<版本>-macos-arm64.dmg":"<sha256>"}' \
   GITHUB_ENV=<输出文件> EXPECTED_SIDEBAR_BUNDLE=additions/browser/components/agent-sidebar/content/agent-sidebar.bundle.js \
   python3 scripts/prepare-native-candidate.py
   ```
3. 下面三项都在隔离环境里跑：`env -u MOZ_DISABLE_CONTENT_SANDBOX HOME=<临时> MOZ_APP_DATA=<临时> MOZ_LOCAL_APP_DATA=<临时> TMPDIR=<临时>/ MOZ_HEADLESS=1`。
   - **指纹**：
     ```sh
     node scripts/verify-native-fingerprint.mjs --firefox <包装目录>/firefox --xul-sha256 "$FRX_TEST_XUL_SHA" \
       --mcp-root <frx-director-mcp检出> --allow-unavailable-webgl --context-type tab \
       --report-output native-report/FINGERPRINT-REPORT.json
     ```
     包装目录里放两样：`firefox`是一段`exec "<应用>/Contents/MacOS/firefox" "$@"`的脚本，`libxul.so`是指向`<应用>/Contents/MacOS/XUL`的符号链接。直接传指向可执行文件的符号链接会报“Couldn't load XPCOM”。
   - **页面交互**：
     ```sh
     node scripts/verify-page-interaction.mjs --firefox "$FRX_TEST_BINARY" --xul-sha256 "$FRX_TEST_XUL_SHA" \
       --mcp-root <frx-director-mcp检出> --output native-report/PAGE-REPORT.json --screenshot native-report/page-fixture.png
     ```
   - **全局提示词**：
     ```sh
     python3 scripts/verify-global-system-prompt.py --app "$FRX_TEST_BINARY" --source-commit <版本号提交> \
       --build-id <BuildID> --bundle-sha256 "$FRX_TEST_BUNDLE_SHA" --output native-report/global-system-prompt
     ```
4. 数据目录场景共15个，运行时不要设`MOZ_APP_DATA`：
   ```sh
   env -u MOZ_APP_DATA -u MOZ_LOCAL_APP_DATA -u MOZ_DISABLE_CONTENT_SANDBOX \
     python3 scripts/verify-macos-appdata.py --app "$FRX_TEST_BINARY" --xul-sha256 "$FRX_TEST_XUL_SHA" --output native-report/macos-appdata
   ```
   command line tools的默认sdk和链接器版本不匹配时，加`CC="cc -isysroot /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"`。
5. 环境生命周期：
   ```sh
   node scripts/verify-environment-lifecycle.mjs --firefox "$FRX_TEST_BINARY" --xul-sha256 "$FRX_TEST_XUL_SHA" \
     --mcp-root <frx-director-mcp检出> --output native-report/ENVIRONMENT-LIFECYCLE.json
   ```
   三个场景，可以用`--scenarios`只跑其中几个：
   - `quit-channel`：外部webdriver占着环境的marionette时关闭环境，要走退出通道，cookie和localstorage重开后还在；
   - `identity`：没拉起这个环境的后端实例（相当于主浏览器重启后）要按命令行认出环境进程；记录里的pid属于别的程序时判为`dead`，一个信号都不发；
   - `restart`：环境在后端不知情时退出，重启后的后端显示已停止，并且能重新打开。
6. 按本版改动补专项检查。
7. 测完确认`codesign --verify --deep --strict <应用>`通过，`XUL`的sha256没变。
8. intel dmg在本机只跑第2步，`PACKAGE_TARGET`换成`macos-x86_64`；原生运行交给ci的macos-15-intel。

## 6. windows真机（改到windows进程、退出、路径时必做）

环境生命周期的三个场景，ci的windows-latest也会跑。真机补的是ci没有的条件：长期使用的机器，以及访问不到mozilla服务的网络。v0.26.2的`Path`问题（windows的环境变量名是`Path`，系统工具因此找不到）当时就是在真机上查出的。

- 连接：ssh公钥登录；powershell脚本用`-EncodedCommand`（utf-16le的base64）执行，免得转义出错。
- 上传：
  - 最终zip；
  - `scripts/verify-environment-lifecycle.mjs`；
  - frx-director-mcp的`package.json`和`dist/bridge/marionetteWire.js`。生命周期验证只用这两个文件，缺了`package.json`会报esm错误；要在真机上跑指纹验证，就传整个frx-director-mcp。
- 运行：`node verify-environment-lifecycle.mjs --firefox <解压目录>\firefox\firefox.exe --mcp-root <frx-director-mcp目录> --output <报告>`。
- v0.26.2在真机上：`identity`、`restart`通过。修复前的提交`e80509f`在这两项上失败：严格身份核对返回`unknown`，重启后环境仍显示运行中，正是当时查出的问题。
- 已知：机器访问不到mozilla服务时，`quit-channel`这一项会失败。请求0.4秒内就被取走，但浏览器15秒内没退出，后端强制结束；失败信息里会写明是这种情况。v0.26.1就有，不算新版本的回归，退出通道以ci的windows-latest结果为准。
- 测完清理工作目录。测试启动还会在`%TEMP%`下留下空文件`remote-settings-startup-bundle-*`和空目录`mozilla-temp-files`，一并删掉。

## 7. 本机覆盖安装（维护者同意后）

检查用`scripts/verify-installed-upgrade.mjs`。它只输出计数和状态，不打印偏好值、key、书签标题或页面数据。

1. 带marionette启动旧版：
   ```sh
   open -a "/Applications/Firefox Reverse.app" --env 'MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS={"marionette.port":2899}' --args -marionette -remote-allow-system-access
   ```
   先跑一次`node scripts/verify-installed-upgrade.mjs --port 2899 --mcp-root <frx-director-mcp检出> --counts-only --quit`作基线，记下profile目录名，以及书签、模型配置、指纹环境的数量。`--counts-only`不建临时环境，旧版没有退出通道也能用。
2. 把旧应用打包备份，例如`Firefox-Reverse-v<旧版本>-backup-<日期>.zip`，再用最终dmg里的应用替换`/Applications`里的。
3. 用同样的命令启动新版，跑完整检查：
   ```sh
   node scripts/verify-installed-upgrade.mjs --port 2899 --mcp-root <frx-director-mcp检出> \
     --expect-version <版本> --expect-build-id <BuildID> --expect-profile <基线里的profile目录名> --quit
   ```
   它检查：
   - 版本号、BuildID、profile目录名符合预期，`compatibility.ini`的`LastVersion`已是这个build；
   - 临时建一个环境，通过退出通道关闭后删掉；
   - 检查前后书签、模型配置、指纹环境的数量不变。

   书签、模型配置、指纹环境的数量要和基线对得上。`--quit`会正常退出浏览器，最后确认没有残留进程。

## 8. 文档和pr

1. 写发布文档：
   - `CHANGELOG.md`顶部加一行；
   - `README.md`版本记录最上面加“### v<版本>（正式版，<日期>）”，日期写计划发布的那天；
   - 改到的专题文档同步更新；
   - `docs/verification/release-v<版本>/summary.json`写包sha256、各平台ci结果、本机和真机检查、已知限制，不写个人数据。格式参考v0.26.2那份。
2. 社区贡献者署名：
   - 个人仓库的协作者至少有写权限，所以不加协作者；
   - github contributors只统计默认分支上的提交作者，`Co-authored-by`不算；
   - 做法是把对方在issue里公开发的原话整理成`docs/community/issue-<编号>-<login>.md`，附来源链接，去掉联系方式这类个人信息；
   - 提交作者设为对方（`<id>+<login>@users.noreply.github.com`），提交者是维护者。
3. pr描述依次写背景、按提交列出的改动、验证、发布准备（含各平台结果表）和已知问题。ci要通过。
4. 由维护者合并，用合并提交，标题写成“Merge PR #<编号>: …”。

## 9. 发布

1. 先确认真的合并了：`gh pr view <编号> --json state,mergeCommit`，再确认main已包含版本号提交。
2. 发布并设为latest：
   ```sh
   gh release edit v<版本> --draft=false --latest --notes-file <发布说明>
   ```
3. 发布后核对：
   - `git ls-remote --tags origin v<版本>`指向版本号提交；
   - `releases/latest`是新版本；
   - 每个附件api里的`digest`等于`SHA256SUMS.txt`里的值，不用下载；
   - 正文和发布说明文件逐字节一致；
   - 说明里链接到main的文件都存在；
   - contributors里有新加的人。
4. 本机`git fetch origin --tags --prune`，把main快进到合并提交并切过去。

发布说明的结构照v0.26.2：
- 标题`Firefox-Reverse v<版本>`；
- 正文依次是更新内容、验收结果（各平台项数表）、已知限制、安装；
- 最后一行写运行时代码提交和BuildID；
- 附件只放六个包；
- 叙述里的英文小写，中文和英文、数字之间不加空格。

## 10. 收尾

- 在相关issue下说明新版本处理了什么、请报告人验证什么，等对方确认后再关闭。
- 删除已合并的分支（本地和远端）。删之前确认分支HEAD已并入main，也没有打开的pr在用它。
- 清理验证机上的工作目录。
- 没处理的问题写进下一批的待办。

## 已知缺口

`.github/workflows/release.yml`的mac任务打的是en-US包，不做zh-CN重打包，和正式包不等价，所以正式包走第2步的`release-build.sh`。要用这个工作流，先在自托管runner上准备锁定基线源码树，并在仓库变量里设置`FRX_UPSTREAM_DIR`。
