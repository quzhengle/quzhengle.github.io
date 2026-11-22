/**
 * 裸眼3D — full SBS (左右并排) only.
 * Upload a video, preview both eyes with the full frame visible, record once
 * through to the end, and download. Disparity strength is fixed at 8.
 *
 * Frame path: one canvas, drawn only when the video presents a new frame
 * (requestVideoFrameCallback, with a currentTime guard). Recording uses
 * captureStream(0) + requestFrame so each source frame is one output frame
 * instead of a fixed 30fps resample.
 */
(function () {
  "use strict";

  var PREVIEW_MAX_VH = 0.36;

  var els = {
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("fileInput"),
    pickBtn: document.getElementById("pickBtn"),
    uploadSection: document.getElementById("uploadSection"),
    workspace: document.getElementById("workspace"),
    sourceVideo: document.getElementById("sourceVideo"),
    outputCanvas: document.getElementById("outputCanvas"),
    canvasWrap: document.getElementById("canvasWrap"),
    previewOverlay: document.getElementById("previewOverlay"),
    playOverlay: document.getElementById("playOverlay"),
    playBtn: document.getElementById("playBtn"),
    regenBtn: document.getElementById("regenBtn"),
    exportWebmBtn: document.getElementById("exportWebmBtn"),
    changeVideoBtn: document.getElementById("changeVideoBtn"),
    statusText: document.getElementById("statusText"),
    progressBar: document.getElementById("progressBar"),
    progressFill: document.getElementById("progressFill"),
    dimReadout: document.getElementById("dimReadout"),
  };

  var state = {
    strength: SBSCore.STRENGTH,
    playing: false,
    rafId: null,
    videoFrameCallbackId: null,
    objectUrl: null,
    recording: false,
    recordStarting: false,
    mediaRecorder: null,
    recordedChunks: [],
    recordMime: "",
    outCtx: null,
    layout: null,
    audioCtx: null,
    mediaSource: null,
    audioDest: null,
    speakGain: null,
    captureTrack: null,
    recordStream: null,
    lastMediaTime: -1,
    lastPresentedFrames: -1,
    presentedSkips: 0,
    framesDrawn: 0,
    recordFrames: 0,
    recordStartedAt: 0,
    audioTrackCount: 0,
  };

  function setStatus(msg, kind) {
    els.statusText.textContent = msg || "";
    els.statusText.className = "status" + (kind ? " " + kind : "");
  }

  function setProgress(pct) {
    if (pct == null) {
      els.progressBar.hidden = true;
      els.progressFill.style.width = "0%";
      return;
    }
    els.progressBar.hidden = false;
    els.progressFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  }

  function openPicker() {
    els.fileInput.click();
  }

  els.pickBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    openPicker();
  });
  els.dropzone.addEventListener("click", openPicker);
  els.dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  });

  els.fileInput.addEventListener("change", function () {
    var file = els.fileInput.files && els.fileInput.files[0];
    if (file) loadVideo(file);
  });

  ["dragenter", "dragover"].forEach(function (ev) {
    els.dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    els.dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.remove("dragover");
    });
  });
  els.dropzone.addEventListener("drop", function (e) {
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.indexOf("video/") === 0) loadVideo(file);
    else setStatus("请拖入视频文件", "error");
  });

  function loadVideo(file) {
    if (state.recording || state.recordStarting) stopRecording(true);
    cleanupObjectUrl();
    state.objectUrl = URL.createObjectURL(file);
    var v = els.sourceVideo;
    stopFrameLoop();
    v.muted = true;
    v.playsInline = true;
    v.loop = true;
    v.preload = "auto";
    v.src = state.objectUrl;
    v.load();
    setStatus("正在加载视频…");
    setProgress(null);

    var onReady = function () {
      v.removeEventListener("loadeddata", onReady);
      if (!v.videoWidth || !v.videoHeight) {
        setStatus("读不到视频画面尺寸", "error");
        return;
      }
      els.uploadSection.hidden = true;
      els.workspace.hidden = false;
      state.framesDrawn = 0;
      state.lastMediaTime = -1;
      state.lastPresentedFrames = -1;
      state.presentedSkips = 0;
      setupCanvases();
      drawFrame();
      queueFit();
      var name = file.name || "未命名";
      setStatus("视频已加载 · " + name + " · 全宽 SBS · 四边完整 · 点击播放", "ok");
      showOverlay(true);
    };
    v.addEventListener("loadeddata", onReady);
    v.addEventListener("error", function () {
      setStatus("视频加载失败，请换一种格式试试", "error");
    });
  }

  function cleanupObjectUrl() {
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
  }

  function setupCanvases() {
    var v = els.sourceVideo;
    var vw = v.videoWidth;
    var vh = v.videoHeight;
    if (!vw || !vh) return;
    var layout = SBSCore.computeLayout(vw, vh);
    state.layout = layout;
    var canvas = els.outputCanvas;
    if (canvas.width !== layout.outputW || canvas.height !== layout.outputH) {
      canvas.width = layout.outputW;
      canvas.height = layout.outputH;
    }
    state.outCtx = canvas.getContext("2d", { alpha: false });
    canvas.dataset.exportWidth = String(layout.outputW);
    canvas.dataset.exportHeight = String(layout.outputH);
    updateDimReadout();
    fitPreviews();
  }

  function updateDimReadout() {
    var layout = state.layout;
    var v = els.sourceVideo;
    if (!layout || !els.dimReadout) return;
    els.dimReadout.hidden = false;
    els.dimReadout.textContent =
      "导出 " +
      layout.outputW +
      "×" +
      layout.outputH +
      " · 每眼 " +
      layout.eyeW +
      "×" +
      layout.eyeH +
      "（画面 " +
      layout.contentW +
      "×" +
      layout.contentH +
      " + 视差黑边）· 原片 " +
      v.videoWidth +
      "×" +
      v.videoHeight +
      " · 预览宽高比与导出一致";
  }

  function fitElement(el, pixelW, pixelH) {
    var wrap = el.parentElement;
    if (!wrap || !pixelW || !pixelH) return;
    var maxW = wrap.clientWidth;
    if (!maxW) return;
    var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    var maxH = Math.max(120, Math.floor(vh * PREVIEW_MAX_VH));
    var scale = Math.min(maxW / pixelW, maxH / pixelH);
    var cssW = Math.max(2, Math.floor(pixelW * scale));
    var cssH = Math.max(2, Math.round((cssW * pixelH) / pixelW));
    if (cssH > maxH) {
      cssH = maxH;
      cssW = Math.max(2, Math.round((cssH * pixelW) / pixelH));
    }
    if (cssW > maxW) {
      cssW = maxW;
      cssH = Math.max(2, Math.round((cssW * pixelH) / pixelW));
    }
    el.style.width = cssW + "px";
    el.style.height = cssH + "px";
    el.style.maxWidth = "100%";
    el.style.objectFit = "contain";
    wrap.style.height = cssH + "px";
  }

  function fitPreviews() {
    var v = els.sourceVideo;
    if (v.videoWidth && v.videoHeight) {
      fitElement(v, v.videoWidth, v.videoHeight);
    }
    var canvas = els.outputCanvas;
    if (canvas.width && canvas.height && state.layout) {
      fitElement(canvas, canvas.width, canvas.height);
    }
  }

  var fitQueued = false;
  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(function () {
      fitQueued = false;
      if (!els.workspace.hidden) fitPreviews();
    });
  }

  window.addEventListener("resize", queueFit);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", queueFit);
  }

  function drawFrame() {
    var v = els.sourceVideo;
    var layout = state.layout;
    var ctx = state.outCtx;
    if (!layout || !ctx || !v.videoWidth || !v.videoHeight) return;
    SBSCore.drawSBS(ctx, v, v.videoWidth, v.videoHeight, layout);
    state.framesDrawn += 1;
    if (
      state.recording &&
      state.captureTrack &&
      typeof state.captureTrack.requestFrame === "function"
    ) {
      state.recordFrames += 1;
      try {
        state.captureTrack.requestFrame();
      } catch (err) {
        /* track may already be stopped */
      }
    }
  }

  function stopFrameLoop() {
    state.playing = false;
    if (state.rafId != null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    var v = els.sourceVideo;
    if (state.videoFrameCallbackId != null && v && typeof v.cancelVideoFrameCallback === "function") {
      try {
        v.cancelVideoFrameCallback(state.videoFrameCallbackId);
      } catch (err) {}
    }
    state.videoFrameCallbackId = null;
  }

  function scheduleFrame() {
    if (!state.playing) return;
    var v = els.sourceVideo;
    if (typeof v.requestVideoFrameCallback === "function") {
      state.videoFrameCallbackId = v.requestVideoFrameCallback(function (_now, metadata) {
        state.videoFrameCallbackId = null;
        handlePresentedFrame(metadata);
      });
      return;
    }
    state.rafId = requestAnimationFrame(function () {
      state.rafId = null;
      handlePresentedFrame(null);
    });
  }

  function handlePresentedFrame(metadata) {
    if (!state.playing) return;
    // Re-arm before drawing so a slow blit cannot skip the next callback slot.
    scheduleFrame();
    var v = els.sourceVideo;
    if (metadata && typeof metadata.presentedFrames === "number") {
      if (metadata.presentedFrames === state.lastPresentedFrames) return;
      if (
        state.lastPresentedFrames >= 0 &&
        metadata.presentedFrames > state.lastPresentedFrames + 1
      ) {
        state.presentedSkips += metadata.presentedFrames - state.lastPresentedFrames - 1;
      }
      state.lastPresentedFrames = metadata.presentedFrames;
    }
    var mediaTime =
      metadata && isFinite(metadata.mediaTime) ? metadata.mediaTime : v.currentTime;
    if (Math.abs(mediaTime - state.lastMediaTime) < 1e-4) return;
    state.lastMediaTime = mediaTime;
    drawFrame();
  }

  function startFrameLoop() {
    stopFrameLoop();
    state.playing = true;
    scheduleFrame();
  }

  function primeAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!state.audioCtx) state.audioCtx = new AC();
    if (state.audioCtx.state === "suspended") {
      state.audioCtx.resume().catch(function () {});
    }
    return state.audioCtx;
  }

  function ensureAudioGraph() {
    var v = els.sourceVideo;
    primeAudio();
    if (!state.audioCtx) return null;
    if (!state.mediaSource) {
      try {
        state.mediaSource = state.audioCtx.createMediaElementSource(v);
      } catch (err) {
        return null;
      }
      state.audioDest = state.audioCtx.createMediaStreamDestination();
      state.speakGain = state.audioCtx.createGain();
      state.speakGain.gain.value = 1;
      state.mediaSource.connect(state.audioDest);
      state.mediaSource.connect(state.speakGain);
      state.speakGain.connect(state.audioCtx.destination);
    }
    if (state.speakGain) state.speakGain.gain.value = 1;
    return state.audioDest;
  }

  function enablePreviewAudio() {
    var v = els.sourceVideo;
    v.muted = false;
    v.volume = 1;
    ensureAudioGraph();
    if (state.audioCtx && state.audioCtx.state === "suspended") {
      return state.audioCtx.resume().catch(function () {});
    }
    return Promise.resolve();
  }

  function play() {
    if (state.recording || state.recordStarting) return;
    enablePreviewAudio()
      .then(function () {
        return els.sourceVideo.play();
      })
      .then(function () {
        state.lastMediaTime = -1;
        state.lastPresentedFrames = -1;
        startFrameLoop();
        els.playBtn.textContent = "❚❚ 暂停";
        showOverlay(false);
        setStatus("正在播放全宽 SBS 预览（含声音）…");
      })
      .catch(function () {
        setStatus("播放受阻，请再点一次播放（需允许声音）", "error");
        showOverlay(true);
      });
  }

  function pause() {
    els.sourceVideo.pause();
    stopFrameLoop();
    drawFrame();
    els.playBtn.textContent = "▶ 播放";
    showOverlay(true);
    if (!state.recording) setStatus("已暂停");
  }

  function togglePlay() {
    if (state.recording || state.recordStarting) return;
    if (state.playing) pause();
    else play();
  }

  function showOverlay(show) {
    els.previewOverlay.classList.toggle("visible", !!show);
  }

  els.playBtn.addEventListener("click", togglePlay);
  els.playOverlay.addEventListener("click", function (e) {
    e.stopPropagation();
    togglePlay();
  });
  els.canvasWrap.addEventListener("click", function (e) {
    if (e.target.closest(".play-overlay") || e.target.closest(".btn-icon")) return;
    togglePlay();
  });

  els.regenBtn.addEventListener("click", function () {
    if (state.recording || state.recordStarting) return;
    if (els.sourceVideo.videoWidth) setupCanvases();
    drawFrame();
    setStatus("已重新渲染全宽 SBS", "ok");
  });

  els.changeVideoBtn.addEventListener("click", function () {
    if (state.recording || state.recordStarting) stopRecording(true);
    else {
      els.sourceVideo.pause();
      stopFrameLoop();
    }
    els.workspace.hidden = true;
    els.uploadSection.hidden = false;
    els.fileInput.value = "";
    cleanupObjectUrl();
    els.sourceVideo.removeAttribute("src");
    els.sourceVideo.load();
    state.layout = null;
    if (els.dimReadout) {
      els.dimReadout.hidden = true;
      els.dimReadout.textContent = "";
    }
    setStatus("");
    setProgress(null);
  });

  els.exportWebmBtn.addEventListener("click", function () {
    if (state.recording || state.recordStarting) return;
    startRecording().catch(function (err) {
      setStatus("录制失败：" + ((err && err.message) || "未知错误"), "error");
      resetRecordUi();
    });
  });

  function pickMimeType() {
    // Prefer H.264 in MP4 when the browser actually supports it (Photos and
    // 3D players). A bare video/mp4 match can be VP9. AAC is included when
    // the browser advertises it; otherwise the browser picks the audio codec.
    var candidates = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1.4D001E,mp4a.40.2",
      "video/mp4;codecs=avc1.640028,mp4a.40.2",
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=avc1",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidates[i])) {
        return candidates[i];
      }
    }
    return "";
  }

  function attachAudioTracks(stream) {
    var added = 0;
    if (state.audioDest) {
      state.audioDest.stream.getAudioTracks().forEach(function (t) {
        try {
          stream.addTrack(t);
          added += 1;
        } catch (err) {}
      });
    }
    if (!added) {
      var v = els.sourceVideo;
      try {
        var cap =
          typeof v.captureStream === "function"
            ? v.captureStream()
            : typeof v.mozCaptureStream === "function"
              ? v.mozCaptureStream()
              : null;
        if (cap) {
          cap.getAudioTracks().forEach(function (t) {
            try {
              stream.addTrack(t);
              added += 1;
            } catch (err) {}
          });
        }
      } catch (err) {}
    }
    return added;
  }

  function seekTo(video, time) {
    if (Math.abs(video.currentTime - time) < 0.001) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("seeked", finish);
        resolve();
      }
      var timer = setTimeout(finish, 2000);
      video.addEventListener("seeked", finish);
      try {
        video.currentTime = time;
      } catch (err) {
        finish();
      }
    });
  }

  function resetRecordUi() {
    state.recording = false;
    state.recordStarting = false;
    state._stopping = false;
    els.exportWebmBtn.disabled = false;
    els.exportWebmBtn.textContent = "保存到系统相册";
    if (state._recordSafety) {
      clearTimeout(state._recordSafety);
      state._recordSafety = null;
    }
    if (state._progressTimer) {
      clearInterval(state._progressTimer);
      state._progressTimer = null;
    }
  }

  function clearRecordWatchers() {
    if (state._recordSafety) {
      clearTimeout(state._recordSafety);
      state._recordSafety = null;
    }
    if (state._progressTimer) {
      clearInterval(state._progressTimer);
      state._progressTimer = null;
    }
    if (state._onEnded) {
      els.sourceVideo.removeEventListener("ended", state._onEnded);
      state._onEnded = null;
    }
  }

  async function startRecording() {
    if (state.recording || state.recordStarting) return;
    if (typeof MediaRecorder === "undefined") {
      setStatus("当前浏览器不支持视频录制，无法下载", "error");
      return;
    }
    var v = els.sourceVideo;
    if (!v.videoWidth) {
      setStatus("请先上传视频", "error");
      return;
    }
    var mime = pickMimeType();
    if (!mime) {
      setStatus("无法找到可用的录制编码，无法下载", "error");
      return;
    }

    state.recordStarting = true;
    state._abortRecord = false;
    els.exportWebmBtn.disabled = true;
    els.exportWebmBtn.textContent = "正在录制，完成后自动下载…";

    // Stay inside the click turn until play() is invoked so mobile
    // browsers allow audible playback.
    primeAudio();
    v.muted = false;
    v.volume = 1;
    v.playbackRate = 1;
    state._prevLoop = v.loop;
    v.loop = false;
    stopFrameLoop();

    try {
      await v.play();
    } catch (err) {
      resetRecordUi();
      v.loop = state._prevLoop !== false;
      setStatus("无法开始播放，请再点一次（需允许声音）", "error");
      return;
    }
    if (state._abortRecord) {
      resetRecordUi();
      return;
    }
    v.pause();
    ensureAudioGraph();
    if (state.speakGain) state.speakGain.gain.value = 1;

    await seekTo(v, 0);
    if (state._abortRecord) {
      resetRecordUi();
      return;
    }
    setupCanvases();
    // Draw the first frame before opening the capture track so the bitmap
    // is not empty, then again after the recorder is running.
    drawFrame();

    var canvasStream = els.outputCanvas.captureStream(0);
    var videoTrack = canvasStream.getVideoTracks()[0];
    if (!videoTrack) {
      resetRecordUi();
      v.loop = state._prevLoop !== false;
      setStatus("无法捕获画面", "error");
      return;
    }
    if ("contentHint" in videoTrack) videoTrack.contentHint = "motion";
    state.captureTrack = videoTrack;

    var stream = new MediaStream();
    stream.addTrack(videoTrack);
    var audioCount = attachAudioTracks(stream);
    state.audioTrackCount = audioCount;
    state.recordStream = stream;

    var pixels = state.layout.outputW * state.layout.outputH;
    var videoBits = Math.round(Math.min(8000000, Math.max(2500000, pixels * 4)));
    var recOpts = { mimeType: mime, videoBitsPerSecond: videoBits };
    if (audioCount) recOpts.audioBitsPerSecond = 128000;

    var recorder;
    try {
      recorder = new MediaRecorder(stream, recOpts);
    } catch (err) {
      try {
        recorder = new MediaRecorder(stream, { mimeType: mime });
      } catch (err2) {
        resetRecordUi();
        state.captureTrack = null;
        v.loop = state._prevLoop !== false;
        setStatus("无法开始录制：" + (err2.message || err.message || "未知错误"), "error");
        return;
      }
    }

    state.recordedChunks = [];
    state.recordMime = mime;
    state.mediaRecorder = recorder;
    recorder.ondataavailable = function (e) {
      if (e.data && e.data.size) state.recordedChunks.push(e.data);
    };
    recorder.onerror = function () {
      setStatus("录制出错，请重试", "error");
      stopRecording(true);
    };
    recorder.onstop = function () {
      var type = (state.recordMime || mime).split(";")[0];
      var blob = new Blob(state.recordedChunks, { type: type });
      var ext = type.indexOf("mp4") >= 0 ? "mp4" : "webm";
      var cancelled = state._discardRecording;
      state._discardRecording = false;
      var wall = state.recordStartedAt ? Date.now() - state.recordStartedAt : 0;
      if (!cancelled && blob.size) {
        if (window.__SBS_DEBUG && location.search.indexOf("debug=1") >= 0) {
          window.__SBS_DEBUG.lastBlob = blob;
        }
        downloadBlob(blob, "naked-eye-3d-sbs." + ext);
        setStatus(
          "已下载 " +
            formatBytes(blob.size) +
            (audioCount ? "（含原声音轨）" : "（无音轨）") +
            " · 浏览器不能直接写入「照片」，请用系统分享或「文件」存入相册",
          "ok"
        );
      }
      setProgress(null);
      try {
        if (videoTrack.readyState === "live") videoTrack.stop();
      } catch (err) {}
      state.captureTrack = null;
      state.recordStream = null;
      state.recordStartedAt = 0;
      v.loop = state._prevLoop !== false;
      resetRecordUi();
      if (window.__SBS_DEBUG) {
        window.__SBS_DEBUG.lastExport = {
          bytes: blob.size,
          mime: type,
          wallMs: wall,
          recordFrames: state.recordFrames,
          audioTracks: audioCount,
          discarded: !!cancelled,
        };
      }
    };

    state.recording = true;
    state._stopping = false;
    state._discardRecording = false;
    state.recordFrames = 0;
    state.recordStartedAt = Date.now();
    try {
      recorder.start();
    } catch (err) {
      state.recording = false;
      resetRecordUi();
      state.captureTrack = null;
      v.loop = state._prevLoop !== false;
      setStatus("录制启动失败：" + (err.message || "未知错误"), "error");
      return;
    }

    // Capture t=0 now that the recorder is listening.
    state.lastMediaTime = -1;
    state.lastPresentedFrames = -1;
    drawFrame();
    state.lastMediaTime = v.currentTime || 0;

    setStatus(
      audioCount
        ? "正在从片头录到片尾（含音频），结束后自动下载，无需再点"
        : "正在从片头录到片尾（没有挂上音轨），结束后自动下载，无需再点"
    );
    setProgress(0);

    var duration = v.duration;
    var onEnded = function () {
      v.removeEventListener("ended", onEnded);
      state._onEnded = null;
      finishRecordingSoon();
    };
    state._onEnded = onEnded;
    v.addEventListener("ended", onEnded);

    var progressTimer = setInterval(function () {
      if (!state.recording) {
        clearInterval(progressTimer);
        return;
      }
      if (duration && isFinite(duration) && duration > 0) {
        setProgress((v.currentTime / duration) * 100);
        // Do not stop early. Only finish if playback itself has ended.
        if (v.ended || (v.paused && v.currentTime >= Math.max(0, duration - 0.001))) {
          clearInterval(progressTimer);
          finishRecordingSoon();
        }
      }
    }, 200);
    state._progressTimer = progressTimer;

    state._recordSafety = setTimeout(function () {
      if (state.recording) stopRecording(false);
    }, 180000);

    startFrameLoop();
    try {
      await v.play();
    } catch (err) {
      setStatus("录制时无法继续播放，请再点一次", "error");
      stopRecording(true);
    }
  }

  function finishRecordingSoon() {
    if (!state.recording || state._stopping || state._finishTimer) return;
    // One extra beat so the last presented frame is requested before stop.
    state._finishTimer = setTimeout(function () {
      state._finishTimer = null;
      stopRecording(false);
    }, 120);
  }

  function stopRecording(discard) {
    if (state._finishTimer) {
      clearTimeout(state._finishTimer);
      state._finishTimer = null;
    }
    if (!state.recording && !state.recordStarting) return;
    if (state._stopping) return;
    state._stopping = true;
    state._abortRecord = true;
    if (discard) state._discardRecording = true;
    clearRecordWatchers();
    var v = els.sourceVideo;
    if (state.recording && state.outCtx) {
      try {
        drawFrame();
      } catch (err) {}
    }
    var rec = state.mediaRecorder;
    v.pause();
    stopFrameLoop();
    els.playBtn.textContent = "▶ 播放";
    showOverlay(true);
    if (rec && rec.state === "recording") {
      try {
        rec.stop();
        return;
      } catch (err) {}
    }
    resetRecordUi();
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  window.__SBS_DEBUG = {
    get layout() {
      return state.layout;
    },
    get framesDrawn() {
      return state.framesDrawn;
    },
    get recordFrames() {
      return state.recordFrames;
    },
    get recording() {
      return state.recording;
    },
    get strength() {
      return state.strength;
    },
    get presentedSkips() {
      return state.presentedSkips;
    },
    get audioTrackCount() {
      return state.audioTrackCount;
    },
    get recordMime() {
      return state.recordMime;
    },
    lastExport: null,
  };

  setStatus("");
})();
