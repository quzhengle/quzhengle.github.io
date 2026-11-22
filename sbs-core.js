/**
 * Full-frame side-by-side (full SBS) layout.
 *
 * Each eye keeps the entire source picture at its own aspect ratio.
 * A small horizontal disparity (strength 8) is applied by padding, not by
 * cropping or stretching. Output width is two eyes; this is not half SBS.
 *
 * Works in the browser (global SBSCore) and in Node tests (module.exports).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.SBSCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var STRENGTH = 8;
  // Longest side of the picture inside one eye. Caps mobile fill-rate.
  // The full frame is scaled uniformly to fit; it is never cropped.
  var MAX_CONTENT_EDGE = 960;

  function evenDown(n) {
    var r = Math.round(n);
    var e = r - (r % 2);
    return e < 2 ? 2 : e;
  }

  function computeLayout(videoWidth, videoHeight) {
    var vw = Math.max(1, Math.round(Number(videoWidth) || 1));
    var vh = Math.max(1, Math.round(Number(videoHeight) || 1));
    var scale = Math.min(1, MAX_CONTENT_EDGE / vw, MAX_CONTENT_EDGE / vh);
    var contentW = evenDown(vw * scale);
    var contentH = evenDown((contentW * vh) / vw);
    if (contentH > MAX_CONTENT_EDGE + 1) {
      contentH = evenDown(MAX_CONTENT_EDGE);
      contentW = evenDown((contentH * vw) / vh);
    }

    // Same disparity formula as before: (strength/40) * width * 0.06.
    // Padding absorbs ± this shift so neither eye loses edge pixels.
    var shift = Math.max(0, Math.round((STRENGTH / 40) * contentW * 0.06));
    var eyeW = contentW + shift * 2;
    var eyeH = contentH;

    return {
      strength: STRENGTH,
      mode: "full-sbs",
      videoW: vw,
      videoH: vh,
      scale: contentW / vw,
      contentW: contentW,
      contentH: contentH,
      shift: shift,
      eyeW: eyeW,
      eyeH: eyeH,
      outputW: eyeW * 2,
      outputH: eyeH,
    };
  }

  /**
   * Destination rects for the full source frame inside the output canvas.
   * Left eye content sits `2*shift` from the left (black pad on the outside).
   * Right eye content starts at the eye boundary (black pad on the outside).
   * Relative disparity is `2*shift`, matching the previous ±shift pair.
   */
  function contentRects(layout) {
    return {
      left: { x: layout.shift * 2, y: 0, w: layout.contentW, h: layout.contentH },
      right: { x: layout.eyeW, y: 0, w: layout.contentW, h: layout.contentH },
    };
  }

  /**
   * Draw both eyes. Source rectangle is always the entire frame.
   * `source` is a CanvasImageSource (video, canvas, or image).
   */
  function drawSBS(ctx, source, videoWidth, videoHeight, layout) {
    var rects = contentRects(layout);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, layout.outputW, layout.outputH);
    ctx.drawImage(
      source,
      0,
      0,
      videoWidth,
      videoHeight,
      rects.left.x,
      rects.left.y,
      rects.left.w,
      rects.left.h
    );
    ctx.drawImage(
      source,
      0,
      0,
      videoWidth,
      videoHeight,
      rects.right.x,
      rects.right.y,
      rects.right.w,
      rects.right.h
    );
    return rects;
  }

  return {
    STRENGTH: STRENGTH,
    MAX_CONTENT_EDGE: MAX_CONTENT_EDGE,
    computeLayout: computeLayout,
    contentRects: contentRects,
    drawSBS: drawSBS,
  };
});
