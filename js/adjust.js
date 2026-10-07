/**
 * 自動調整（レベル補正・ホワイトバランス・彩度・シャープ・HDR 風トーン）。
 * ImageData 互換の { data, width, height } だけを受け取り、Canvas には触らない。
 */
;(function (global) {
  "use strict"

  /** プリセット。custom を選んだ場合は画面の値をそのまま使う */
  const PRESETS = {
    none: { levels: false, whiteBalance: false, clipPercent: 0.5, saturation: 1, sharpen: 0, tone: 0 },
    subtle: { levels: true, whiteBalance: false, clipPercent: 0.1, saturation: 1.03, sharpen: 0.25, tone: 0 },
    standard: { levels: true, whiteBalance: true, clipPercent: 0.5, saturation: 1.08, sharpen: 0.4, tone: 0.15 },
    strong: { levels: true, whiteBalance: true, clipPercent: 1, saturation: 1.18, sharpen: 0.6, tone: 0.35 },
    hdr: { levels: true, whiteBalance: true, clipPercent: 0.5, saturation: 1.12, sharpen: 0.35, tone: 0.8 },
  }

  const LUMA_R = 0.299
  const LUMA_G = 0.587
  const LUMA_B = 0.114

  /** 色かぶり補正の上限。意図的な色調の写真を壊さないよう振れ幅を抑える */
  const MAX_WHITE_BALANCE_GAIN = 1.25
  const MIN_WHITE_BALANCE_GAIN = 0.8

  /** レベル補正を諦める黒点と白点の差。平坦な画像を無理に伸ばすとノイズが目立つ */
  const MIN_LEVEL_RANGE = 16

  function clamp255(value) {
    return value < 0 ? 0 : value > 255 ? 255 : value
  }

  function luma(r, g, b) {
    return LUMA_R * r + LUMA_G * g + LUMA_B * b
  }

  /** 統計は間引いて取る。画素数が増えても計測時間を一定に保つ */
  function sampleStep(width, height) {
    return Math.max(1, Math.round(Math.sqrt((width * height) / 120000)))
  }

  function buildHistogram(image) {
    const { data, width, height } = image
    const histogram = new Uint32Array(256)
    const step = sampleStep(width, height)
    let total = 0
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const index = (y * width + x) * 4
        if (data[index + 3] === 0) continue
        histogram[Math.round(luma(data[index], data[index + 1], data[index + 2]))] += 1
        total += 1
      }
    }
    return { histogram, total }
  }

  /** 上下 clipPercent% を捨てた位置を黒点・白点にする */
  function findLevels(histogram, total, clipPercent) {
    if (total === 0) return { black: 0, white: 255 }
    const threshold = Math.max(1, Math.floor((total * clipPercent) / 100))
    let black = 0
    let white = 255
    let sum = 0
    for (let value = 0; value < 256; value += 1) {
      sum += histogram[value]
      if (sum >= threshold) {
        black = value
        break
      }
    }
    sum = 0
    for (let value = 255; value >= 0; value -= 1) {
      sum += histogram[value]
      if (sum >= threshold) {
        white = value
        break
      }
    }
    return white - black < MIN_LEVEL_RANGE ? { black: 0, white: 255 } : { black, white }
  }

  function applyLevels(image, black, white) {
    if (black === 0 && white === 255) return false
    const { data } = image
    const scale = 255 / (white - black)
    const table = new Uint8ClampedArray(256)
    for (let value = 0; value < 256; value += 1) {
      table[value] = clamp255((value - black) * scale)
    }
    for (let i = 0; i < data.length; i += 4) {
      data[i] = table[data[i]]
      data[i + 1] = table[data[i + 1]]
      data[i + 2] = table[data[i + 2]]
    }
    return true
  }

  /** グレーワールド仮定（画像全体の平均は無彩色）で RGB ゲインを求める */
  function grayWorldGains(image) {
    const { data, width, height } = image
    const step = sampleStep(width, height)
    let sumR = 0
    let sumG = 0
    let sumB = 0
    let count = 0
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const index = (y * width + x) * 4
        if (data[index + 3] === 0) continue
        sumR += data[index]
        sumG += data[index + 1]
        sumB += data[index + 2]
        count += 1
      }
    }
    if (count === 0) return { r: 1, g: 1, b: 1 }
    const meanR = sumR / count
    const meanG = sumG / count
    const meanB = sumB / count
    const target = (meanR + meanG + meanB) / 3
    const gain = (mean) => {
      if (mean <= 1) return 1
      return Math.min(MAX_WHITE_BALANCE_GAIN, Math.max(MIN_WHITE_BALANCE_GAIN, target / mean))
    }
    return { r: gain(meanR), g: gain(meanG), b: gain(meanB) }
  }

  function applyGains(image, gains) {
    if (gains.r === 1 && gains.g === 1 && gains.b === 1) return false
    const { data } = image
    for (let i = 0; i < data.length; i += 4) {
      data[i] = clamp255(data[i] * gains.r)
      data[i + 1] = clamp255(data[i + 1] * gains.g)
      data[i + 2] = clamp255(data[i + 2] * gains.b)
    }
    return true
  }

  function applySaturation(image, amount) {
    if (amount === 1) return false
    const { data } = image
    for (let i = 0; i < data.length; i += 4) {
      const gray = luma(data[i], data[i + 1], data[i + 2])
      data[i] = clamp255(gray + (data[i] - gray) * amount)
      data[i + 1] = clamp255(gray + (data[i + 1] - gray) * amount)
      data[i + 2] = clamp255(gray + (data[i + 2] - gray) * amount)
    }
    return true
  }

  /**
   * 明るさのトーンカーブ。0..1 を受け取り 0..1 を返す。
   * amount を上げるほどシャドウが持ち上がりハイライトが圧縮される（いわゆる HDR 風の階調）。
   */
  function toneCurve(value, amount) {
    if (amount <= 0) return value
    const k = 1.2 * amount
    return (value * (1 + k)) / (1 + k * value)
  }

  function extractLuma(image) {
    const { data, width, height } = image
    const result = new Float32Array(width * height)
    for (let i = 0, p = 0; i < result.length; i += 1, p += 4) {
      result[i] = luma(data[p], data[p + 1], data[p + 2])
    }
    return result
  }

  const clampIndex = (value, max) => (value < 0 ? 0 : value > max ? max : value)

  /** 横方向のボックスぼかし。端は最外周の値を伸ばして扱う */
  function boxBlurHorizontal(input, output, width, height, radius) {
    const window = radius * 2 + 1
    for (let y = 0; y < height; y += 1) {
      const row = y * width
      let sum = 0
      for (let x = -radius; x <= radius; x += 1) {
        sum += input[row + clampIndex(x, width - 1)]
      }
      for (let x = 0; x < width; x += 1) {
        output[row + x] = sum / window
        sum -= input[row + clampIndex(x - radius, width - 1)]
        sum += input[row + clampIndex(x + radius + 1, width - 1)]
      }
    }
  }

  function boxBlurVertical(input, output, width, height, radius) {
    const window = radius * 2 + 1
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      for (let y = -radius; y <= radius; y += 1) {
        sum += input[clampIndex(y, height - 1) * width + x]
      }
      for (let y = 0; y < height; y += 1) {
        output[y * width + x] = sum / window
        sum -= input[clampIndex(y - radius, height - 1) * width + x]
        sum += input[clampIndex(y + radius + 1, height - 1) * width + x]
      }
    }
  }

  /** 累積和で O(画素数) のボックスぼかし。pass を重ねるとガウスぼかしに近づく */
  function blurLuma(source, width, height, radius, passes) {
    const passCount = passes || 1
    if (radius < 1 || passCount < 1) return source
    let result = Float32Array.from(source)
    const buffer = new Float32Array(source.length)
    for (let pass = 0; pass < passCount; pass += 1) {
      boxBlurHorizontal(result, buffer, width, height, radius)
      boxBlurVertical(buffer, result, width, height, radius)
    }
    return result
  }

  /**
   * アンシャープマスク。輝度だけを比較し、差分を RGB に同じだけ足す（色のにじみを避ける）。
   * radius を大きく amount を小さくすると、輪郭ではなく面のコントラストが上がる。
   */
  function unsharpMask(image, amount, radius, passes) {
    if (amount <= 0 || radius < 1) return false
    const { data, width, height } = image
    if (width < 3 || height < 3) return false
    const source = extractLuma(image)
    const blurred = blurLuma(source, width, height, radius, passes || 1)
    for (let i = 0, p = 0; i < source.length; i += 1, p += 4) {
      const diff = (source[i] - blurred[i]) * amount
      if (diff === 0) continue
      data[p] = clamp255(data[p] + diff)
      data[p + 1] = clamp255(data[p + 1] + diff)
      data[p + 2] = clamp255(data[p + 2] + diff)
    }
    return true
  }

  /** トーンカーブ＋広い半径のアンシャープマスクで HDR 風の階調にする */
  function applyTone(image, amount) {
    if (amount <= 0) return false
    const { data, width, height } = image
    const table = new Float32Array(256)
    for (let value = 0; value < 256; value += 1) {
      const normalized = value / 255
      table[value] = normalized === 0 ? 0 : toneCurve(normalized, amount) / normalized
    }
    for (let i = 0; i < data.length; i += 4) {
      const scale = table[Math.round(luma(data[i], data[i + 1], data[i + 2]))]
      data[i] = clamp255(data[i] * scale)
      data[i + 1] = clamp255(data[i + 1] * scale)
      data[i + 2] = clamp255(data[i + 2] * scale)
    }
    const radius = Math.max(4, Math.round(Math.min(width, height) / 60))
    unsharpMask(image, 0.35 * amount, radius, 2)
    return true
  }

  function resolvePreset(name) {
    return PRESETS[name] ? { ...PRESETS[name] } : { ...PRESETS.none }
  }

  /** 何か 1 つでも効果が出る設定か */
  function hasEffect(options) {
    if (!options) return false
    return Boolean(
      options.levels ||
        options.whiteBalance ||
        (options.saturation != null && options.saturation !== 1) ||
        options.sharpen > 0 ||
        options.tone > 0,
    )
  }

  /**
   * 調整をまとめて適用する。image は破壊的に書き換える。
   * 戻り値は実際に画素を変更したかどうか。
   */
  function applyAdjustments(image, options) {
    if (!hasEffect(options)) return false
    let changed = false

    if (options.whiteBalance) {
      changed = applyGains(image, grayWorldGains(image)) || changed
    }
    if (options.levels) {
      const { histogram, total } = buildHistogram(image)
      const levels = findLevels(histogram, total, options.clipPercent == null ? 0.5 : options.clipPercent)
      changed = applyLevels(image, levels.black, levels.white) || changed
    }
    if (options.tone > 0) {
      changed = applyTone(image, options.tone) || changed
    }
    if (options.saturation != null && options.saturation !== 1) {
      changed = applySaturation(image, options.saturation) || changed
    }
    if (options.sharpen > 0) {
      changed = unsharpMask(image, options.sharpen, 1, 1) || changed
    }
    return changed
  }

  global.ImgOpt = global.ImgOpt || {}
  global.ImgOpt.adjust = {
    PRESETS,
    resolvePreset,
    hasEffect,
    buildHistogram,
    findLevels,
    applyLevels,
    grayWorldGains,
    applyGains,
    applySaturation,
    toneCurve,
    applyTone,
    unsharpMask,
    blurLuma,
    applyAdjustments,
  }
})(typeof window !== "undefined" ? window : globalThis)
