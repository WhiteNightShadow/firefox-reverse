#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "additions", "browser", "branding", "unofficial");
const upstreamRoot = process.argv[2]
  ? path.join(path.resolve(process.argv[2]), "browser", "branding", "unofficial")
  : null;

const required = [
  "configure.sh",
  "default16.png",
  "default32.png",
  "default64.png",
  "default128.png",
  "default256.png",
  "firefox.icns",
  "firefox.ico",
  "firefox64.ico",
  "newtab.ico",
  "newwindow.ico",
  "pbmode.ico",
  "locales/en-US/brand.ftl",
  "locales/en-US/brand.properties",
  "content/about-logo.png",
  "content/about-logo@2x.png",
  "content/about-logo.svg",
  "content/about-logo-private.png",
  "content/about-logo-private@2x.png",
  "content/about-wordmark.svg",
  "content/firefox-wordmark.svg",
  "content/about.png",
];

function fail(message) {
  throw new Error(`branding check failed: ${message}`);
}

async function assertFile(root, relative) {
  const fullPath = path.join(root, relative);
  const info = await stat(fullPath).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    fail(`missing or empty file: ${fullPath}`);
  }
  return fullPath;
}

async function digest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

for (const relative of required) {
  await assertFile(sourceRoot, relative);
}

const configure = await readFile(path.join(sourceRoot, "configure.sh"), "utf8");
if (!/MOZ_APP_DISPLAYNAME=["']?Firefox Reverse["']?/.test(configure)) {
  fail("configure.sh does not set MOZ_APP_DISPLAYNAME to Firefox Reverse");
}

const brandFtl = await readFile(path.join(sourceRoot, "locales/en-US/brand.ftl"), "utf8");
for (const key of [
  "-brand-shorter-name",
  "-brand-short-name",
  "-brand-shortcut-name",
  "-brand-full-name",
  "-brand-product-name",
]) {
  if (!new RegExp(`^${key}\\s*=\\s*Firefox Reverse\\s*$`, "m").test(brandFtl)) {
    fail(`${key} is not Firefox Reverse`);
  }
}

for (const relative of ["content/about-wordmark.svg", "content/firefox-wordmark.svg"]) {
  const wordmark = await readFile(path.join(sourceRoot, relative), "utf8");
  if (!wordmark.includes("Firefox Reverse") || /Nightly/i.test(wordmark)) {
    fail(`${relative} does not contain the Firefox Reverse wordmark`);
  }
}

const logoHash = await digest(path.join(sourceRoot, "default256.png"));
for (const relative of [
  "content/about-logo.png",
  "content/about-logo@2x.png",
  "content/about-logo-private.png",
  "content/about-logo-private@2x.png",
  "content/about.png",
]) {
  if ((await digest(path.join(sourceRoot, relative))) !== logoHash) {
    fail(`${relative} is not derived from the Firefox Reverse app logo`);
  }
}

const iconHash = await digest(path.join(sourceRoot, "firefox.ico"));
for (const relative of ["newtab.ico", "newwindow.ico", "pbmode.ico"]) {
  if ((await digest(path.join(sourceRoot, relative))) !== iconHash) {
    fail(`${relative} does not match the Firefox Reverse Windows icon`);
  }
}

if (upstreamRoot) {
  for (const relative of required) {
    const sourcePath = path.join(sourceRoot, relative);
    const upstreamPath = await assertFile(upstreamRoot, relative);
    if ((await digest(sourcePath)) !== (await digest(upstreamPath))) {
      fail(`upstream branding is stale: ${relative}`);
    }
  }
}

console.log(
  `branding assets: OK (${required.length} files${upstreamRoot ? ", upstream synchronized" : ""})`
);
