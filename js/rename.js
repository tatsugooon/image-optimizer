/**
 * リネームパターンの展開。
 * DOM に依存しない純関数だけを置き、Node からもテストできるようにしている。
 */
;(function (global) {
  "use strict"

  // ファイル名に使えない文字（パス区切りと制御文字を含む）
  const INVALID_CHARS = /[\\/:*?"<>|]|[\x00-\x1f]/g

  const TOKEN_ALIASES = {
    連番: "seq",
    seq: "seq",
    n: "seq",
    名前: "name",
    name: "name",
    拡張子: "ext",
    ext: "ext",
    元拡張子: "srcext",
    srcext: "srcext",
    日付: "date",
    date: "date",
    時刻: "time",
    time: "time",
    幅: "width",
    width: "width",
    w: "width",
    高さ: "height",
    height: "height",
    h: "height",
    親フォルダ: "parent",
    parent: "parent",
  }

  function isDate(value) {
    return Boolean(value) && typeof value.getFullYear === "function"
  }

  function pad(value, length) {
    const text = String(value)
    return text.length >= length ? text : "0".repeat(length - text.length) + text
  }

  /** YYYY / MM / DD / HH / mm / ss だけを置き換える簡易フォーマッタ */
  function formatDate(date, format) {
    const map = {
      YYYY: String(date.getFullYear()),
      MM: pad(date.getMonth() + 1, 2),
      DD: pad(date.getDate(), 2),
      HH: pad(date.getHours(), 2),
      mm: pad(date.getMinutes(), 2),
      ss: pad(date.getSeconds(), 2),
    }
    return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (matched) => map[matched])
  }

  /** 使えない文字を落とす。パス区切りも潰してディレクトリ外への書き出しを防ぐ */
  function sanitizeSegment(text) {
    const cleaned = String(text).replace(INVALID_CHARS, "_").replace(/\s+/g, " ").trim()
    const withoutLeadingDots = cleaned.replace(/^\.+/, "")
    return withoutLeadingDots.length > 0 ? withoutLeadingDots.slice(0, 180) : "image"
  }

  function splitExtension(fileName) {
    const text = String(fileName)
    const index = text.lastIndexOf(".")
    if (index <= 0) return { base: text, ext: "" }
    return { base: text.slice(0, index), ext: text.slice(index + 1) }
  }

  /**
   * パターン中の {トークン} を展開する。未知のトークンはそのまま残す。
   * context: { seq, name, ext, srcExt, width, height, parent, date, seqPad }
   */
  function renderPattern(pattern, context) {
    const date = isDate(context.date) ? context.date : new Date()
    return String(pattern).replace(/\{([^{}]+)\}/g, (whole, body) => {
      const separator = body.indexOf(":")
      const rawKey = (separator === -1 ? body : body.slice(0, separator)).trim()
      const argument = separator === -1 ? "" : body.slice(separator + 1).trim()
      const key = TOKEN_ALIASES[rawKey]
      if (!key) return whole

      switch (key) {
        case "seq": {
          const length = argument ? Number(argument) : Number(context.seqPad || 1)
          return pad(context.seq, Number.isFinite(length) && length > 0 ? length : 1)
        }
        case "name":
          return context.name == null ? "" : String(context.name)
        case "ext":
          return context.ext == null ? "" : String(context.ext)
        case "srcext":
          return context.srcExt == null ? "" : String(context.srcExt)
        case "date":
          return formatDate(date, argument || "YYYYMMDD")
        case "time":
          return formatDate(date, argument || "HHmmss")
        case "width":
          return context.width == null ? "" : String(context.width)
        case "height":
          return context.height == null ? "" : String(context.height)
        case "parent":
          return context.parent == null ? "" : String(context.parent)
        default:
          return whole
      }
    })
  }

  function applyCase(text, mode) {
    if (mode === "upper") return String(text).toUpperCase()
    if (mode === "keep") return String(text)
    return String(text).toLowerCase()
  }

  /**
   * 拡張子をそろえる。
   * force=true のときは、パターンに書かれた拡張子より実際の出力形式を優先する。
   */
  function applyExtension(fileName, ext, force) {
    if (!ext) return fileName
    const parts = splitExtension(fileName)
    if (!parts.ext) return `${fileName}.${ext}`
    if (parts.ext.toLowerCase() === ext.toLowerCase()) return fileName
    return force ? `${parts.base}.${ext}` : fileName
  }

  /** 同名衝突を -2, -3 ... で回避する。used は小文字化した名前の Set */
  function resolveCollision(fileName, used) {
    const parts = splitExtension(fileName)
    let candidate = fileName
    let counter = 2
    while (used.has(candidate.toLowerCase())) {
      candidate = parts.ext ? `${parts.base}-${counter}.${parts.ext}` : `${parts.base}-${counter}`
      counter += 1
    }
    used.add(candidate.toLowerCase())
    return candidate
  }

  /**
   * 出力ファイル名を組み立てる。
   * settings: { enabled, pattern, pad, extensionCase, forceExtension }
   */
  function buildFileName(settings, context, used) {
    const ext = applyCase(context.ext || "", settings.extensionCase)
    let name
    if (settings.enabled && settings.pattern) {
      const rendered = renderPattern(settings.pattern, { ...context, ext, seqPad: settings.pad })
      name = sanitizeSegment(rendered)
    } else {
      name = sanitizeSegment(context.name)
    }
    name = applyExtension(name, ext, settings.forceExtension !== false)
    return used ? resolveCollision(name, used) : name
  }

  const collator = typeof Intl !== "undefined" ? new Intl.Collator("ja", { numeric: true, sensitivity: "base" }) : null

  /** items は { relativePath, size, lastModified } を持つ想定 */
  function sortItems(items, key) {
    const byName = (a, b) =>
      collator ? collator.compare(a.relativePath, b.relativePath) : a.relativePath.localeCompare(b.relativePath)
    const comparators = {
      name: byName,
      "name-desc": (a, b) => byName(b, a),
      mtime: (a, b) => (a.lastModified || 0) - (b.lastModified || 0),
      "mtime-desc": (a, b) => (b.lastModified || 0) - (a.lastModified || 0),
      size: (a, b) => a.size - b.size,
      "size-desc": (a, b) => b.size - a.size,
    }
    return items.slice().sort(comparators[key] || byName)
  }

  global.ImgOpt = global.ImgOpt || {}
  global.ImgOpt.rename = {
    formatDate,
    sanitizeSegment,
    splitExtension,
    renderPattern,
    applyCase,
    applyExtension,
    resolveCollision,
    buildFileName,
    sortItems,
    pad,
  }
})(typeof window !== "undefined" ? window : globalThis)
