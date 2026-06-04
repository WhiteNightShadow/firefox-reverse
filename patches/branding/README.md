# branding — 用 firefox-reverse 自有 logo 替换浏览器 app 图标

把浏览器在 Dock / 访达 / 程序坞 / Cmd-Tab 里的图标，从默认 Firefox（unofficial branding）换成项目 logo（`logo.jpg`）。

## 组成

1. **`0001-use-firefox-reverse-app-icon.patch`** — 改 `browser/app/macbuild/Contents/Info.plist.in`，
   删掉 `CFBundleIconName`/`AppIcon` 两行。
2. **`additions/browser/branding/unofficial/`** — 由 `logo.jpg` 生成的图标资源（rsync 覆盖上游同名文件）：
   - `firefox.icns`（app/dock 图标，含 16→1024 全尺寸）
   - `default16.png … default256.png`（窗口/关于页内嵌图标）

## 为什么要删 `CFBundleIconName`

macOS 现代构建里 Info.plist 同时有 `CFBundleIconFile=firefox.icns` 和 `CFBundleIconName=AppIcon`。
**当 `CFBundleIconName` 存在且能在 `Assets.car`（编译后的资源目录）里解析到 `AppIcon` 时，系统优先用 `Assets.car` 里的图标，而不是 `firefox.icns`。**
而 `Assets.car` 只能用 Xcode 的 `actool` 重新编译——Linux 交叉编译服务器上没有 `actool`，无法替换其中的 AppIcon。

所以这里走最稳的路：**删掉 `CFBundleIconName`**，让系统回落到 `CFBundleIconFile=firefox.icns`，再把 `firefox.icns` 换成自有 logo 即可。无需 actool。

## 复现图标资源（在 macOS 上跑，需要 sips/iconutil，随 CLT 自带）

```bash
SRC=logo.jpg            # 4096² 方图最佳
mkdir -p /tmp/i/firefox.iconset
for s in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" \
         "128:128x128" "256:128x128@2x" "256:256x256" "512:256x256@2x" \
         "512:512x512" "1024:512x512@2x"; do
  sips -s format png -z "${s%%:*}" "${s%%:*}" "$SRC" \
       --out "/tmp/i/firefox.iconset/icon_${s##*:}.png"
done
iconutil -c icns /tmp/i/firefox.iconset -o additions/browser/branding/unofficial/firefox.icns
for s in 16 22 24 32 48 64 128 256; do
  sips -s format png -z $s $s "$SRC" --out additions/browser/branding/unofficial/default${s}.png
done
```

## 安装后刷新图标缓存（macOS 会缓存旧图标）

```bash
touch /Applications/FirefoxReverse.app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/FirefoxReverse.app
killall Dock; killall Finder
```

> 注：当前 mozconfig 未启用 official branding → 默认走 `browser/branding/unofficial/`，故图标资源放在 `unofficial/`。
