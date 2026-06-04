/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* firefox-reverse 改动：本浏览器为「引擎级 JS 追踪 / JSVMP 白盒」刻意关闭内容沙箱
 * （security.sandbox.content.level=0，见 patches/agent-ui/0001 的 firefox.js 覆盖），
 * 这是已知且预期的逆向工作站配置。下方 maybeWarnAboutDisabledContentSandbox 顶部加
 * 早返回，抑制 Firefox 的「unsupported / less secure」信息栏（每窗口反复弹很打扰）。
 * 整文件原样 vendored 到 additions/，由 apply-patches.sh 的 rsync 覆盖 upstream 同名文件
 * （比 git apply 补丁更稳，不受行号/上下文漂移影响）。 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

export var SandboxUtils = {
  _sandboxDisabledThisSession: false,
  /**
   * Show a notification bar if user is running without unprivileged namespace
   *
   * @param {Window} aWindow
   *        The window where the notification will be displayed.
   */
  maybeWarnAboutMissingUserNamespaces:
    function SU_maybeWarnAboutMissingUserNamespaces(aWindow) {
      if (AppConstants.platform !== "linux") {
        return;
      }

      // This would cover Flatpak, Snap or any "Packaged App" (e.g., Debian package)
      // Showing the notification on Flatpak would not be correct because of
      // existing Flatpak isolation (see Bug 1882881). And for Snap and
      // Debian packages it would be irrelevant as well.
      const isPackagedApp = Services.sysinfo.getPropertyAsBool("isPackagedApp");
      if (isPackagedApp) {
        return;
      }

      const kSandboxUserNamespacesPref =
        "security.sandbox.warn_unprivileged_namespaces";
      const kSandboxUserNamespacesPrefValue = Services.prefs.getBoolPref(
        kSandboxUserNamespacesPref
      );
      if (!kSandboxUserNamespacesPrefValue) {
        return;
      }

      const userNamespaces =
        Services.sysinfo.getPropertyAsBool("hasUserNamespaces");
      if (userNamespaces) {
        return;
      }

      let box = aWindow.gNotificationBox;
      const mozXulElement = box.stack.documentGlobal.MozXULElement;
      mozXulElement.insertFTLIfNeeded("toolkit/updates/elevation.ftl");

      let buttons = [
        {
          supportPage: "linux-security-warning",
          "l10n-id": "sandbox-unprivileged-namespaces-howtofix",
        },
        {
          "l10n-id": "sandbox-unprivileged-namespaces-dismiss-button",
          callback: () => {
            Services.prefs.setBoolPref(kSandboxUserNamespacesPref, false);
          },
        },
      ];

      // Now actually create the notification
      box.appendNotification(
        "sandbox-unprivileged-namespaces",
        {
          label: { "l10n-id": "sandbox-missing-unprivileged-namespaces" },
          priority: box.PRIORITY_WARNING_HIGH,
        },
        buttons
      );
    },

  /**
   * Show a warning if the content sandbox is disabled.
   *
   * @param {Window} aWindow
   *        The window where the notification will be displayed.
   */
  maybeWarnAboutDisabledContentSandbox(aWindow) {
    // firefox-reverse: 内容沙箱是本浏览器刻意关闭的预期配置，抑制该信息栏。
    return;
    // eslint-disable-next-line no-unreachable
    const sandboxSettings = Cc[
      "@mozilla.org/sandbox/sandbox-settings;1"
    ].getService(Ci.mozISandboxSettings);

    if (sandboxSettings.effectiveContentSandboxLevel === 0) {
      this._sandboxDisabledThisSession = true;
    }

    // if sandbox was never disabled, return early
    // If it was disabled at any point, continue showing the warning
    // in every window for the remainder of the session.
    if (!this._sandboxDisabledThisSession) {
      return;
    }

    const box = aWindow.gNotificationBox;
    if (!box.getNotificationWithValue("sandbox-content-disabled")) {
      const mozXulElement = box.stack.documentGlobal.MozXULElement;
      mozXulElement.insertFTLIfNeeded("toolkit/updates/elevation.ftl");

      box.appendNotification(
        "sandbox-content-disabled",
        {
          label: { "l10n-id": "sandbox-content-disabled-warning" },
          priority: box.PRIORITY_WARNING_HIGH,
        },
        [],
        false,
        false
      );
    }
  },

  observeContentSandboxPref() {
    const observer = {
      observe() {
        const level = Services.prefs.getIntPref(
          "security.sandbox.content.level",
          -1
        );
        if (level === 0) {
          const winEnum = Services.wm.getEnumerator("navigator:browser");
          while (winEnum.hasMoreElements()) {
            const win = winEnum.getNext();
            SandboxUtils.maybeWarnAboutDisabledContentSandbox(win);
          }
          Services.prefs.removeObserver(
            "security.sandbox.content.level",
            observer
          );
        }
      },
    };
    Services.prefs.addObserver("security.sandbox.content.level", observer);
  },
};
