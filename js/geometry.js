/**
 * リサイズ・トリミングの寸法計算。
 * DOM や Canvas に依存しない純関数だけを置き、Node からもテストできるようにしている。
 */
;(function (global) {
  "use strict"

  const ANCHORS = {
    "top-left": [0, 0],
    top: [0.5, 0],
    "top-right": [1, 0],
    left: [0, 0.5],
    center: [0.5, 0.5],
    right: [1, 0.5],
    "bottom-left": [0, 1],
    bottom: [0.5, 1],
    "bottom-right": [1, 1],
  }

  function clampPositive(value) {
    return Math.max(1, Math.round(value))
  }

  function anchorFactors(anchor) {
    return ANCHORS[anchor] || ANCHORS.center
  }

  /**
   * トリミング領域を求める。
   * mode: "none"（切らない） / "square"（正方形） / "ratio"（aspectW:aspectH）
   */
  function computeCrop(srcW, srcH, crop) {
    const mode = (crop && crop.mode) || "none"
    if (mode === "none") return { x: 0, y: 0, width: srcW, height: srcH }

    let ratio
    if (mode === "square") {
      ratio = 1
    } else {
      const aw = Number(crop.aspectW)
      const ah = Number(crop.aspectH)
      if (!(aw > 0) || !(ah > 0)) return { x: 0, y: 0, width: srcW, height: srcH }
      ratio = aw / ah
    }

    let width = srcW
    let height = Math.round(srcW / ratio)
    if (height > srcH) {
      height = srcH
      width = Math.round(srcH * ratio)
    }
    width = Math.min(srcW, clampPositive(width))
    height = Math.min(srcH, clampPositive(height))

    const [fx, fy] = anchorFactors(crop.anchor)
    return {
      x: Math.round((srcW - width) * fx),
      y: Math.round((srcH - height) * fy),
      width,
      height,
    }
  }

  /**
   * トリミング後の領域に対する出力ピクセル数を求める。
   * mode: "none" / "percent" / "width" / "height" / "fit"（枠に収める） / "exact"（指定値そのまま）
   */
  function computeOutputSize(baseW, baseH, resize, noUpscale) {
    const mode = (resize && resize.mode) || "none"
    let width = baseW
    let height = baseH

    if (mode === "percent") {
      const percent = Number(resize.percent)
      if (percent > 0) {
        width = (baseW * percent) / 100
        height = (baseH * percent) / 100
      }
    } else if (mode === "width") {
      const target = Number(resize.width)
      if (target > 0) {
        width = target
        height = (baseH * target) / baseW
      }
    } else if (mode === "height") {
      const target = Number(resize.height)
      if (target > 0) {
        height = target
        width = (baseW * target) / baseH
      }
    } else if (mode === "fit") {
      const boxW = Number(resize.width)
      const boxH = Number(resize.height)
      if (boxW > 0 && boxH > 0) {
        const scale = Math.min(boxW / baseW, boxH / baseH)
        width = baseW * scale
        height = baseH * scale
      } else if (boxW > 0) {
        width = boxW
        height = (baseH * boxW) / baseW
      } else if (boxH > 0) {
        height = boxH
        width = (baseW * boxH) / baseH
      }
    } else if (mode === "exact") {
      const boxW = Number(resize.width)
      const boxH = Number(resize.height)
      if (boxW > 0) width = boxW
      if (boxH > 0) height = boxH
    }

    if (noUpscale && (width > baseW || height > baseH)) {
      const scale = Math.min(baseW / width, baseH / height)
      width *= scale
      height *= scale
    }

    return { width: clampPositive(width), height: clampPositive(height) }
  }

  /**
   * トリミング → リサイズをまとめて解決する。
   * 戻り値の crop は元画像上の切り出し範囲、output は書き出しサイズ。
   */
  function computeGeometry(options) {
    const srcW = clampPositive(options.srcWidth)
    const srcH = clampPositive(options.srcHeight)
    const crop = computeCrop(srcW, srcH, options.crop)
    const output = computeOutputSize(crop.width, crop.height, options.resize, options.noUpscale !== false)
    return {
      crop,
      output,
      changed: crop.width !== srcW || crop.height !== srcH || output.width !== srcW || output.height !== srcH,
    }
  }

  global.ImgOpt = global.ImgOpt || {}
  global.ImgOpt.geometry = { ANCHORS, computeCrop, computeOutputSize, computeGeometry }
})(typeof window !== "undefined" ? window : globalThis)
