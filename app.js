/**
 * 裸眼3D — SBS (左右并排) only
 * Client-side stereo via horizontal shift + side-by-side compose.
 */
(function () {
  "use strict";

  const MAX_PROCESS_WIDTH = 960;

  const els = {
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
  };

  const state = {
    strength: 8, // fixed recommended comfortable value — no slider
    playing: false,
    rafId: null,
    objectUrl: null,
    recording: false,
    mediaRecorder: null,
    recordedChunks: [],
    leftCanvas: null,
    rightCanvas: null,
    leftCtx: null,
    rightCtx: null,
    outCtx: null,
    processW: 0,
    processH: 0,
    // Audio graph for reliable MediaRecorder soundtrack
    audioCtx: null,
    mediaSource: null,
    audioDest: null,
    speakGain: null,
    recordStream: null,
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

  // —— Upload ——
  function openPicker() {
    els.fileInput.click();
  }

  els.pickBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openPicker();
  });
  els.dropzone.addEventListener("click", openPicker);
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  });

  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (file) loadVideo(file);
  });

  ["dragenter", "dragover"].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.remove("dragover");
    });
  });
  els.dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) loadVideo(file);
    else setStatus("请拖入视频文件", "error");
  });

  function loadVideo(file) {
    cleanupObjectUrl();
    state.objectUrl = URL.createObjectURL(file);
    const v = els.sourceVideo;
    v.src = state.objectUrl;
    v.muted = true;
    v.playsInline = true;
    v.load();
    setStatus("正在加载视频…");

    const onReady = () => {
      v.removeEventListener("loadeddata", onReady);
      els.uploadSection.hidden = true;
      els.workspace.hidden = false;
      setupCanvases();
      drawFrame();
      setStatus(
        "视频已加载 · " + (file.name || "未命名") + " · SBS 左右并排 · 点击播放",
        "ok"
      );
      showOverlay(true);
    };
    v.addEventListener("loadeddata", onReady);
    v.addEventListener("error", () => {
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
    const v = els.sourceVideo;
    const vw = v.videoWidth || 640;
    const vh = v.videoHeight || 360;
    let w = vw;
    let h = vh;
    if (w > MAX_PROCESS_WIDTH) {
      const scale = MAX_PROCESS_WIDTH / w;
      w = Math.round(MAX_PROCESS_WIDTH);
      h = Math.round(vh * scale);
    }
    w = w - (w % 2);
    h = h - (h % 2);
    if (w < 2) w = 2;
    if (h < 2) h = 2;

    state.processW = w;
    state.processH = h;

    state.leftCanvas = document.createElement("canvas");
    state.rightCanvas = document.createElement("canvas");
    state.leftCanvas.width = w;
    state.leftCanvas.height = h;
    state.rightCanvas.width = w;
    state.rightCanvas.height = h;
    state.leftCtx = state.leftCanvas.getContext("2d");
    state.rightCtx = state.rightCanvas.getContext("2d");

    const out = els.outputCanvas;
    out.width = w * 2;
    out.height = h;
    state.outCtx = out.getContext("2d", { alpha: false });
  }

  function shiftAmount() {
    // Fixed strength 8 → recommended comfortable L/R parallax for SBS
    return Math.round((state.strength / 40) * (state.processW * 0.06));
  }

  function renderLeftRight() {
    const v = els.sourceVideo;
    if (!v.videoWidth) return;
    const w = state.processW;
    const h = state.processH;
    const shift = shiftAmount();

    state.leftCtx.fillStyle = "#000";
    state.leftCtx.fillRect(0, 0, w, h);
    state.rightCtx.fillStyle = "#000";
    state.rightCtx.fillRect(0, 0, w, h);

    state.leftCtx.drawImage(v, 0, 0, w, h, shift, 0, w, h);
    state.rightCtx.drawImage(v, 0, 0, w, h, -shift, 0, w, h);
  }

  function composeSBS() {
    const ctx = state.outCtx;
    const w = state.processW;
    const h = state.processH;
    ctx.drawImage(state.leftCanvas, 0, 0, w, h);
    ctx.drawImage(state.rightCanvas, w, 0, w, h);
  }

  function drawFrame() {
    const v = els.sourceVideo;
    if (!v.videoWidth || !state.leftCtx) return;
    renderLeftRight();
    composeSBS();
  }

  function loop() {
    if (!state.playing) return;
    drawFrame();
    state.rafId = requestAnimationFrame(loop);
  }

  /** Unmute + open speaker path (GainNode=1). Call on user play gesture. */
  async function enablePreviewAudio() {
    const v = els.sourceVideo;
    v.muted = false;
    v.volume = 1;
    await ensureAudioGraph();
    if (state.speakGain) {
      state.speakGain.gain.value = 1;
    }
    if (state.audioCtx && state.audioCtx.state === "suspended") {
      try {
        await state.audioCtx.resume();
      } catch (_) {}
    }
  }

  function play() {
    enablePreviewAudio()
      .catch(() => {})
      .then(() => els.sourceVideo.play())
      .then(() => {
        state.playing = true;
        els.playBtn.textContent = "❚❚ 暂停";
        showOverlay(false);
        cancelAnimationFrame(state.rafId);
        state.rafId = requestAnimationFrame(loop);
        setStatus("正在播放 SBS 预览…");
      })
      .catch(() => {
        setStatus("播放受阻，请再点一次播放（需允许声音）", "error");
        showOverlay(true);
      });
  }

  function pause() {
    els.sourceVideo.pause();
    state.playing = false;
    els.playBtn.textContent = "▶ 播放";
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
    drawFrame();
    showOverlay(true);
    setStatus("已暂停");
  }

  function togglePlay() {
    if (state.playing) pause();
    else play();
  }

  function showOverlay(show) {
    els.previewOverlay.classList.toggle("visible", !!show);
  }

  els.playBtn.addEventListener("click", togglePlay);
  els.playOverlay.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlay();
  });
  els.canvasWrap.addEventListener("click", (e) => {
    if (e.target.closest(".play-overlay") || e.target.closest(".btn-icon")) return;
    togglePlay();
  });

  els.regenBtn.addEventListener("click", () => {
    if (els.sourceVideo.videoWidth) setupCanvases();
    drawFrame();
    setStatus("已重新渲染 SBS", "ok");
  });

  els.changeVideoBtn.addEventListener("click", () => {
    pause();
    els.workspace.hidden = true;
    els.uploadSection.hidden = false;
    els.fileInput.value = "";
    cleanupObjectUrl();
    els.sourceVideo.removeAttribute("src");
    els.sourceVideo.load();
    setStatus("");
    setProgress(null);
  });

  // —— Save to album (MediaRecorder download) ——
  els.exportWebmBtn.addEventListener("click", () => {
    // One tap: record to the end, then download automatically. No second click.
    if (state.recording) return;
    startRecording();
  });

  function pickMimeType() {
    const candidates = [
      "video/mp4",
      "video/mp4;codecs=avc1",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
        return t;
      }
    }
    return "";
  }

  /**
   * Web Audio tap for export: MediaElementSource → MediaStreamDestination
   * and → speakGain → speakers. Initial load stays muted; user play sets
   * muted=false and speakGain=1 so the page is audible.
   */
  async function ensureAudioGraph() {
    const v = els.sourceVideo;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    if (!state.audioCtx) {
      state.audioCtx = new AC();
    }
    if (state.audioCtx.state === "suspended") {
      try {
        await state.audioCtx.resume();
      } catch (_) {}
    }

    if (!state.mediaSource) {
      try {
        state.mediaSource = state.audioCtx.createMediaElementSource(v);
      } catch (err) {
        // Already connected in a prior session, or unsupported
        console.warn("createMediaElementSource failed", err);
        return null;
      }
      state.audioDest = state.audioCtx.createMediaStreamDestination();
      state.speakGain = state.audioCtx.createGain();
      state.speakGain.gain.value = 1; // audible preview; still taps dest for export
      state.mediaSource.connect(state.audioDest);
      state.mediaSource.connect(state.speakGain);
      state.speakGain.connect(state.audioCtx.destination);
    }
    return state.audioDest;
  }

  function attachAudioTracks(recordStream) {
    let added = 0;
    // Primary: AudioContext destination tracks (cloned so stop() won't kill graph)
    if (state.audioDest) {
      state.audioDest.stream.getAudioTracks().forEach((t) => {
        try {
          recordStream.addTrack(t.clone());
          added++;
        } catch (_) {}
      });
    }
    // Fallback: media element captureStream (needs unmuted + playing)
    if (!added) {
      const v = els.sourceVideo;
      try {
        const cap =
          typeof v.captureStream === "function"
            ? v.captureStream()
            : typeof v.mozCaptureStream === "function"
              ? v.mozCaptureStream()
              : null;
        if (cap) {
          cap.getAudioTracks().forEach((t) => {
            try {
              recordStream.addTrack(t.clone());
              added++;
            } catch (_) {}
          });
        }
      } catch (_) {}
    }
    return added;
  }

  async function startRecording() {
    if (typeof MediaRecorder === "undefined") {
      setStatus("当前浏览器不支持视频录制，无法保存到相册", "error");
      return;
    }
    const mime = pickMimeType();
    if (!mime) {
      setStatus("无法找到可用的录制编码，无法保存到相册", "error");
      return;
    }

    drawFrame();
    const stream = els.outputCanvas.captureStream(30);
    state.recordStream = stream;

    const v = els.sourceVideo;
    // Unmute so MediaElementSource / captureStream carry samples; speakers on.
    v.muted = false;
    v.volume = 1;

    await ensureAudioGraph();
    if (state.speakGain) state.speakGain.gain.value = 1;
    const audioCount = attachAudioTracks(stream);
    if (!audioCount) {
      setStatus("警告：未能挂载音轨，将仅保存画面…");
    }

    state.recordedChunks = [];
    const recOpts = {
      mimeType: mime,
      videoBitsPerSecond: 4_000_000,
    };
    if (audioCount) {
      recOpts.audioBitsPerSecond = 128_000;
    }
    try {
      state.mediaRecorder = new MediaRecorder(stream, recOpts);
    } catch (err) {
      // Retry without explicit audio bitrate if mime+audio combo fails
      try {
        state.mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
      } catch (err2) {
        setStatus("无法开始录制：" + (err2.message || err.message || "未知错误"), "error");
        v.muted = true;
        return;
      }
    }

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) state.recordedChunks.push(e.data);
    };
    state.mediaRecorder.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type: mime.split(";")[0] });
      const ext = mime.includes("mp4") ? "mp4" : "webm";
      downloadBlob(blob, "naked-eye-3d-sbs." + ext);
      setStatus(
        "已保存 · " +
          formatBytes(blob.size) +
          (audioCount ? "（含音频）" : "（无音频）") +
          " · 请在下载/文件中打开并存入相册",
        "ok"
      );
      setProgress(null);
      els.exportWebmBtn.disabled = false;
      els.exportWebmBtn.textContent = "保存到系统相册";
      state.recording = false;
      state._stopping = false;
      v.loop = state._prevLoop !== false;
      // Stop only tracks we own on the record stream (cloned audio + canvas video)
      try {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch (_) {}
        });
      } catch (_) {}
      state.recordStream = null;
      // Restore muted preview so autoplay policies stay happy
      v.muted = true;
    };

    state.recording = true;
    state._stopping = false;
    els.exportWebmBtn.disabled = true;
    els.exportWebmBtn.textContent = "正在录制，完成后自动保存…";
    setStatus(
      audioCount
        ? "正在录制整段视频（含音频），结束后自动下载，无需再次点击"
        : "正在录制整段视频（无音轨），结束后自动下载，无需再次点击"
    );
    setProgress(0);

    // loop would prevent reaching the end / firing "ended"
    state._prevLoop = v.loop;
    v.loop = false;

    const duration = v.duration;
    const onEnded = () => {
      v.removeEventListener("ended", onEnded);
      if (state.recording) stopRecording();
    };
    v.addEventListener("ended", onEnded);
    state._onEnded = onEnded;

    const beginPlayback = () => {
      const begin = () => {
        try {
          if (state.mediaRecorder.state === "inactive") {
            state.mediaRecorder.start(200);
          }
        } catch (err) {
          setStatus("录制启动失败：" + (err.message || "未知错误"), "error");
          state.recording = false;
          state._stopping = false;
          els.exportWebmBtn.disabled = false;
          els.exportWebmBtn.textContent = "保存到系统相册";
          v.loop = true;
          v.muted = true;
          v.removeEventListener("ended", onEnded);
          return;
        }
        if (!state.playing) play();
      };
      v.play()
        .then(begin)
        .catch(() => begin());
    };

    const onSeeked = () => {
      v.removeEventListener("seeked", onSeeked);
      beginPlayback();
    };
    // Seeking to 0 does not fire "seeked" if already at the start.
    if (!v.currentTime || v.currentTime < 0.05) {
      beginPlayback();
    } else {
      v.addEventListener("seeked", onSeeked);
      try {
        v.currentTime = 0;
      } catch (_) {
        v.removeEventListener("seeked", onSeeked);
        beginPlayback();
      }
    }

    const progressTimer = setInterval(() => {
      if (!state.recording) {
        clearInterval(progressTimer);
        return;
      }
      if (duration && isFinite(duration) && duration > 0) {
        setProgress((v.currentTime / duration) * 100);
        // Backup if "ended" is missed (some mobile browsers)
        if (v.currentTime >= duration - 0.05) {
          clearInterval(progressTimer);
          stopRecording();
        }
      }
    }, 200);
    state._progressTimer = progressTimer;

    state._recordSafety = setTimeout(() => {
      if (state.recording) stopRecording();
    }, 180000);
  }

  function stopRecording() {
    if (!state.recording || state._stopping) return;
    state._stopping = true;
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
    if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
      try {
        // requestData then stop so the last chunk is flushed before onstop downloads
        if (typeof state.mediaRecorder.requestData === "function") {
          try { state.mediaRecorder.requestData(); } catch (_) {}
        }
        state.mediaRecorder.stop();
      } catch (_) {
        state._stopping = false;
        state.recording = false;
        els.exportWebmBtn.disabled = false;
        els.exportWebmBtn.textContent = "保存到系统相册";
      }
    } else if (state.mediaRecorder && state.mediaRecorder.state === "inactive") {
      state.recording = false;
      state._stopping = false;
      els.exportWebmBtn.disabled = false;
      els.exportWebmBtn.textContent = "保存到系统相册";
      setProgress(null);
    }
    pause();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  setStatus("");
})();
