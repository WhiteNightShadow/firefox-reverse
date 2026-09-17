/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
export function normalizeFontScale(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(180, Math.max(90, Math.round(number / 10) * 10)) : 100;
}

// Local chrome document only: never page zoom, DPR, or browsing-context state.
export function applySidebarFontScale(doc, value) {
  const scale = normalizeFontScale(value);
  const style = doc.documentElement.style;
  if (!style.getPropertyValue("--frx-base-font-size")) {
    style.setProperty("--frx-base-font-size", doc.defaultView.getComputedStyle(doc.body).fontSize);
  }
  style.setProperty("--frx-font-scale", String(scale / 100));
  return scale;
}
