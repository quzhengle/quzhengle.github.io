/**
 * Preview + real export checks against synthetic landscape/portrait clips.
 * Requires ffmpeg, ffprobe, and google-chrome. Not a physical phone.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import SBS from "../sbs-core.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(root, "test", "fixtures");
const outDir = path.join(root, "test", "output");
const artifactDir = "/opt/cursor/artifacts";
const chromePath = "/usr/bin/google-chrome-stable";
const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const BORDER = 24;
const BAR_X0 = 48;
const BAR_STEP = 4;
const BAR_W = 12;

const CASES = [
  {
    name: "landscape-30",
    width: 1920,
    height: 1080,
    fps: 30,
    seconds: 2,
  },
  {
    name: "portrait-24",
    width: 1080,
    height: 1920,
    fps: 24,
    seconds: 2,
  },
  {
    name: "landscape-60",
    width: 640,
    height: 360,
    fps: 60,
    seconds: 1.5,
  },
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(cmd + " " + args.join(" ") + "\n" + err.slice(-2500)));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function makeFixture(spec) {
  fs.mkdirSync(fixturesDir, { recursive: true });
  const frames = Math.round(spec.fps * spec.seconds);
  const file = path.join(fixturesDir, spec.name + ".mp4");
  const chain = [
    "drawbox=x=0:y=0:w=iw:h=" + BORDER + ":color=red:t=fill",
    "drawbox=x=0:y=ih-" + BORDER + ":w=iw:h=" + BORDER + ":color=lime:t=fill",
    "drawbox=x=0:y=0:w=" + BORDER + ":h=ih:color=blue:t=fill",
    "drawbox=x=iw-" + BORDER + ":y=0:w=" + BORDER + ":h=ih:color=yellow:t=fill",
    "drawtext=fontfile=" + font + ":text='TOP LEFT':x=36:y=36:fontsize=28:fontcolor=white",
    "drawtext=fontfile=" + font + ":text='TOP RIGHT':x=w-tw-36:y=36:fontsize=28:fontcolor=white",
    "drawtext=fontfile=" + font + ":text='BOTTOM LEFT':x=36:y=h-th-36:fontsize=28:fontcolor=white",
    "drawtext=fontfile=" + font + ":text='BOTTOM RIGHT':x=w-tw-36:y=h-th-36:fontsize=28:fontcolor=white",
    "drawtext=fontfile=" + font + ":text='%{n}':x=(w-tw)/2:y=88:fontsize=32:fontcolor=white",
  ].join(",");
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=" + spec.width + "x" + spec.height + ":r=" + spec.fps + ":d=" + spec.seconds,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=" + spec.seconds,
    "-filter_complex",
    "[0:v]" + chain + "[bg];color=c=white:s=" + BAR_W + "x40:r=" + spec.fps + "[bar];[bg][bar]overlay=x='48+4*n':y='(H-h)/2':shortest=1[v]",
    "-map",
    "[v]",
    "-map",
    "1:a",
    "-frames:v",
    String(frames),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-movflags",
    "+faststart",
    file,
  ]);
  return { ...spec, frames, file };
}

function classify([r, g, b]) {
  if (r < 40 && g < 40 && b < 55) return "black";
  if (r > 150 && g < 110 && b < 110 && r > g + 40 && r > b + 40) return "red";
  if (g > 140 && r < 130 && b < 130 && g > r + 30 && g > b + 25) return "green";
  if (b > 140 && r < 140 && g < 150 && b > r + 25 && b > g + 15) return "blue";
  if (r > 150 && g > 150 && b < 130) return "yellow";
  if (r > 200 && g > 200 && b > 200) return "white";
  return "other";
}

function startServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/") rel = "/index.html";
      const file = path.join(root, path.normalize(rel));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const ext = path.extname(file);
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".png": "image/png",
      };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  return JSON.parse(stdout.toString("utf8"));
}

async function frameTimes(file) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "json",
    file,
  ]);
  const json = JSON.parse(stdout.toString("utf8"));
  return (json.frames || [])
    .map((f) => Number(f.best_effort_timestamp_time))
    .filter((n) => Number.isFinite(n));
}

async function meanVolume(file) {
  try {
    const { stderr } = await run("ffmpeg", ["-v", "info", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
    const match = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    return match ? Number(match[1]) : null;
  } catch (err) {
    const match = String(err.message).match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    return match ? Number(match[1]) : null;
  }
}

async function rawFrame(file, width, height) {
  const { stdout } = await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
  if (stdout.length < width * height * 3) {
    throw new Error("short raw frame " + stdout.length + " for " + width + "x" + height);
  }
  return stdout;
}

function pixelAt(buf, width, x, y) {
  const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
  const o = (Math.round(y) * width + xi) * 3;
  return [buf[o], buf[o + 1], buf[o + 2]];
}

function avgBox(buf, width, height, x, y) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.max(0, Math.min(width - 1, Math.round(x) + dx));
      const yy = Math.max(0, Math.min(height - 1, Math.round(y) + dy));
      const p = pixelAt(buf, width, xx, yy);
      r += p[0];
      g += p[1];
      b += p[2];
      n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function edgePoints(layout) {
  const rects = SBS.contentRects(layout);
  const inset = Math.max(3, Math.floor((BORDER * layout.contentW) / layout.videoW / 2));
  const points = [];
  for (const [name, rect] of [
    ["left", rects.left],
    ["right", rects.right],
  ]) {
    const midY = rect.y + rect.h / 2;
    const midX = rect.x + rect.w / 2;
    points.push({ name: name + "-left", x: rect.x + inset, y: midY, expect: "blue" });
    points.push({ name: name + "-right", x: rect.x + rect.w - 1 - inset, y: midY, expect: "yellow" });
    points.push({ name: name + "-top", x: midX, y: rect.y + inset, expect: "red" });
    points.push({ name: name + "-bottom", x: midX, y: rect.y + rect.h - 1 - inset, expect: "green" });
  }
  if (layout.shift >= 2) {
    points.push({ name: "pad-left", x: 2, y: layout.outputH / 2, expect: "black" });
    points.push({ name: "pad-right", x: layout.outputW - 3, y: layout.outputH / 2, expect: "black" });
  }
  return points;
}

function checkEdges(buf, width, height, layout) {
  const samples = [];
  const errors = [];
  for (const point of edgePoints(layout)) {
    const rgb = avgBox(buf, width, height, point.x, point.y);
    const got = classify(rgb);
    samples.push({ ...point, rgb, got });
    if (got !== point.expect) {
      errors.push(point.name + " expected " + point.expect + " got " + got + " rgb=" + rgb.join(","));
    }
  }
  return { samples, errors };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

async function scanMotion(file, width, layout) {
  const y = Math.round(layout.contentH / 2);
  const { stdout } = await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-fps_mode",
    "passthrough",
    "-vf",
    "format=rgb24,crop=" + width + ":1:0:" + y,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
  const rect = SBS.contentRects(layout).left;
  const indexes = [];
  const frameBytes = width * 3;
  const frames = Math.floor(stdout.length / frameBytes);
  for (let i = 0; i < frames; i++) {
    const base = i * frameBytes;
    let sum = 0;
    let count = 0;
    for (let x = Math.floor(rect.x); x < Math.ceil(rect.x + rect.w); x++) {
      const o = base + x * 3;
      const r = stdout[o];
      const g = stdout[o + 1];
      const b = stdout[o + 2];
      if (r > 180 && g > 180 && b > 180) {
        sum += x;
        count++;
      }
    }
    if (!count) {
      indexes.push(null);
      continue;
    }
    const contentX = sum / count - rect.x;
    const sourceX = contentX / (layout.contentW / layout.videoW);
    const n = (sourceX - (BAR_X0 + BAR_W / 2)) / BAR_STEP;
    indexes.push(n);
  }
  const present = indexes.filter((n) => n != null);
  let maxJump = 0;
  let backward = 0;
  let held = 0;
  for (let i = 1; i < present.length; i++) {
    const d = present[i] - present[i - 1];
    if (d < -0.75) backward++;
    if (Math.abs(d) < 0.35) held++;
    if (d > maxJump) maxJump = d;
  }
  return {
    frames,
    detected: present.length,
    first: present.length ? Number(present[0].toFixed(2)) : null,
    last: present.length ? Number(present[present.length - 1].toFixed(2)) : null,
    maxJump: Number(maxJump.toFixed(2)),
    backward,
    held,
    heldRatio: present.length > 1 ? held / (present.length - 1) : 1,
  };
}

function assertCloseAspect(cssW, cssH, pixelW, pixelH, label, errors) {
  if (cssW < 2 || cssH < 2) {
    errors.push(label + " CSS box is empty");
    return;
  }
  const cssAspect = cssW / cssH;
  const pixelAspect = pixelW / pixelH;
  const rel = Math.abs(cssAspect - pixelAspect) / pixelAspect;
  if (rel > 0.03) {
    errors.push(
      label +
        " aspect " +
        cssAspect.toFixed(4) +
        " != bitmap " +
        pixelAspect.toFixed(4) +
        " (" +
        (rel * 100).toFixed(1) +
        "%)"
    );
  }
}

function assertInside(inner, outer, label, errors) {
  const slop = 2;
  if (inner.left < outer.left - slop || inner.top < outer.top - slop || inner.right > outer.right + slop || inner.bottom > outer.bottom + slop) {
    errors.push(
      label +
        " is clipped by its container " +
        JSON.stringify({ inner, outer })
    );
  }
}

function assertInViewport(box, viewport, label, errors) {
  const slop = 3;
  if (box.left < -slop || box.top < -slop || box.right > viewport.w + slop || box.bottom > viewport.h + slop) {
    errors.push(label + " is not fully inside the phone viewport " + JSON.stringify(box));
  }
  if (box.w < 8 || box.h < 8) errors.push(label + " is not visible");
}

async function installDownloadHook(page) {
  await page.evaluate(() => {
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      window.__downloadClicked = true;
      window.__downloadName = this.download || "";
      return orig.apply(this, arguments);
    };
  });
}

async function readCanvasEdges(page) {
  return page.evaluate((border) => {
    const canvas = document.getElementById("outputCanvas");
    const layout = window.__SBS_DEBUG.layout;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rects = window.SBSCore.contentRects(layout);
    const inset = Math.max(3, Math.floor((border * layout.contentW) / layout.videoW / 2));
    function avg(x, y) {
      const xi = Math.round(x);
      const yi = Math.round(y);
      const data = ctx.getImageData(Math.max(0, xi - 1), Math.max(0, yi - 1), 3, 3).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }
    const points = [];
    for (const [name, rect] of [
      ["left", rects.left],
      ["right", rects.right],
    ]) {
      const midY = rect.y + rect.h / 2;
      const midX = rect.x + rect.w / 2;
      points.push({ name: name + "-left", x: rect.x + inset, y: midY, expect: "blue", rgb: avg(rect.x + inset, midY) });
      points.push({
        name: name + "-right",
        x: rect.x + rect.w - 1 - inset,
        y: midY,
        expect: "yellow",
        rgb: avg(rect.x + rect.w - 1 - inset, midY),
      });
      points.push({ name: name + "-top", x: midX, y: rect.y + inset, expect: "red", rgb: avg(midX, rect.y + inset) });
      points.push({
        name: name + "-bottom",
        x: midX,
        y: rect.y + rect.h - 1 - inset,
        expect: "green",
        rgb: avg(midX, rect.y + rect.h - 1 - inset),
      });
    }
    if (layout.shift >= 2) {
      points.push({ name: "pad-left", expect: "black", rgb: avg(2, layout.outputH / 2) });
      points.push({ name: "pad-right", expect: "black", rgb: avg(layout.outputW - 3, layout.outputH / 2) });
    }
    return points;
  }, BORDER);
}

async function measurePreview(page) {
  await page.evaluate(() => {
    document.getElementById("outputCanvas").scrollIntoView({ block: "center", inline: "nearest" });
  });
  const canvasBox = await page.evaluate(() => {
    const canvas = document.getElementById("outputCanvas");
    const wrap = document.getElementById("canvasWrap");
    const c = canvas.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    return {
      bitmap: { w: canvas.width, h: canvas.height },
      css: { left: c.left, top: c.top, right: c.right, bottom: c.bottom, w: c.width, h: c.height },
      wrap: { left: w.left, top: w.top, right: w.right, bottom: w.bottom, w: w.width, h: w.height },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dim: document.getElementById("dimReadout").textContent,
      layout: window.__SBS_DEBUG.layout,
    };
  });
  await page.evaluate(() => {
    document.getElementById("sourceVideo").scrollIntoView({ block: "center", inline: "nearest" });
  });
  const videoBox = await page.evaluate(() => {
    const video = document.getElementById("sourceVideo");
    const wrap = video.parentElement;
    const c = video.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    return {
      bitmap: { w: video.videoWidth, h: video.videoHeight },
      css: { left: c.left, top: c.top, right: c.right, bottom: c.bottom, w: c.width, h: c.height },
      wrap: { left: w.left, top: w.top, right: w.right, bottom: w.bottom, w: w.width, h: w.height },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  return { canvasBox, videoBox };
}

async function runCase(browser, serverPort, spec) {
  const errors = [];
  const page = await browser.newPage();
  const downloadDir = path.join(outDir, spec.name + "-download");
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(msg.type() + ": " + msg.text()));
  page.on("pageerror", (err) => consoleLines.push("pageerror: " + err.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
  });

  await page.goto("http://127.0.0.1:" + serverPort + "/?debug=1", { waitUntil: "networkidle0" });
  await installDownloadHook(page);
  const input = await page.$("#fileInput");
  await input.uploadFile(spec.file);
  await page.waitForFunction(
    () => {
      const el = document.getElementById("dimReadout");
      return el && !el.hidden && /导出\s+\d+×\d+/.test(el.textContent || "");
    },
    { timeout: 20000 }
  );

  const preview = await measurePreview(page);
  const layout = preview.canvasBox.layout;
  if (preview.canvasBox.bitmap.w !== layout.outputW || preview.canvasBox.bitmap.h !== layout.outputH) {
    errors.push("canvas bitmap does not match layout");
  }
  assertCloseAspect(preview.canvasBox.css.w, preview.canvasBox.css.h, layout.outputW, layout.outputH, "SBS preview", errors);
  assertCloseAspect(preview.videoBox.css.w, preview.videoBox.css.h, spec.width, spec.height, "source preview", errors);
  assertInside(preview.canvasBox.css, preview.canvasBox.wrap, "SBS canvas", errors);
  assertInside(preview.videoBox.css, preview.videoBox.wrap, "source video", errors);
  assertInViewport(preview.canvasBox.css, preview.canvasBox.viewport, "SBS canvas", errors);
  assertInViewport(preview.videoBox.css, preview.videoBox.viewport, "source video", errors);
  if (!String(preview.canvasBox.dim).includes(layout.outputW + "×" + layout.outputH)) {
    errors.push("dimension label does not match export pixels: " + preview.canvasBox.dim);
  }

  const shotPath = path.join(artifactDir, spec.name + "-preview.png");
  fs.mkdirSync(artifactDir, { recursive: true });
  await page.screenshot({ path: shotPath, fullPage: true });

  const wallStart = Date.now();
  await page.click("#exportWebmBtn");
  await page.waitForFunction(
    () => {
      const text = document.getElementById("statusText").textContent || "";
      return text.includes("已下载") || text.includes("录制失败") || text.includes("无法");
    },
    { timeout: 45000 }
  );
  const wallMs = Date.now() - wallStart;
  const status = await page.evaluate(() => document.getElementById("statusText").textContent);
  if (!status.includes("已下载")) {
    errors.push("export did not finish: " + status + " | " + consoleLines.slice(-8).join(" || "));
  }

  const canvasEdges = await readCanvasEdges(page);
  const canvasEdgeErrors = [];
  for (const sample of canvasEdges) {
    const got = classify(sample.rgb);
    sample.got = got;
    if (got !== sample.expect) {
      canvasEdgeErrors.push(sample.name + " expected " + sample.expect + " got " + got + " rgb=" + sample.rgb.join(","));
    }
  }
  errors.push(...canvasEdgeErrors.map((e) => "preview " + e));
  const downloadMeta = await page.evaluate(async () => {
    const blob = window.__SBS_DEBUG && window.__SBS_DEBUG.lastBlob;
    if (!blob) return { clicked: !!window.__downloadClicked, name: window.__downloadName || "", b64: null, mime: "" };
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return {
      clicked: !!window.__downloadClicked,
      name: window.__downloadName || "",
      mime: blob.type,
      b64: String(dataUrl).split(",")[1],
      debug: {
        recordFrames: window.__SBS_DEBUG.recordFrames,
        framesDrawn: window.__SBS_DEBUG.framesDrawn,
        presentedSkips: window.__SBS_DEBUG.presentedSkips,
        audioTrackCount: window.__SBS_DEBUG.audioTrackCount,
        recordMime: window.__SBS_DEBUG.recordMime,
        lastExport: window.__SBS_DEBUG.lastExport,
      },
    };
  });
  if (!downloadMeta.clicked || !/^naked-eye-3d-sbs\.(mp4|webm)$/.test(downloadMeta.name || "")) {
    errors.push("automatic download was not triggered (" + (downloadMeta.name || "no name") + ")");
  }

  let exportPath = null;
  const stableDeadline = Date.now() + 8000;
  let lastSize = -1;
  while (Date.now() < stableDeadline) {
    const names = fs.readdirSync(downloadDir).filter((n) => !n.endsWith(".crdownload"));
    if (names.length) {
      const candidate = path.join(downloadDir, names[0]);
      const size = fs.statSync(candidate).size;
      if (size > 0 && size === lastSize) {
        exportPath = candidate;
        break;
      }
      lastSize = size;
    }
    await sleep(200);
  }
  const ext = (downloadMeta.mime || "").includes("mp4") ? "mp4" : "webm";
  const blobPath = path.join(outDir, spec.name + "-blob." + ext);
  if (downloadMeta.b64) fs.writeFileSync(blobPath, Buffer.from(downloadMeta.b64, "base64"));
  const analyzedPath = exportPath || blobPath;
  if (!analyzedPath || !fs.existsSync(analyzedPath)) {
    errors.push("no export bytes");
    await page.close();
    return { name: spec.name, errors, preview, status, console: consoleLines };
  }

  const info = await probe(analyzedPath);
  const video = (info.streams || []).find((s) => s.codec_type === "video");
  const audio = (info.streams || []).find((s) => s.codec_type === "audio");
  const width = video ? Number(video.width) : 0;
  const height = video ? Number(video.height) : 0;
  if (width !== layout.outputW || height !== layout.outputH) {
    errors.push("export dimensions " + width + "x" + height + " != layout " + layout.outputW + "x" + layout.outputH);
  }
  const times = await frameTimes(analyzedPath);
  const duration = times.length ? times[times.length - 1] - times[0] : Number(info.format.duration || 0);
  const formatDuration = Number(info.format.duration || duration);
  if (Math.abs(formatDuration - spec.seconds) > 0.45 && Math.abs(duration - spec.seconds) > 0.45) {
    errors.push("duration " + formatDuration.toFixed(3) + "s (frames " + duration.toFixed(3) + "s) vs source " + spec.seconds + "s");
  }
  if (!audio) errors.push("export has no audio stream");
  const volume = audio ? await meanVolume(analyzedPath) : null;
  if (audio && !(volume > -45)) errors.push("audio is silent or too quiet: " + volume + " dB");
  const audioDuration = audio ? Number(audio.duration || formatDuration) : 0;
  if (audio && Math.abs(audioDuration - formatDuration) > 0.5 && audio.duration) {
    errors.push("audio duration " + audioDuration + " vs video " + formatDuration);
  }

  const deltas = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
  deltas.sort((a, b) => a - b);
  const expectedDt = 1 / spec.fps;
  const medianDt = quantile(deltas, 0.5);
  const p95Dt = quantile(deltas, 0.95);
  const maxDt = deltas.length ? deltas[deltas.length - 1] : null;
  if (!times.length) errors.push("export has no video frames");
  const frameRatio = times.length / spec.frames;
  if (frameRatio < 0.7 || frameRatio > 1.35) {
    errors.push("frame count " + times.length + " vs source " + spec.frames + " (ratio " + frameRatio.toFixed(2) + ")");
  }
  if (medianDt && Math.abs(medianDt - expectedDt) / expectedDt > 0.45) {
    errors.push("median frame interval " + medianDt.toFixed(4) + "s vs source " + expectedDt.toFixed(4) + "s");
  }
  if (p95Dt && p95Dt > expectedDt * 3.5) {
    errors.push("p95 frame interval " + p95Dt.toFixed(4) + "s is a stall");
  }
  if (maxDt && maxDt > 0.28) errors.push("max frame gap " + maxDt.toFixed(3) + "s");

  let exportEdges = null;
  if (width && height) {
    const raw = await rawFrame(analyzedPath, width, height);
    exportEdges = checkEdges(raw, width, height, layout);
    errors.push(...exportEdges.errors.map((e) => "export " + e));
    const png = path.join(artifactDir, spec.name + "-export-frame.png");
    await run("ffmpeg", ["-y", "-v", "error", "-i", analyzedPath, "-frames:v", "1", png]);
  }
  const motion = width ? await scanMotion(analyzedPath, width, layout) : null;
  if (motion) {
    if (motion.detected < times.length * 0.9) errors.push("moving bar missing on " + (times.length - motion.detected) + " frames");
    if (motion.backward > 1) errors.push("moving bar went backwards " + motion.backward + " times");
    if (motion.maxJump > 4) errors.push("moving bar jumped " + motion.maxJump + " source frames");
    if (motion.heldRatio > 0.45) {
      errors.push("too many repeated frames (held ratio " + motion.heldRatio.toFixed(2) + ")");
    }
    const expectedLast = spec.frames - 1;
    if (motion.last != null && motion.last < expectedLast * 0.75) {
      errors.push("motion ended early at source frame ~" + motion.last + " / " + expectedLast);
    }
    if (motion.first != null && motion.first > 3) {
      errors.push("motion started late at source frame ~" + motion.first);
    }
  }

  const skips = downloadMeta.debug ? downloadMeta.debug.presentedSkips : null;
  // Headless Chrome can coalesce a few 60fps presentations while the encoder
  // is busy. 24/30fps runs stay at zero. Fail only a large stall.
  if (typeof skips === "number" && skips > spec.frames * 0.4) {
    errors.push("presenter skipped " + skips + " source frames");
  }

  await page.close();
  return {
    name: spec.name,
    source: { width: spec.width, height: spec.height, fps: spec.fps, seconds: spec.seconds, frames: spec.frames },
    layout: {
      content: layout.contentW + "x" + layout.contentH,
      eye: layout.eyeW + "x" + layout.eyeH,
      output: layout.outputW + "x" + layout.outputH,
      shift: layout.shift,
    },
    preview: {
      sourceCss: Math.round(preview.videoBox.css.w) + "x" + Math.round(preview.videoBox.css.h),
      sbsCss: Math.round(preview.canvasBox.css.w) + "x" + Math.round(preview.canvasBox.css.h),
      viewport: preview.canvasBox.viewport,
      fullyInsideViewport: errors.every((e) => !e.includes("phone viewport") && !e.includes("clipped")),
    },
    export: {
      path: path.basename(analyzedPath),
      fromBrowserDownload: Boolean(exportPath),
      mime: downloadMeta.mime,
      downloadName: downloadMeta.name,
      width,
      height,
      duration: Number(formatDuration.toFixed(3)),
      frames: times.length,
      medianFrameSec: medianDt && Number(medianDt.toFixed(4)),
      p95FrameSec: p95Dt && Number(p95Dt.toFixed(4)),
      maxGapSec: maxDt && Number(maxDt.toFixed(4)),
      audio: audio
        ? { codec: audio.codec_name, duration: audioDuration, meanVolumeDb: volume }
        : null,
      motion,
      wallMs,
      debug: downloadMeta.debug || null,
    },
    canvasEdgeErrors,
    errors,
    status,
  };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const specs = [];
  for (const spec of CASES) specs.push(await makeFixture(spec));
  const port = 9877;
  const server = await startServer(port);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
  const results = [];
  try {
    for (const spec of specs) {
      console.log("case", spec.name);
      results.push(await runCase(browser, port, spec));
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  const report = {
    testedOn: "headless Chrome desktop, 390x844 CSS viewport, not a physical phone",
    results,
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  let failed = 0;
  for (const result of results) {
    console.log("\n== " + result.name + " ==");
    console.log(JSON.stringify({ layout: result.layout, preview: result.preview, export: result.export }, null, 2));
    if (result.errors && result.errors.length) {
      failed++;
      console.log("FAILURES:");
      for (const err of result.errors) console.log(" - " + err);
    } else {
      console.log("ok");
    }
  }
  if (failed) {
    console.error("\n" + failed + " case(s) failed");
    process.exit(1);
  }
  console.log("\nall export cases passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
