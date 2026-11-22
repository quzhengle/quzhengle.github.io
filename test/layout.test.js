"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const SBS = require("../sbs-core.js");

function mockCtx() {
  const calls = [];
  return {
    calls,
    set fillStyle(_v) {},
    fillRect() {
      calls.push({ op: "fill", args: Array.from(arguments) });
    },
    drawImage() {
      calls.push({ op: "draw", args: Array.from(arguments) });
    },
  };
}

function assertFullFrame(vw, vh) {
  const layout = SBS.computeLayout(vw, vh);
  const rects = SBS.contentRects(layout);
  const srcAspect = vw / vh;
  const contentAspect = layout.contentW / layout.contentH;
  const idealH = (layout.contentW * vh) / vw;

  assert.equal(layout.strength, 8);
  assert.equal(layout.mode, "full-sbs");
  assert.ok(layout.contentW >= 2 && layout.contentH >= 2);
  assert.equal(layout.contentW % 2, 0);
  assert.equal(layout.contentH % 2, 0);
  assert.equal(layout.outputW % 2, 0);
  assert.equal(layout.outputH % 2, 0);
  assert.ok(layout.contentW <= vw);
  assert.ok(layout.contentH <= vh + 1);
  assert.ok(layout.contentW <= SBS.MAX_CONTENT_EDGE);
  assert.ok(layout.contentH <= SBS.MAX_CONTENT_EDGE + 1);
  assert.ok(Math.abs(layout.contentH - idealH) <= 1.01, "content aspect drifted by more than 1px");
  assert.ok(Math.abs(contentAspect - srcAspect) / srcAspect < 0.02);

  assert.equal(layout.shift, Math.max(0, Math.round((8 / 40) * layout.contentW * 0.06)));
  assert.equal(layout.eyeW, layout.contentW + layout.shift * 2);
  assert.equal(layout.eyeH, layout.contentH);
  assert.equal(layout.outputW, layout.eyeW * 2);
  assert.equal(layout.outputH, layout.eyeH);

  // Full SBS is about twice as wide as the source, not half-SBS squeezed back.
  const outAspect = layout.outputW / layout.outputH;
  assert.ok(outAspect > srcAspect * 1.85, "output collapsed toward half SBS or a crop");

  for (const rect of [rects.left, rects.right]) {
    assert.equal(rect.w, layout.contentW);
    assert.equal(rect.h, layout.contentH);
    assert.ok(rect.x >= 0 && rect.y >= 0);
    assert.ok(rect.x + rect.w <= layout.outputW);
    assert.ok(rect.y + rect.h <= layout.outputH);
  }
  assert.ok(rects.left.x + rects.left.w <= layout.eyeW);
  assert.ok(rects.right.x >= layout.eyeW);
  assert.ok(rects.left.x + rects.left.w <= rects.right.x);

  const ctx = mockCtx();
  const source = { kind: "frame" };
  SBS.drawSBS(ctx, source, vw, vh, layout);
  const draws = ctx.calls.filter((c) => c.op === "draw");
  assert.equal(draws.length, 2);
  for (const draw of draws) {
    // Regression: the old generator sampled a source rect of the *scaled*
    // size (for example 960x540 out of 1920x1080), which cropped the picture.
    assert.equal(draw.args[0], source);
    assert.deepEqual(draw.args.slice(1, 5), [0, 0, vw, vh]);
  }
  assert.deepEqual(draws[0].args.slice(5), [rects.left.x, rects.left.y, rects.left.w, rects.left.h]);
  assert.deepEqual(draws[1].args.slice(5), [rects.right.x, rects.right.y, rects.right.w, rects.right.h]);
  return layout;
}

test("landscape phone video keeps the full frame inside full SBS", () => {
  const layout = assertFullFrame(1920, 1080);
  assert.equal(layout.contentW, 960);
  assert.equal(layout.contentH, 540);
  assert.ok(layout.shift > 0);
  // The destructive source crop used process size as the source rectangle.
  assert.notDeepEqual([layout.contentW, layout.contentH], [1920, 1080]);
});

test("portrait phone video is not sliced to a landscape process rect", () => {
  const layout = assertFullFrame(1080, 1920);
  assert.equal(layout.contentW, 540);
  assert.equal(layout.contentH, 960);
  assert.ok(layout.outputH > layout.outputW * 0.5);
});

test("representative sizes preserve full-frame geometry", () => {
  const sizes = [
    [1280, 720],
    [720, 1280],
    [640, 360],
    [360, 640],
    [1920, 1080],
    [1080, 1920],
    [1919, 1080],
    [1080, 1919],
    [100, 100],
    [2, 2],
    [3840, 2160],
    [2160, 3840],
    [1920, 800],
    [800, 1920],
    [100, 1920],
    [1920, 100],
  ];
  for (const [w, h] of sizes) assertFullFrame(w, h);
});

test("small videos are not upscaled", () => {
  const layout = assertFullFrame(640, 360);
  assert.equal(layout.contentW, 640);
  assert.equal(layout.contentH, 360);
});

test("disparity pad keeps both shifted pictures inside the canvas", () => {
  const layout = SBS.computeLayout(1280, 720);
  const rects = SBS.contentRects(layout);
  const shift = layout.shift;
  assert.equal(rects.left.x, shift * 2);
  assert.equal(rects.right.x, layout.eyeW);
  // Relative placement matches the previous ±shift pair (total 2*shift).
  const leftOffset = rects.left.x;
  const rightOffset = rects.right.x - layout.eyeW;
  assert.equal(leftOffset - rightOffset, shift * 2);
});
