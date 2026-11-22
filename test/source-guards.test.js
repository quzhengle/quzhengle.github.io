"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

test("css and js cache-bust together so phones pick up the new page", () => {
  const versions = new Set();
  for (const match of html.matchAll(/(?:href|src)="[^"]+\?v=([^"]+)"/g)) {
    versions.add(match[1]);
  }
  assert.ok(versions.size === 1, "asset versions diverged: " + [...versions].join(", "));
  const version = [...versions][0];
  assert.match(version, /^2026/);
  assert.match(html, new RegExp("styles\\.css\\?v=" + version));
  assert.match(html, new RegExp("sbs-core\\.js\\?v=" + version));
  assert.match(html, new RegExp("app\\.js\\?v=" + version));
  assert.match(html, new RegExp('name="build" content="' + version + '"'));
});

test("preview containers are not locked to a 16:9 crop", () => {
  assert.doesNotMatch(css, /aspect-ratio:\s*16\s*\/\s*9/);
  assert.doesNotMatch(css, /object-fit:\s*cover/);
  assert.match(css, /object-fit:\s*contain/);
});

test("page explains full SBS versus half SBS and does not promise a Photos write", () => {
  assert.match(html, /全宽 SBS/);
  assert.match(html, /半宽/);
  assert.match(html, /不裁切、不拉伸/);
  assert.match(html, /不能直接写入/);
  assert.match(html, /视差强度固定为 8/);
  assert.doesNotMatch(html, /type="range"/);
  assert.doesNotMatch(html, /png/i);
});

test("recorder follows video frames instead of a fixed 30fps resample", () => {
  assert.match(app, /requestVideoFrameCallback/);
  assert.match(app, /requestFrame/);
  assert.match(app, /captureStream\(0\)/);
  assert.doesNotMatch(app, /captureStream\(\s*30\s*\)/);
  assert.match(app, /SBSCore\.drawSBS/);
  assert.match(app, /SBSCore\.STRENGTH/);
});
