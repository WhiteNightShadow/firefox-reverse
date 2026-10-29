# 编译机准备

正式包的五个目标都在一台linux x86_64编译机上出：linux x86_64是本机编译，另外四个是交叉编译。出包用`scripts/release-build.sh`，它在发布流程里的位置见[release-process.md](release-process.md)第2步。机器地址、账号和密钥不写进仓库。

下面的数字来自编v0.26.2的那台编译机，它在2026-10-25退掉了。

## 机器

- 系统：ubuntu x86_64。那台自带python 3.10。
- 内存：那台是61GiB。五个目标同时编会oom，mac x86_64和linux x86_64的rustc（gkrust的lto）被杀掉，所以最多同时编三个。
- 磁盘：要放得下源码树、l10n检出和五个objdir。那台的磁盘是788GB，历次的objdir和产物都留着时用到了九成。
- 网络：要能访问github（拉基线、l10n和本仓库），以及mozilla的taskcluster（第一次configure时下载工具链）。github不通时，本仓库的提交可以用`git bundle`传过去。

## 装软件

1. 系统包：git、python3、util-linux（`flock`）、coreutils（`sha256sum`）、file、unzip、xz-utils、p7zip-full（检查windows安装程序要用7-Zip）。
2. node.js 22和npm，和ci一致。侧栏bundle用esbuild打，`activate`里的`npm ci`会装好。
3. 先拉锁定基线（见下一节），在源码树里跑一次`./mach --no-interactive bootstrap --application-choice browser`，装好系统依赖和rustup。
4. rust固定在1.95.0，v0.26.2就是用它编的。bootstrap装的是当时最新的stable，装完再装1.95.0和四个交叉编译目标，并设为默认：
   ```sh
   rustup toolchain install 1.95.0 --target aarch64-apple-darwin,x86_64-apple-darwin,x86_64-pc-windows-msvc,aarch64-unknown-linux-gnu
   rustup default 1.95.0
   ```
   configure只在mozilla自己的ci里下载rust，编译机用的是rustup装的版本。

## 拉源码

1. 锁定基线。这棵源码树可以一直复用，每次发布由`activate`重新打补丁：
   ```sh
   UPSTREAM_DIR=<源码树> bash scripts/bootstrap.sh
   ```
   它浅克隆mozilla-firefox/firefox的`cebc55aab4d2661d1f6c2d1526362947ec4016c1`。
2. l10n。v0.24.1到v0.26.2都用这个提交：
   ```sh
   git clone --filter=blob:none https://github.com/mozilla-l10n/firefox-l10n.git <l10n目录>
   git -C <l10n目录> checkout --detach 53be390d96a531cf526f5db0fa83c02f12465abb
   ```
   `release-build.sh`会核对这个提交，并要求检出没有改动。要换翻译时，改脚本里`FRX_L10N_REF`的默认值，再按完整流程验收。
3. 本仓库。每次发布单独克隆一份，detach到版本号提交。`release-build.sh`只认干净的检出。

## 工具链

configure用的是`--enable-bootstrap=no-update`：缺的工具链下载到`~/.mozbuild`，已有的不更新。第一次configure会下载clang、各平台的sysroot、macos sdk、windows sdk（`vs`）、nsis和wine等，dmg工具在第一次打mac包时下载。v0.26.2的包里记的是clang 20.1.8、rustc 1.95.0。

## mozconfig

五个目标的mozconfig都在`configs/`：

| 目标 | 文件 | objdir |
| --- | --- | --- |
| macos-arm64 | `mozconfig.macos-arm64` | `obj-aarch64-apple-darwin` |
| macos-x86_64 | `mozconfig.macos-x64` | `obj-x86_64-apple-darwin` |
| linux-x86_64 | `mozconfig.linux-x64` | `obj-x86_64-linux` |
| linux-arm64 | `mozconfig.linux-arm64` | `obj-aarch64-linux` |
| windows-x86_64 | `mozconfig.windows-x64` | `obj-win64` |

configure参数和v0.26.2发布包里`about:buildconfig`记的一致，`scripts/tests/test-release-build.py`会核对。只有一处例外：mac arm64那个objdir是更早配置的，没有显式写`--enable-bootstrap=no-update`，不过nightly的git检出默认就开着bootstrap。

`release-build.sh`在候选目录里生成实际用的mozconfig：objdir换成绝对路径，再加上`--with-l10n-base=<l10n目录>`。想沿用已经编过的objdir做增量编译，可以用`FRX_OBJDIR`指过去。

## 出包

```sh
UPSTREAM_DIR=<源码树> scripts/release-build.sh activate
UPSTREAM_DIR=<源码树> FRX_L10N_BASE=<l10n目录> MOZ_BUILD_DATE=<BuildID> scripts/release-build.sh build <目标>
```

完整步骤见[release-process.md](release-process.md)第2步。每个目标编完会在候选目录写一份`build-record.<目标>.json`，记下实际用的工具链版本和configure参数，换编译机时拿它核对。

mac的两个目标也可以在mac本机出：`release-build.sh`在macos上用python代替util-linux的`flock`加锁，`sha256sum`不在时用`shasum`。工具链同样由bootstrap下载到`MOZBUILD_STATE_PATH`，rust用rustup装的1.95.0。

## 注意

- 在远端用`pgrep -f`等构建结束时，模式写成`[r]elease-build.sh build`，否则会匹配到pgrep所在的shell，一直等不完。
- `scripts/prepare-native-candidate.py`要python 3.11以上，编译机上的python不够新，这一步在本机跑，见release-process.md第3步。
- mac的dmg要拉回mac上重打包、ad-hoc签名后才是最终包，也在第3步。
