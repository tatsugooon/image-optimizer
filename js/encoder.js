/**
 * 画像のデコード・描画・エンコードと、容量が最小になる品質の探索。
 * ブラウザ API（Canvas / createImageBitmap）に依存する処理はここに閉じる。
 */
;(function (global) {
  "use strict"

  const { computeGeometry } = global.ImgOpt.geometry
  const { QUALITY_STEPS, ssim, findLowestPassing, findHighestPassing } = global.ImgOpt.quality

  const LOSSLESS_MIMES = new Set(["image/png"])

  const EXTENSION_BY_MIME = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/avif": "avif",
  }

  const MIME_BY_EXTENSION = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    jpe: "image/jpeg",
    jfif: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    gif: "image/gif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
    heic: "image/heic",
    heif: "image/heif",
  }

  /** SSIM を測る解像度。小さくして探索コストを抑える */
  const REFERENCE_MAX_SIDE = 384

  function extensionFor(mime) {
    return EXTENSION_BY_MIME[mime] || "bin"
  }

  function mimeForFile(file) {
    const fromName = MIME_BY_EXTENSION[global.ImgOpt.rename.splitExtension(file.name).ext.toLowerCase()]
    return file.type || fromName || ""
  }

  function createCanvas(width, height) {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height)
    const canvas = global.document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    return canvas
  }

  function context2d(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    return ctx
  }

  function encode(canvas, mime, quality) {
    if (typeof canvas.convertToBlob === "function") {
      return canvas.convertToBlob(LOSSLESS_MIMES.has(mime) ? { type: mime } : { type: mime, quality })
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error(`${mime} のエンコードに失敗しました`))),
        mime,
        quality,
      )
    })
  }

  let supportPromise = null

  /** ブラウザが実際にエンコードできる形式を調べる（Chrome は AVIF を書き出せない） */
  function detectSupport() {
    if (supportPromise) return supportPromise
    supportPromise = (async () => {
      const canvas = createCanvas(8, 8)
      context2d(canvas).fillRect(0, 0, 8, 8)
      const support = { "image/jpeg": true, "image/png": true }
      for (const mime of ["image/webp", "image/avif"]) {
        try {
          const blob = await encode(canvas, mime, 0.8)
          support[mime] = blob.type === mime
        } catch {
          support[mime] = false
        }
      }
      return support
    })()
    return supportPromise
  }

  async function decodeSvg(file) {
    const url = URL.createObjectURL(file)
    try {
      const image = new Image()
      image.decoding = "sync"
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = () => reject(new Error("SVG を読み込めませんでした"))
        image.src = url
      })
      // 幅指定のない SVG は既定サイズで描く
      const width = image.naturalWidth || 1024
      const height = image.naturalHeight || Math.round(width * 0.75)
      const canvas = createCanvas(width, height)
      context2d(canvas).drawImage(image, 0, 0, width, height)
      return { source: canvas, width, height }
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  async function decodeWithImageElement(file) {
    const url = URL.createObjectURL(file)
    try {
      const image = new Image()
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = () => reject(new Error("この形式はブラウザでデコードできません"))
        image.src = url
      })
      return { source: image, width: image.naturalWidth, height: image.naturalHeight }
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** 元画像を描画可能な形（ImageBitmap / Canvas / Image）にして返す */
  async function decode(file) {
    const mime = mimeForFile(file)
    if (mime === "image/svg+xml") return decodeSvg(file)
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file).catch(() => null)
      if (bitmap) return { source: bitmap, width: bitmap.width, height: bitmap.height }
    }
    // createImageBitmap が扱えない形式（Safari の AVIF など）は img 経由で試す
    return decodeWithImageElement(file)
  }

  /** 段階的に縮小してから最終サイズへ描く（一気に縮めるとジャギーが出る） */
  function renderCanvas(source, geometry, backgroundColor) {
    const { crop, output } = geometry
    let current = createCanvas(crop.width, crop.height)
    context2d(current).drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)

    while (current.width >= output.width * 2 && current.height >= output.height * 2) {
      const halfWidth = Math.max(output.width, Math.floor(current.width / 2))
      const halfHeight = Math.max(output.height, Math.floor(current.height / 2))
      const next = createCanvas(halfWidth, halfHeight)
      context2d(next).drawImage(current, 0, 0, halfWidth, halfHeight)
      current = next
    }

    const target = createCanvas(output.width, output.height)
    const ctx = context2d(target)
    if (backgroundColor) {
      ctx.fillStyle = backgroundColor
      ctx.fillRect(0, 0, output.width, output.height)
    }
    ctx.drawImage(current, 0, 0, output.width, output.height)
    return target
  }

  /** 透過を背景色で塗り潰した Canvas を返す（JPEG 出力用） */
  function flattenCanvas(canvas, backgroundColor) {
    const next = createCanvas(canvas.width, canvas.height)
    const ctx = context2d(next)
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(canvas, 0, 0)
    return next
  }

  function scaleCanvas(canvas, scale) {
    const width = Math.max(1, Math.round(canvas.width * scale))
    const height = Math.max(1, Math.round(canvas.height * scale))
    const next = createCanvas(width, height)
    context2d(next).drawImage(canvas, 0, 0, width, height)
    return next
  }

  /** 半透明画素があるか（無ければ JPEG も候補にできる） */
  function hasAlpha(canvas) {
    const step = Math.max(1, Math.floor(Math.max(canvas.width, canvas.height) / 256))
    const ctx = context2d(canvas)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        if (data[(y * canvas.width + x) * 4 + 3] < 255) return true
      }
    }
    return false
  }

  /**
   * 自動調整を Canvas に反映する。
   * 品質探索の基準画像は調整後の絵で作る必要があるため、必ず SSIM 計測より先に呼ぶ。
   */
  function adjustCanvas(canvas, options) {
    if (!global.ImgOpt.adjust.hasEffect(options)) return false
    const ctx = context2d(canvas)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const changed = global.ImgOpt.adjust.applyAdjustments(imageData, options)
    if (changed) ctx.putImageData(imageData, 0, 0)
    return changed
  }

  /** 自動調整のプレビュー用に、長辺 maxSide まで縮めた Canvas を作る */
  async function makePreviewSource(file, maxSide) {
    const decoded = await decode(file)
    const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height))
    const geometry = {
      crop: { x: 0, y: 0, width: decoded.width, height: decoded.height },
      output: {
        width: Math.max(1, Math.round(decoded.width * scale)),
        height: Math.max(1, Math.round(decoded.height * scale)),
      },
    }
    const canvas = renderCanvas(decoded.source, geometry, null)
    decoded.source.close?.()
    return canvas
  }

  function referenceSize(width, height) {
    const scale = Math.min(1, REFERENCE_MAX_SIDE / Math.max(width, height))
    return { width: Math.max(8, Math.round(width * scale)), height: Math.max(8, Math.round(height * scale)) }
  }

  /** SSIM 比較用の縮小画素を作る */
  function makeReference(canvas) {
    const size = referenceSize(canvas.width, canvas.height)
    const small = createCanvas(size.width, size.height)
    const ctx = context2d(small)
    ctx.drawImage(canvas, 0, 0, size.width, size.height)
    return {
      width: size.width,
      height: size.height,
      data: ctx.getImageData(0, 0, size.width, size.height).data,
      scratch: createCanvas(size.width, size.height),
    }
  }

  async function measureSsim(blob, reference) {
    let bitmap
    try {
      bitmap = await createImageBitmap(blob)
    } catch {
      return 1
    }
    const ctx = context2d(reference.scratch)
    ctx.clearRect(0, 0, reference.width, reference.height)
    ctx.drawImage(bitmap, 0, 0, reference.width, reference.height)
    bitmap.close?.()
    const data = ctx.getImageData(0, 0, reference.width, reference.height).data
    return ssim(reference.data, data, reference.width, reference.height)
  }

  /**
   * 1 形式ぶんの最良結果を返す。
   * 自動モードは SSIM 基準を満たす最小品質、目標サイズモードは目標内で最大品質を選ぶ。
   */
  async function encodeBest(canvas, mime, settings, reference) {
    if (LOSSLESS_MIMES.has(mime)) {
      const blob = await encode(canvas, mime, 1)
      return { blob, mime, quality: null, ssim: 1, canvas }
    }

    if (settings.mode === "quality") {
      const blob = await encode(canvas, mime, settings.quality)
      return { blob, mime, quality: settings.quality, ssim: null, canvas }
    }

    if (settings.mode === "target") {
      let workCanvas = canvas
      let workReference = reference
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const search = await findHighestPassing(QUALITY_STEPS, async (quality) => {
          const blob = await encode(workCanvas, mime, quality)
          return { ok: blob.size <= settings.targetBytes, blob, quality }
        })
        if (search.passing) {
          return {
            blob: search.passing.blob,
            mime,
            quality: search.passing.quality,
            ssim: await measureSsim(search.passing.blob, workReference),
            canvas: workCanvas,
          }
        }
        if (!settings.allowDownscaleForTarget) break
        // 最低品質でも入らないので解像度を落として再挑戦する
        workCanvas = scaleCanvas(workCanvas, 0.85)
        workReference = makeReference(workCanvas)
      }
      const blob = await encode(workCanvas, mime, QUALITY_STEPS[0])
      return { blob, mime, quality: QUALITY_STEPS[0], ssim: await measureSsim(blob, workReference), canvas: workCanvas }
    }

    const search = await findLowestPassing(QUALITY_STEPS, async (quality) => {
      const blob = await encode(canvas, mime, quality)
      const score = await measureSsim(blob, reference)
      return { ok: score >= settings.ssimTarget, blob, quality, ssim: score }
    })
    if (search.passing) {
      return {
        blob: search.passing.blob,
        mime,
        quality: search.passing.quality,
        ssim: search.passing.ssim,
        canvas,
      }
    }
    const highest = QUALITY_STEPS[QUALITY_STEPS.length - 1]
    const blob = await encode(canvas, mime, highest)
    return { blob, mime, quality: highest, ssim: await measureSsim(blob, reference), canvas, belowTarget: true }
  }

  /** 出力形式の候補を決める */
  function candidateMimes(settings, sourceMime, alpha, support) {
    const usable = (mime) => support[mime]
    if (settings.format !== "keep" && settings.format !== "smallest") {
      return usable(settings.format) ? [settings.format] : ["image/png"]
    }
    if (settings.format === "keep" && EXTENSION_BY_MIME[sourceMime] && usable(sourceMime)) {
      return [sourceMime]
    }
    const list = alpha ? ["image/webp", "image/png"] : ["image/webp", "image/jpeg"]
    if (settings.format === "smallest" && usable("image/avif")) list.unshift("image/avif")
    return list.filter(usable)
  }

  /**
   * 1 ファイルを処理する。
   * 戻り値: { status, blob, mime, ext, width, height, quality, ssim, originalSize, outputSize }
   */
  async function optimize(file, settings) {
    const support = await detectSupport()
    const sourceMime = mimeForFile(file)
    const decoded = await decode(file)
    const geometry = computeGeometry({
      srcWidth: decoded.width,
      srcHeight: decoded.height,
      crop: settings.crop,
      resize: settings.resize,
      noUpscale: settings.noUpscale,
    })

    const probeCanvas = renderCanvas(decoded.source, geometry, null)
    decoded.source.close?.()
    const adjusted = adjustCanvas(probeCanvas, settings.adjust)
    const alpha = hasAlpha(probeCanvas)
    const mimes = candidateMimes(settings, sourceMime, alpha, support)
    const reference = makeReference(probeCanvas)
    // JPEG は透過を扱えないので白で塗り潰した Canvas を使う
    const flattened = alpha ? flattenCanvas(probeCanvas, settings.background || "#ffffff") : probeCanvas

    let best = null
    for (const mime of mimes) {
      const canvas = mime === "image/jpeg" ? flattened : probeCanvas
      const result = await encodeBest(canvas, mime, settings, reference)
      if (!best || result.blob.size < best.blob.size) best = result
    }

    if (!best) throw new Error("出力できる形式が見つかりませんでした")

    const keepOriginal =
      settings.skipIfLarger !== false &&
      !geometry.changed &&
      !adjusted &&
      best.mime === sourceMime &&
      best.blob.size >= file.size &&
      settings.mode !== "target"

    if (keepOriginal) {
      return {
        status: "kept",
        blob: file,
        mime: sourceMime,
        ext: extensionFor(sourceMime),
        width: geometry.output.width,
        height: geometry.output.height,
        quality: null,
        ssim: 1,
        originalSize: file.size,
        outputSize: file.size,
      }
    }

    return {
      status: "ok",
      blob: best.blob,
      mime: best.mime,
      ext: extensionFor(best.mime),
      width: best.canvas.width,
      height: best.canvas.height,
      quality: best.quality,
      ssim: best.ssim,
      belowTarget: Boolean(best.belowTarget),
      originalSize: file.size,
      outputSize: best.blob.size,
    }
  }

  global.ImgOpt = global.ImgOpt || {}
  global.ImgOpt.encoder = {
    EXTENSION_BY_MIME,
    MIME_BY_EXTENSION,
    extensionFor,
    mimeForFile,
    detectSupport,
    decode,
    renderCanvas,
    adjustCanvas,
    makePreviewSource,
    hasAlpha,
    encode,
    encodeBest,
    candidateMimes,
    optimize,
  }
})(typeof window !== "undefined" ? window : globalThis)
