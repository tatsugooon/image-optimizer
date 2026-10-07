/**
 * ブラウザ非依存のロジック（寸法計算・リネーム・品質探索・ZIP）を Node だけで検証する。
 * 実行: node tools/image-optimizer/test/run-tests.mjs
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const context = vm.createContext({ Intl, TextEncoder, Blob, console })
for (const file of ["geometry.js", "rename.js", "quality.js", "adjust.js", "settings.js", "zip.js"]) {
  vm.runInContext(fs.readFileSync(path.join(rootDir, "js", file), "utf8"), context, { filename: file })
}
const { adjust, geometry, rename, quality, settings, zip } = context.ImgOpt

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test("比率リサイズは元の縦横比を保つ", () => {
  const result = geometry.computeGeometry({
    srcWidth: 1200,
    srcHeight: 800,
    resize: { mode: "percent", percent: 50 },
  })
  assert.deepEqual({ ...result.output }, { width: 600, height: 400 })
  assert.equal(result.changed, true)
})

test("幅指定は高さを比率から求める", () => {
  const result = geometry.computeGeometry({ srcWidth: 1000, srcHeight: 400, resize: { mode: "width", width: 250 } })
  assert.deepEqual({ ...result.output }, { width: 250, height: 100 })
})

test("枠に収めるモードは長辺基準で縮小する", () => {
  const result = geometry.computeGeometry({
    srcWidth: 4000,
    srcHeight: 2000,
    resize: { mode: "fit", width: 1000, height: 1000 },
  })
  assert.deepEqual({ ...result.output }, { width: 1000, height: 500 })
})

test("正方形トリミングは中央を切り出す", () => {
  const result = geometry.computeGeometry({ srcWidth: 1000, srcHeight: 600, crop: { mode: "square" } })
  assert.deepEqual({ ...result.crop }, { x: 200, y: 0, width: 600, height: 600 })
  assert.deepEqual({ ...result.output }, { width: 600, height: 600 })
})

test("基準位置を指定すると切り出し位置が変わる", () => {
  const result = geometry.computeGeometry({
    srcWidth: 1000,
    srcHeight: 600,
    crop: { mode: "square", anchor: "top-right" },
  })
  assert.deepEqual({ ...result.crop }, { x: 400, y: 0, width: 600, height: 600 })
})

test("比率トリミングと指定サイズを組み合わせると余りを切って埋める", () => {
  const result = geometry.computeGeometry({
    srcWidth: 1600,
    srcHeight: 1200,
    crop: { mode: "ratio", aspectW: 16, aspectH: 9 },
    resize: { mode: "exact", width: 1280, height: 720 },
  })
  assert.deepEqual({ ...result.crop }, { x: 0, y: 150, width: 1600, height: 900 })
  assert.deepEqual({ ...result.output }, { width: 1280, height: 720 })
})

test("拡大しない設定は指定値を超えないよう抑える", () => {
  const result = geometry.computeGeometry({
    srcWidth: 400,
    srcHeight: 300,
    resize: { mode: "width", width: 2000 },
    noUpscale: true,
  })
  assert.deepEqual({ ...result.output }, { width: 400, height: 300 })
})

test("拡大を許可すると指定どおりになる", () => {
  const result = geometry.computeGeometry({
    srcWidth: 400,
    srcHeight: 300,
    resize: { mode: "width", width: 800 },
    noUpscale: false,
  })
  assert.deepEqual({ ...result.output }, { width: 800, height: 600 })
})

test("連番パターンをゼロ埋めして展開する", () => {
  const settings = { enabled: true, pattern: "image-{連番}.{ext}", pad: 3, extensionCase: "lower" }
  const used = new Set()
  const first = rename.buildFileName(settings, { seq: 1, name: "DSC_0001", srcExt: "JPG", ext: "webp" }, used)
  const second = rename.buildFileName(settings, { seq: 2, name: "DSC_0002", srcExt: "JPG", ext: "webp" }, used)
  assert.equal(first, "image-001.webp")
  assert.equal(second, "image-002.webp")
})

test("桁数はトークン側の指定を優先する", () => {
  assert.equal(rename.renderPattern("p{連番:5}", { seq: 42, seqPad: 2 }), "p00042")
})

test("英語トークンと日付トークンを展開する", () => {
  const date = new Date(2026, 8, 8, 14, 5, 9)
  const rendered = rename.renderPattern("{name}-{date:YYYY-MM-DD}-{time}-{w}x{h}.{ext}", {
    seq: 1,
    name: "photo",
    ext: "jpg",
    width: 800,
    height: 600,
    date,
  })
  assert.equal(rendered, "photo-2026-09-08-140509-800x600.jpg")
})

test("未知のトークンはそのまま残す", () => {
  assert.equal(rename.renderPattern("{unknown}-{連番}", { seq: 3, seqPad: 1 }), "{unknown}-3")
})

test("パス区切りを含む名前はディレクトリ外へ出られない", () => {
  assert.equal(rename.sanitizeSegment("../../etc/passwd"), "_.._etc_passwd")
})

test("出力形式が違えばパターンの拡張子を置き換える", () => {
  assert.equal(rename.applyExtension("image-001.png", "webp", true), "image-001.webp")
  assert.equal(rename.applyExtension("image-001.png", "webp", false), "image-001.png")
  assert.equal(rename.applyExtension("image-001", "webp", true), "image-001.webp")
})

test("リネームなしでも同名衝突を避ける", () => {
  const settings = { enabled: false, extensionCase: "lower" }
  const used = new Set()
  const first = rename.buildFileName(settings, { seq: 1, name: "photo", ext: "webp" }, used)
  const second = rename.buildFileName(settings, { seq: 2, name: "photo", ext: "webp" }, used)
  assert.equal(first, "photo.webp")
  assert.equal(second, "photo-2.webp")
})

test("並び替えは数値を含む名前を自然順で扱う", () => {
  const items = [
    { relativePath: "img10.jpg", size: 3, lastModified: 3 },
    { relativePath: "img2.jpg", size: 1, lastModified: 2 },
    { relativePath: "img1.jpg", size: 2, lastModified: 1 },
  ]
  assert.deepEqual(
    rename.sortItems(items, "name").map((item) => item.relativePath),
    ["img1.jpg", "img2.jpg", "img10.jpg"],
  )
  assert.deepEqual(
    rename.sortItems(items, "size").map((item) => item.relativePath),
    ["img2.jpg", "img1.jpg", "img10.jpg"],
  )
})

test("最小の合格値を二分探索で見つける", async () => {
  const probed = []
  const result = await quality.findLowestPassing([1, 2, 3, 4, 5, 6, 7, 8], async (value) => {
    probed.push(value)
    return { ok: value >= 5, value }
  })
  assert.equal(result.passing.value, 5)
  assert.ok(probed.length <= 4, `探索回数が多すぎる: ${probed.length}`)
})

test("最大の合格値を二分探索で見つける", async () => {
  const result = await quality.findHighestPassing([1, 2, 3, 4, 5, 6, 7, 8], async (value) => ({
    ok: value <= 6,
    value,
  }))
  assert.equal(result.passing.value, 6)
})

test("合格する値がなければ passing は null になる", async () => {
  const result = await quality.findLowestPassing([1, 2, 3], async (value) => ({ ok: false, value }))
  assert.equal(result.passing, null)
  assert.notEqual(result.lastProbe, null)
})

test("同一画像の SSIM は 1、劣化するほど下がる", () => {
  const width = 32
  const height = 32
  const base = new Uint8ClampedArray(width * height * 4)
  const noisy = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const value = (i * 7) % 256
    for (let channel = 0; channel < 3; channel += 1) {
      base[i * 4 + channel] = value
      noisy[i * 4 + channel] = Math.min(255, value + (i % 2 === 0 ? 40 : 0))
    }
    base[i * 4 + 3] = 255
    noisy[i * 4 + 3] = 255
  }
  assert.equal(quality.ssim(base, base, width, height), 1)
  const degraded = quality.ssim(base, noisy, width, height)
  assert.ok(degraded < 1 && degraded > 0, `SSIM が範囲外: ${degraded}`)
})

test("CRC32 が既知の値と一致する", () => {
  assert.equal(zip.crc32(new TextEncoder().encode("hello")), 0x3610a686)
})

test("ZIP はエントリ数ぶんのヘッダを持つ", async () => {
  const writer = new zip.ZipWriter()
  writer.add("a/image-001.webp", new TextEncoder().encode("dummy-1"), new Date(2026, 0, 2, 3, 4, 5))
  writer.add("image-002.webp", new TextEncoder().encode("dummy-22"), new Date(2026, 0, 2, 3, 4, 5))
  const bytes = new Uint8Array(await writer.blob().arrayBuffer())
  const view = new DataView(bytes.buffer)
  assert.equal(view.getUint32(0, true), 0x04034b50)
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50)
  assert.equal(view.getUint16(bytes.length - 14, true), 2)
})

function makeImage(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y)
      const index = (y * width + x) * 4
      data[index] = r
      data[index + 1] = g
      data[index + 2] = b
      data[index + 3] = a == null ? 255 : a
    }
  }
  return { data, width, height }
}

test("オートレベルは眠い画像のコントラストを伸ばす", () => {
  // 100〜160 の狭い範囲しか使っていない画像
  const image = makeImage(64, 64, (x) => {
    const value = 100 + (x % 61)
    return [value, value, value]
  })
  const { histogram, total } = adjust.buildHistogram(image)
  const levels = adjust.findLevels(histogram, total, 0.5)
  assert.ok(levels.black >= 100 && levels.white <= 161, `黒点/白点が想定外: ${JSON.stringify({ ...levels })}`)
  assert.equal(adjust.applyLevels(image, levels.black, levels.white), true)
  const values = Array.from(image.data).filter((_, index) => index % 4 === 0)
  assert.ok(Math.min(...values) < 20, `黒点が伸びていない: ${Math.min(...values)}`)
  assert.ok(Math.max(...values) > 235, `白点が伸びていない: ${Math.max(...values)}`)
})

test("すでに 0〜255 を使い切っている画像は補正しない", () => {
  const image = makeImage(32, 32, (x) => {
    const value = x % 2 === 0 ? 0 : 255
    return [value, value, value]
  })
  const { histogram, total } = adjust.buildHistogram(image)
  const levels = adjust.findLevels(histogram, total, 0.5)
  assert.equal(adjust.applyLevels(image, levels.black, levels.white), false)
})

test("階調の幅が狭すぎる画像は伸ばさない（ノイズを持ち上げない）", () => {
  const image = makeImage(32, 32, (x) => {
    const value = 120 + (x % 6)
    return [value, value, value]
  })
  const { histogram, total } = adjust.buildHistogram(image)
  const levels = adjust.findLevels(histogram, total, 0.5)
  assert.deepEqual({ ...levels }, { black: 0, white: 255 })
})

test("ホワイトバランス補正は色かぶりを打ち消す向きに働く", () => {
  const image = makeImage(32, 32, () => [200, 150, 120])
  const gains = adjust.grayWorldGains(image)
  assert.ok(gains.r < 1, `赤を下げていない: ${gains.r}`)
  assert.ok(gains.b > 1, `青を上げていない: ${gains.b}`)
  adjust.applyGains(image, gains)
  const spreadBefore = 200 - 120
  const spreadAfter = image.data[0] - image.data[2]
  assert.ok(spreadAfter < spreadBefore, `色差が縮んでいない: ${spreadAfter}`)
})

test("ホワイトバランスのゲインは上下限で頭打ちにする", () => {
  const image = makeImage(16, 16, () => [255, 10, 10])
  const gains = adjust.grayWorldGains(image)
  assert.ok(gains.r >= 0.8 && gains.g <= 1.25 && gains.b <= 1.25, JSON.stringify({ ...gains }))
})

test("彩度を上げても無彩色は無彩色のまま", () => {
  const image = makeImage(8, 8, () => [128, 128, 128])
  adjust.applySaturation(image, 1.5)
  assert.deepEqual([image.data[0], image.data[1], image.data[2]], [128, 128, 128])
})

test("彩度 0 でグレースケールになる", () => {
  const image = makeImage(8, 8, () => [200, 100, 50])
  adjust.applySaturation(image, 0)
  assert.equal(image.data[0], image.data[1])
  assert.equal(image.data[1], image.data[2])
})

test("トーンカーブは端点を保ちシャドウを持ち上げる", () => {
  assert.equal(adjust.toneCurve(0, 0.8), 0)
  assert.equal(adjust.toneCurve(1, 0.8), 1)
  assert.equal(adjust.toneCurve(0.3, 0), 0.3)
  assert.ok(adjust.toneCurve(0.2, 0.8) > 0.2, "シャドウが持ち上がっていない")
  let previous = -1
  for (let i = 0; i <= 20; i += 1) {
    const value = adjust.toneCurve(i / 20, 0.8)
    assert.ok(value > previous, "単調増加でない")
    previous = value
  }
})

test("HDR 風トーンは暗部を明るくする", () => {
  const image = makeImage(32, 32, () => [40, 40, 40])
  adjust.applyTone(image, 0.8)
  assert.ok(image.data[0] > 60, `暗部が持ち上がっていない: ${image.data[0]}`)
})

test("アンシャープマスクはエッジの差を広げる", () => {
  const image = makeImage(32, 32, (x) => {
    const value = x < 16 ? 100 : 150
    return [value, value, value]
  })
  const edgeBefore = image.data[(16 * 32 + 16) * 4] - image.data[(16 * 32 + 15) * 4]
  assert.equal(adjust.unsharpMask(image, 0.8, 1, 1), true)
  const edgeAfter = image.data[(16 * 32 + 16) * 4] - image.data[(16 * 32 + 15) * 4]
  assert.ok(edgeAfter > edgeBefore, `エッジが強調されていない: ${edgeBefore} -> ${edgeAfter}`)
})

test("ぼかしは平坦な画像の値を変えない", () => {
  const width = 16
  const height = 16
  const flat = new Float32Array(width * height).fill(120)
  const blurred = adjust.blurLuma(flat, width, height, 2, 2)
  for (const value of blurred) {
    assert.ok(Math.abs(value - 120) < 0.001, `値が動いた: ${value}`)
  }
})

test("プリセット none は画素を変えない", () => {
  const image = makeImage(16, 16, (x, y) => [x * 8, y * 8, 120])
  const copy = Uint8ClampedArray.from(image.data)
  assert.equal(adjust.hasEffect(adjust.resolvePreset("none")), false)
  assert.equal(adjust.applyAdjustments(image, adjust.resolvePreset("none")), false)
  assert.deepEqual(Array.from(image.data), Array.from(copy))
})

test("プリセット standard は画素を変える", () => {
  const image = makeImage(32, 32, (x, y) => [100 + (x % 20), 90 + (y % 20), 80])
  const copy = Uint8ClampedArray.from(image.data)
  assert.equal(adjust.applyAdjustments(image, adjust.resolvePreset("standard")), true)
  assert.notDeepEqual(Array.from(image.data), Array.from(copy))
})

test("透明な画素は統計から除外する", () => {
  const image = makeImage(32, 32, (x) => (x < 16 ? [255, 0, 0, 0] : [100, 100, 100, 255]))
  const gains = adjust.grayWorldGains(image)
  assert.ok(Math.abs(gains.r - 1) < 0.001, `透明部分を拾っている: ${gains.r}`)
})

/** localStorage の最小互換。書き込み拒否も再現できるようにする */
function fakeStorage(options) {
  const map = new Map()
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (options && options.readonly) throw new Error("QuotaExceededError")
      map.set(key, String(value))
    },
    removeItem: (key) => map.delete(key),
  }
}

test("プリセットを保存して読み込める", () => {
  const storage = fakeStorage()
  const values = { format: "image/webp", "resize-width": "800", "rename-enabled": true }
  assert.deepEqual(
    { ...settings.savePreset(storage, "商品一覧", values) },
    { ok: true, name: "商品一覧", replaced: false },
  )
  assert.deepEqual([...settings.listPresets(storage)], ["商品一覧"])
  assert.deepEqual({ ...settings.getPreset(storage, "商品一覧") }, values)
})

test("同名で保存すると上書きになる", () => {
  const storage = fakeStorage()
  settings.savePreset(storage, "A", { format: "image/webp" })
  const result = settings.savePreset(storage, "A", { format: "image/jpeg" })
  assert.equal(result.replaced, true)
  assert.equal(settings.listPresets(storage).length, 1)
  assert.equal(settings.getPreset(storage, "A").format, "image/jpeg")
})

test("プリセット名は前後の空白を落として扱う", () => {
  const storage = fakeStorage()
  settings.savePreset(storage, "  余白あり  ", { format: "keep" })
  assert.deepEqual([...settings.listPresets(storage)], ["余白あり"])
  assert.notEqual(settings.getPreset(storage, "余白あり"), null)
})

test("空の名前では保存しない", () => {
  const storage = fakeStorage()
  const result = settings.savePreset(storage, "   ", { format: "keep" })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "empty-name")
  assert.deepEqual([...settings.listPresets(storage)], [])
})

test("保存件数の上限を超えたら断る", () => {
  const storage = fakeStorage()
  for (let i = 0; i < settings.MAX_PRESETS; i += 1) {
    assert.equal(settings.savePreset(storage, `preset-${i}`, { n: i }).ok, true)
  }
  const overflow = settings.savePreset(storage, "もう一つ", {})
  assert.equal(overflow.ok, false)
  assert.equal(overflow.reason, "limit")
  // 既存の上書きは上限に関係なく通す
  assert.equal(settings.savePreset(storage, "preset-0", { n: "updated" }).ok, true)
})

test("削除すると一覧から消える", () => {
  const storage = fakeStorage()
  settings.savePreset(storage, "A", {})
  settings.savePreset(storage, "B", {})
  assert.equal(settings.removePreset(storage, "A").ok, true)
  assert.deepEqual([...settings.listPresets(storage)], ["B"])
  assert.equal(settings.removePreset(storage, "A").reason, "missing")
})

test("書き込めないストレージでも例外を投げない", () => {
  const storage = fakeStorage({ readonly: true })
  const result = settings.savePreset(storage, "A", {})
  assert.equal(result.ok, false)
  assert.equal(result.reason, "storage")
  assert.equal(settings.saveLastUsed(storage, { a: 1 }), false)
})

test("ストレージが無くても読み書きは失敗扱いで済む", () => {
  assert.deepEqual([...settings.listPresets(null)], [])
  assert.equal(settings.getPreset(null, "A"), null)
  assert.equal(settings.loadLastUsed(null), null)
})

test("壊れた保存データは無視する", () => {
  const storage = fakeStorage()
  storage.map.set(settings.STORAGE_KEY, "{壊れた JSON")
  assert.deepEqual([...settings.listPresets(storage)], [])
  assert.equal(settings.savePreset(storage, "A", { x: 1 }).ok, true)
})

test("最後に使った設定を保存・復元できる", () => {
  const storage = fakeStorage()
  settings.saveLastUsed(storage, { format: "image/png", quality: "70" })
  assert.deepEqual({ ...settings.loadLastUsed(storage) }, { format: "image/png", quality: "70" })
})

test("既知のキーだけを取り込む（古い保存データでも壊れない）", () => {
  const defaults = { format: "smallest", quality: "80", "no-upscale": true }
  const merged = settings.mergeKnown(defaults, { format: "image/webp", 廃止された項目: "x" })
  assert.deepEqual({ ...merged }, { format: "image/webp", quality: "80", "no-upscale": true })
})

let failed = 0
for (const item of tests) {
  try {
    await item.fn()
    process.stdout.write(`ok   ${item.name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`FAIL ${item.name}\n     ${error.message}\n`)
  }
}
process.stdout.write(`\n${tests.length - failed} passed / ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
