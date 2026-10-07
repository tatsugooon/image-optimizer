/**
 * 設定プリセットの保存と読み込み。
 * 保存先（localStorage 互換オブジェクト）は引数で受け取り、DOM には触れない。
 */
;(function (global) {
  "use strict"

  const STORAGE_KEY = "image-optimizer:presets"
  const LAST_USED_KEY = "image-optimizer:last-used"
  const MAX_NAME_LENGTH = 60
  const MAX_PRESETS = 50

  function normalizeName(name) {
    return String(name == null ? "" : name)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME_LENGTH)
  }

  function readJson(storage, key) {
    if (!storage) return null
    try {
      const raw = storage.getItem(key)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      // 壊れた JSON や無効化されたストレージは「保存なし」として扱う
      return null
    }
  }

  function writeJson(storage, key, value) {
    if (!storage) return false
    try {
      storage.setItem(key, JSON.stringify(value))
      return true
    } catch {
      // 容量超過やプライベートモードでの拒否
      return false
    }
  }

  function readStore(storage) {
    const store = readJson(storage, STORAGE_KEY)
    return store === null ? {} : store
  }

  /** 保存済みプリセット名を五十音・英数字混在でも安定した順に並べる */
  function listPresets(storage) {
    const names = Object.keys(readStore(storage))
    const collator = typeof Intl !== "undefined" ? new Intl.Collator("ja", { numeric: true }) : null
    return collator ? names.sort((a, b) => collator.compare(a, b)) : names.sort()
  }

  function getPreset(storage, name) {
    const store = readStore(storage)
    const key = normalizeName(name)
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
  }

  /**
   * 保存する。戻り値は { ok, reason, name }。
   * reason: "empty-name"（名前なし） / "limit"（上限超過） / "storage"（書き込み拒否）
   */
  function savePreset(storage, name, values) {
    const key = normalizeName(name)
    if (!key) return { ok: false, reason: "empty-name", name: key }
    const store = readStore(storage)
    const isNew = !Object.prototype.hasOwnProperty.call(store, key)
    if (isNew && Object.keys(store).length >= MAX_PRESETS) {
      return { ok: false, reason: "limit", name: key }
    }
    store[key] = values
    if (!writeJson(storage, STORAGE_KEY, store)) return { ok: false, reason: "storage", name: key }
    return { ok: true, name: key, replaced: !isNew }
  }

  function removePreset(storage, name) {
    const key = normalizeName(name)
    const store = readStore(storage)
    if (!Object.prototype.hasOwnProperty.call(store, key)) return { ok: false, reason: "missing", name: key }
    delete store[key]
    if (!writeJson(storage, STORAGE_KEY, store)) return { ok: false, reason: "storage", name: key }
    return { ok: true, name: key }
  }

  function saveLastUsed(storage, values) {
    return writeJson(storage, LAST_USED_KEY, values)
  }

  function loadLastUsed(storage) {
    return readJson(storage, LAST_USED_KEY)
  }

  /** 保存後にコントロールが増減しても壊れないよう、既知のキーだけを取り込む */
  function mergeKnown(defaults, stored) {
    const merged = { ...defaults }
    if (!stored) return merged
    for (const key of Object.keys(defaults)) {
      if (Object.prototype.hasOwnProperty.call(stored, key)) merged[key] = stored[key]
    }
    return merged
  }

  global.ImgOpt = global.ImgOpt || {}
  global.ImgOpt.settings = {
    STORAGE_KEY,
    LAST_USED_KEY,
    MAX_NAME_LENGTH,
    MAX_PRESETS,
    normalizeName,
    readStore,
    listPresets,
    getPreset,
    savePreset,
    removePreset,
    saveLastUsed,
    loadLastUsed,
    mergeKnown,
  }
})(typeof window !== "undefined" ? window : globalThis)
