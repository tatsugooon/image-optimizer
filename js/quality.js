/**
 * 画質評価（SSIM）と品質探索。
 * 画像デコードには触れず、渡された画素配列と probe 関数だけで動く。
 */
;(function (global) {
  "use strict"

  /** 品質探索に使う離散グリッド。細かすぎるとエンコード回数が増えるので 0.05 刻み */
  const QUALITY_STEPS = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]

  function toGrayscale(rgba, width, height) {
    const gray = new Float32Array(width * height)
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      const alpha = rgba[p + 3] / 255
      // 透明部分は白背景として比較する（JPEG 変換時の見た目に合わせる）
      const r = rgba[p] * alpha + 255 * (1 - alpha)
      const g = rgba[p + 1] * alpha + 255 * (1 - alpha)
      const b = rgba[p + 2] * alpha + 255 * (1 - alpha)
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b
    }
    return gray
  }

  /**
   * 2 枚の RGBA 配列の SSIM（8x8 窓・4px ステップの平均）を返す。
   * 1 に近いほど元画像と見分けがつかない。
   */
  function ssim(rgbaA, rgbaB, width, height) {
    if (width < 8 || height < 8) return 1
    const a = toGrayscale(rgbaA, width, height)
    const b = toGrayscale(rgbaB, width, height)
    const c1 = (0.01 * 255) ** 2
    const c2 = (0.03 * 255) ** 2
    const windowSize = 8
    const step = 4
    let total = 0
    let count = 0

    for (let y = 0; y + windowSize <= height; y += step) {
      for (let x = 0; x + windowSize <= width; x += step) {
        let sumA = 0
        let sumB = 0
        let sumAA = 0
        let sumBB = 0
        let sumAB = 0
        for (let wy = 0; wy < windowSize; wy += 1) {
          let index = (y + wy) * width + x
          for (let wx = 0; wx < windowSize; wx += 1, index += 1) {
            const va = a[index]
            const vb = b[index]
            sumA += va
            sumB += vb
            sumAA += va * va
            sumBB += vb * vb
            sumAB += va * vb
          }
        }
        const pixels = windowSize * windowSize
        const meanA = sumA / pixels
        const meanB = sumB / pixels
        const varA = sumAA / pixels - meanA * meanA
        const varB = sumBB / pixels - meanB * meanB
        const covAB = sumAB / pixels - meanA * meanB
        const numerator = (2 * meanA * meanB + c1) * (2 * covAB + c2)
        const denominator = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2)
        total += denominator === 0 ? 1 : numerator / denominator
        count += 1
      }
    }

    return count === 0 ? 1 : total / count
  }

  /**
   * 昇順リストから「条件を満たす最小の要素」を二分探索する。
   * probe(value, index) は { ok, ...任意 } を返す。条件は単調（false...false,true...true）である前提。
   */
  async function findLowestPassing(items, probe) {
    let low = 0
    let high = items.length - 1
    let passing = null
    let lastProbe = null
    while (low <= high) {
      const middle = (low + high) >> 1
      const result = await probe(items[middle], middle)
      lastProbe = result
      if (result.ok) {
        passing = result
        high = middle - 1
      } else {
        low = middle + 1
      }
    }
    return { passing, lastProbe }
  }

  /**
   * 昇順リストから「条件を満たす最大の要素」を二分探索する。
   * 条件は単調（true...true,false...false）である前提。
   */
  async function findHighestPassing(items, probe) {
    let low = 0
    let high = items.length - 1
    let passing = null
    let lastProbe = null
    while (low <= high) {
      const middle = (low + high) >> 1
      const result = await probe(items[middle], middle)
      lastProbe = result
      if (result.ok) {
        passing = result
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return { passing, lastProbe }
  }

  global.ImgOpt = global.ImgOpt || {}
  global.ImgOpt.quality = { QUALITY_STEPS, ssim, toGrayscale, findLowestPassing, findHighestPassing }
})(typeof window !== "undefined" ? window : globalThis)
