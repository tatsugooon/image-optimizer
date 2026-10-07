/**
 * 画面の組み立てとバッチ実行。
 * 変換ロジックは encoder / geometry / rename に置き、ここでは DOM 操作と進行管理だけを扱う。
 */
;(function (global) {
  "use strict"

  const { adjust, encoder, files, rename, settings: settingsStore } = global.ImgOpt
  const document = global.document

  /** プレビューの一辺の上限 */
  const PREVIEW_MAX_SIDE = 320

  const state = {
    items: [],
    ordered: [],
    running: false,
    cancelled: false,
    inputDirectoryHandle: null,
    outputDirectoryHandle: null,
    support: { "image/jpeg": true, "image/png": true, "image/webp": true, "image/avif": false },
    preview: { path: null, canvas: null, token: 0 },
    storage: null,
  }

  const el = (id) => document.getElementById(id)
  const show = (element, visible) => {
    if (element) element.hidden = !visible
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "-"
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  }

  function formatRatio(before, after) {
    if (!before) return "-"
    const diff = ((after - before) / before) * 100
    return `${diff <= 0 ? "" : "+"}${diff.toFixed(1)}%`
  }

  function selectedRadio(name) {
    const checked = document.querySelector(`input[name="${name}"]:checked`)
    return checked ? checked.value : ""
  }

  /** プリセット名から実際の調整値を組み立てる。custom のときだけ画面の値を読む */
  function readAdjustSettings() {
    const preset = el("adjust-preset").value
    if (preset !== "custom") return adjust.resolvePreset(preset)
    return {
      levels: el("adjust-levels").checked,
      whiteBalance: el("adjust-wb").checked,
      clipPercent: 0.5,
      saturation: Number(el("adjust-saturation").value) / 100,
      sharpen: Number(el("adjust-sharpen").value) / 100,
      tone: Number(el("adjust-tone").value) / 100,
    }
  }

  function readSettings() {
    const mode = selectedRadio("mode")
    const adjustSettings = readAdjustSettings()
    return {
      optimize: {
        mode,
        adjust: adjustSettings,
        ssimTarget: Number(el("ssim-target").value),
        quality: Number(el("quality").value) / 100,
        targetBytes: Math.max(1, Number(el("target-size").value)) * 1024,
        allowDownscaleForTarget: el("allow-downscale").checked,
        format: el("format").value,
        skipIfLarger: el("skip-if-larger").checked,
        noUpscale: el("no-upscale").checked,
        crop: {
          mode: el("crop-mode").value,
          aspectW: Number(el("aspect-w").value),
          aspectH: Number(el("aspect-h").value),
          anchor: el("anchor").value,
        },
        resize: {
          mode: el("resize-mode").value,
          percent: Number(el("resize-percent").value),
          width: Number(el("resize-width").value),
          height: Number(el("resize-height").value),
        },
      },
      rename: {
        enabled: el("rename-enabled").checked,
        pattern: el("rename-pattern").value,
        start: Number(el("rename-start").value),
        step: Math.max(1, Number(el("rename-step").value)),
        pad: Math.max(1, Number(el("rename-pad").value)),
        sort: el("rename-sort").value,
        extensionCase: el("extension-case").value,
        forceExtension: el("force-extension").checked,
      },
      adjust: adjustSettings,
      output: selectedRadio("output"),
      preserveStructure: el("preserve-structure").checked,
    }
  }

  /** プレビュー時点では出力形式が確定しないため、元の拡張子を仮に使う */
  function previewExtension(settings, item) {
    const format = settings.optimize.format
    if (format !== "keep" && format !== "smallest") return encoder.extensionFor(format)
    return rename.splitExtension(item.file.name).ext.toLowerCase() || "jpg"
  }

  function nameContext(item, seq, ext, result) {
    const parts = rename.splitExtension(item.file.name)
    return {
      seq,
      name: parts.base,
      srcExt: parts.ext.toLowerCase(),
      ext,
      parent: item.parent,
      width: result ? result.width : "",
      height: result ? result.height : "",
      date: new Date(),
    }
  }

  /** プリセットに保存する対象。ここに無いコントロールは保存されない */
  const CHECKBOX_FIELDS = [
    "recursive",
    "allow-downscale",
    "skip-if-larger",
    "no-upscale",
    "adjust-levels",
    "adjust-wb",
    "rename-enabled",
    "force-extension",
    "preserve-structure",
  ]

  const VALUE_FIELDS = [
    "ssim-target",
    "target-size",
    "quality",
    "format",
    "crop-mode",
    "aspect-w",
    "aspect-h",
    "anchor",
    "resize-mode",
    "resize-percent",
    "resize-width",
    "resize-height",
    "adjust-preset",
    "adjust-saturation",
    "adjust-sharpen",
    "adjust-tone",
    "rename-pattern",
    "rename-start",
    "rename-step",
    "rename-pad",
    "rename-sort",
    "extension-case",
  ]

  const RADIO_GROUPS = ["mode", "output"]

  function collectForm() {
    const values = {}
    for (const id of CHECKBOX_FIELDS) values[id] = el(id).checked
    for (const id of VALUE_FIELDS) values[id] = el(id).value
    for (const name of RADIO_GROUPS) values[name] = selectedRadio(name)
    return values
  }

  function applyForm(values) {
    if (!values) return
    for (const id of CHECKBOX_FIELDS) {
      if (typeof values[id] === "boolean") el(id).checked = values[id]
    }
    for (const id of VALUE_FIELDS) {
      if (values[id] != null) el(id).value = String(values[id])
    }
    for (const name of RADIO_GROUPS) {
      const target = document.querySelector(`input[name="${name}"][value="${values[name]}"]`)
      if (target && !target.disabled) target.checked = true
    }
    updateModeSections()
    updateFormatHint()
    renderFileList()
  }

  /** localStorage が使えない環境（プライベートモード等）では保存機能を黙って無効にする */
  function getStorage() {
    try {
      const storage = global.localStorage
      if (!storage) return null
      const probe = "image-optimizer:probe"
      storage.setItem(probe, "1")
      storage.removeItem(probe)
      return storage
    } catch {
      return null
    }
  }

  function refreshPresetList(selected) {
    const select = el("settings-preset")
    const names = settingsStore.listPresets(state.storage)
    select.textContent = ""
    const placeholder = document.createElement("option")
    placeholder.value = ""
    placeholder.textContent = names.length === 0 ? "（保存済みプリセットなし）" : "（選択すると読み込みます）"
    select.appendChild(placeholder)
    for (const name of names) {
      const option = document.createElement("option")
      option.value = name
      option.textContent = name
      select.appendChild(option)
    }
    select.value = selected && names.includes(selected) ? selected : ""
  }

  function setPresetStatus(message) {
    el("preset-status").textContent = message
  }

  function saveCurrentPreset() {
    const name = settingsStore.normalizeName(el("preset-name").value)
    if (!name) {
      setPresetStatus("プリセット名を入力してください。")
      el("preset-name").focus()
      return
    }
    const existing = settingsStore.getPreset(state.storage, name)
    if (existing && !global.confirm(`「${name}」を上書きします。よろしいですか？`)) return

    const result = settingsStore.savePreset(state.storage, name, collectForm())
    if (!result.ok) {
      const reasons = {
        limit: `保存できるプリセットは ${settingsStore.MAX_PRESETS} 件までです。不要なものを削除してください。`,
        storage: "ブラウザの保存領域に書き込めませんでした。",
        "empty-name": "プリセット名を入力してください。",
      }
      setPresetStatus(reasons[result.reason] || "保存できませんでした。")
      return
    }
    refreshPresetList(result.name)
    setPresetStatus(result.replaced ? `「${result.name}」を上書きしました。` : `「${result.name}」を保存しました。`)
  }

  function deleteSelectedPreset() {
    const name = el("settings-preset").value
    if (!name) {
      setPresetStatus("削除するプリセットを選んでください。")
      return
    }
    if (!global.confirm(`「${name}」を削除します。よろしいですか？`)) return
    const result = settingsStore.removePreset(state.storage, name)
    refreshPresetList("")
    setPresetStatus(result.ok ? `「${name}」を削除しました。` : "削除できませんでした。")
  }

  function loadSelectedPreset() {
    const name = el("settings-preset").value
    if (!name) return
    const values = settingsStore.getPreset(state.storage, name)
    if (!values) {
      refreshPresetList("")
      setPresetStatus("プリセットが見つかりませんでした。")
      return
    }
    applyForm(settingsStore.mergeKnown(collectForm(), values))
    el("preset-name").value = name
    setPresetStatus(`「${name}」を読み込みました。`)
  }

  let lastUsedTimer = null
  /** 最後に使った設定を控えておき、次回起動時に復元する */
  function scheduleLastUsedSave() {
    if (!state.storage) return
    if (lastUsedTimer) global.clearTimeout(lastUsedTimer)
    lastUsedTimer = global.setTimeout(() => {
      lastUsedTimer = null
      settingsStore.saveLastUsed(state.storage, collectForm())
    }, 400)
  }

  /** プリセットの値をスライダー類へ反映する（カスタムに切り替えたときの出発点になる） */
  function syncAdjustControls(preset) {
    if (preset === "custom") return
    const values = adjust.resolvePreset(preset)
    el("adjust-levels").checked = values.levels
    el("adjust-wb").checked = values.whiteBalance
    el("adjust-saturation").value = String(Math.round(values.saturation * 100))
    el("adjust-sharpen").value = String(Math.round(values.sharpen * 100))
    el("adjust-tone").value = String(Math.round(values.tone * 100))
  }

  function updateAdjustLabels() {
    el("adjust-saturation-value").textContent = `${el("adjust-saturation").value}%`
    el("adjust-sharpen-value").textContent = `${el("adjust-sharpen").value}%`
    el("adjust-tone-value").textContent = `${el("adjust-tone").value}%`
  }

  function drawPreview(canvasId, source, options) {
    const target = el(canvasId)
    target.width = source.width
    target.height = source.height
    const ctx = target.getContext("2d")
    ctx.drawImage(source, 0, 0)
    if (!options) return
    const imageData = ctx.getImageData(0, 0, target.width, target.height)
    if (adjust.applyAdjustments(imageData, options)) ctx.putImageData(imageData, 0, 0)
  }

  /** 1 枚目の画像で調整前後を見せる。デコード結果はファイルが変わるまで使い回す */
  async function updatePreview() {
    const settings = readSettings()
    const item = state.ordered[0]
    const active = Boolean(item) && adjust.hasEffect(settings.adjust)
    show(el("adjust-preview"), active)
    show(el("preview-note"), active)
    if (!active) return

    const token = state.preview.token + 1
    state.preview.token = token
    if (state.preview.path !== item.relativePath) {
      el("preview-note").textContent = "プレビューを準備中..."
      try {
        const canvas = await encoder.makePreviewSource(item.file, PREVIEW_MAX_SIDE)
        if (state.preview.token !== token) return
        state.preview.path = item.relativePath
        state.preview.canvas = canvas
      } catch (error) {
        state.preview.path = null
        state.preview.canvas = null
        el("preview-note").textContent = `プレビューを作れませんでした: ${error.message}`
        show(el("adjust-preview"), false)
        return
      }
    }

    drawPreview("preview-before", state.preview.canvas, null)
    drawPreview("preview-after", state.preview.canvas, settings.adjust)
    el(
      "preview-note",
    ).textContent = `プレビュー: ${item.relativePath}（縮小表示のため、シャープの効き方は実際の出力と異なります）`
  }

  let previewTimer = null
  function schedulePreview() {
    if (previewTimer) global.clearTimeout(previewTimer)
    previewTimer = global.setTimeout(() => {
      previewTimer = null
      updatePreview()
    }, 150)
  }

  /** 左カラムの対象ファイル一覧を組み直す。出力名は現在の設定での予定値 */
  function renderFileList() {
    const settings = readSettings()
    state.ordered = settings.rename.enabled ? rename.sortItems(state.items, settings.rename.sort) : state.items.slice()

    const used = new Set()
    const list = el("file-list")
    list.textContent = ""

    state.ordered.forEach((item, index) => {
      const seq = seqFor(settings, index)
      const ext = rename.applyCase(previewExtension(settings, item), settings.rename.extensionCase)
      const name = rename.buildFileName(settings.rename, nameContext(item, seq, ext), used)

      const row = document.createElement("li")
      row.className = "file-row"
      row.innerHTML = [
        `<span class="file-index">${index + 1}</span>`,
        '<span class="file-body">',
        '<span class="file-name"></span>',
        '<span class="file-output"></span>',
        '<span class="file-meta"><span class="file-size"></span><span class="file-ratio"></span></span>',
        "</span>",
        '<span class="state state-pending">待機</span>',
      ].join("")
      row.querySelector(".file-name").textContent = item.relativePath
      row.querySelector(".file-name").title = item.relativePath
      row.querySelector(".file-output").textContent = name
      row.querySelector(".file-size").textContent = formatBytes(item.size)
      list.appendChild(row)
      item.row = row
    })

    el("input-summary").textContent =
      state.items.length === 0
        ? "まだ選択されていません。"
        : `${state.items.length} 件 / 合計 ${formatBytes(state.items.reduce((total, item) => total + item.size, 0))}`
    el("run").disabled = state.items.length === 0 || state.running
    schedulePreview()
  }

  function updateRow(item, patch) {
    if (!item.row) return
    if (patch.output != null) item.row.querySelector(".file-output").textContent = patch.output
    if (patch.size != null) item.row.querySelector(".file-size").textContent = patch.size
    if (patch.ratio != null) item.row.querySelector(".file-ratio").textContent = patch.ratio
    if (patch.state != null) {
      const cell = item.row.querySelector(".state")
      cell.textContent = patch.state
      cell.className = `state ${patch.stateClass || "state-pending"}`
      cell.title = patch.detail || ""
    }
  }

  function setItems(items) {
    state.items = items
    renderFileList()
  }

  function addItems(items) {
    const known = new Set(state.items.map((item) => item.relativePath))
    const merged = state.items.concat(items.filter((item) => !known.has(item.relativePath)))
    setItems(merged)
  }

  function updateModeSections() {
    const mode = selectedRadio("mode")
    show(document.querySelector(".mode-auto"), mode === "auto")
    show(document.querySelector(".mode-target"), mode === "target")
    show(document.querySelector(".mode-quality"), mode === "quality")

    const cropMode = el("crop-mode").value
    show(document.querySelector(".crop-ratio"), cropMode === "ratio")
    show(document.querySelector(".crop-anchor"), cropMode !== "none")

    const resizeMode = el("resize-mode").value
    show(document.querySelector(".resize-percent"), resizeMode === "percent")
    show(document.querySelector(".resize-width"), ["width", "fit", "exact"].includes(resizeMode))
    show(document.querySelector(".resize-height"), ["height", "fit", "exact"].includes(resizeMode))

    show(document.querySelector(".adjust-options"), el("adjust-preset").value !== "none")
    updateAdjustLabels()
    show(document.querySelector(".rename-options"), el("rename-enabled").checked)
    show(document.querySelector(".output-directory"), selectedRadio("output") === "directory")
    el("quality-value").textContent = el("quality").value
  }

  function updateFormatHint() {
    const format = el("format").value
    const hints = {
      smallest: "WebP / JPEG / PNG（対応環境では AVIF）を試し、最小になったものを選びます。",
      keep: "元と同じ形式で再エンコードします。GIF / BMP / SVG など再エンコードできない形式は WebP か PNG になります。",
      "image/webp": "透過を保ったまま高い圧縮率が得られます。",
      "image/jpeg": "透過は白で塗り潰されます。写真向け。",
      "image/png": "可逆圧縮のため、写真では容量が増えることがあります。",
      "image/avif": "対応ブラウザでのみ書き出せます。",
    }
    let text = hints[format] || ""
    if (format === "image/avif" && !state.support["image/avif"]) {
      text = "このブラウザは AVIF を書き出せません（Chrome は非対応）。別の形式を選んでください。"
    }
    el("format-hint").textContent = text
  }

  async function ensureOutputDirectory() {
    if (state.outputDirectoryHandle) return state.outputDirectoryHandle
    const handle = await global.showDirectoryPicker({ id: "image-optimizer-output", mode: "readwrite" })
    state.outputDirectoryHandle = handle
    el("output-summary").textContent = handle.name
    return handle
  }

  function timestamp() {
    return rename.formatDate(new Date(), "YYYYMMDD-HHmmss")
  }

  async function createWriter(settings) {
    if (settings.output === "zip") return new files.ZipCollector(`images-${timestamp()}.zip`)
    const handle = await ensureOutputDirectory()
    if (state.inputDirectoryHandle && (await handle.isSameEntry?.(state.inputDirectoryHandle))) {
      const proceed = global.confirm(
        "入力元と同じフォルダに書き出します。同名ファイルは上書きされます。続けてよいですか？",
      )
      if (!proceed) return null
    }
    return new files.DirectoryWriter(handle)
  }

  async function run() {
    const settings = readSettings()
    if (settings.optimize.format === "image/avif" && !state.support["image/avif"]) {
      el("run-status").textContent = "このブラウザは AVIF を書き出せません。出力形式を変更してください。"
      return
    }

    let writer
    try {
      writer = await createWriter(settings)
    } catch (error) {
      el("run-status").textContent = `出力先を用意できませんでした: ${error.message}`
      return
    }
    if (!writer) {
      el("run-status").textContent = "中止しました。"
      return
    }

    state.running = true
    state.cancelled = false
    el("run").disabled = true
    el("progress-bar").style.width = "0"
    show(el("cancel"), true)
    show(el("result-summary"), false)

    const used = new Set()
    const totals = { before: 0, after: 0, ok: 0, kept: 0, failed: 0 }

    for (let index = 0; index < state.ordered.length; index += 1) {
      if (state.cancelled) break
      const item = state.ordered[index]
      el("run-status").textContent = `処理中 ${index + 1} / ${state.ordered.length}: ${item.relativePath}`
      updateRow(item, { state: "処理中", stateClass: "state-pending" })

      try {
        const result = await encoder.optimize(item.file, settings.optimize)
        const ext = rename.applyCase(result.ext, settings.rename.extensionCase)
        const name = rename.buildFileName(
          settings.rename,
          nameContext(item, seqFor(settings, index), ext, result),
          used,
        )
        await writer.write(settings.preserveStructure ? item.directory : "", name, result.blob)

        totals.before += result.originalSize
        totals.after += result.outputSize
        if (result.status === "kept") totals.kept += 1
        else totals.ok += 1

        const details = [`${result.width}x${result.height}`, result.mime]
        if (result.quality) details.push(`品質 ${Math.round(result.quality * 100)}`)
        if (result.ssim != null) details.push(`SSIM ${result.ssim.toFixed(4)}`)
        updateRow(item, {
          output: name,
          size: `${formatBytes(result.originalSize)} → ${formatBytes(result.outputSize)}`,
          ratio: formatRatio(result.originalSize, result.outputSize),
          state: result.status === "kept" ? "元のまま" : result.belowTarget ? "基準未達" : "完了",
          stateClass: result.status === "kept" ? "state-kept" : result.belowTarget ? "state-warn" : "state-ok",
          detail: details.join(" / "),
        })
      } catch (error) {
        totals.failed += 1
        updateRow(item, { state: "失敗", stateClass: "state-error", detail: error.message })
      }

      el("progress-bar").style.width = `${((index + 1) / state.ordered.length) * 100}%`
      await new Promise((resolve) => global.setTimeout(resolve, 0))
    }

    const cancelled = state.cancelled
    let finalized = {}
    try {
      finalized = await writer.finalize()
    } catch (error) {
      el("run-status").textContent = `出力に失敗しました: ${error.message}`
    }

    state.running = false
    state.cancelled = false
    el("run").disabled = state.items.length === 0
    show(el("cancel"), false)
    el("run-status").textContent = cancelled ? "中止しました（処理済みのぶんは出力されています）。" : "完了しました。"

    const summary = [
      `合計 ${formatBytes(totals.before)} → ${formatBytes(totals.after)}（${formatRatio(
        totals.before,
        totals.after,
      )}）`,
      `圧縮 ${totals.ok} 件`,
      `元のまま ${totals.kept} 件`,
      `失敗 ${totals.failed} 件`,
    ]
    if (finalized.kind === "zip" && finalized.size) summary.push(`ZIP ${formatBytes(finalized.size)}`)
    el("result-summary").textContent = summary.join(" / ")
    show(el("result-summary"), true)
  }

  function seqFor(settings, index) {
    return settings.rename.start + index * settings.rename.step
  }

  async function pickFolder() {
    if (files.supportsFileSystemAccess()) {
      try {
        const handle = await global.showDirectoryPicker({ id: "image-optimizer-input", mode: "read" })
        state.inputDirectoryHandle = handle
        el("input-summary").textContent = "読み込み中..."
        const collected = await files.collectFromDirectoryHandle(handle, { recursive: el("recursive").checked })
        setItems(collected)
      } catch (error) {
        if (error.name !== "AbortError") el("input-summary").textContent = `読み込みに失敗しました: ${error.message}`
      }
      return
    }
    el("dir-input").click()
  }

  function bindEvents() {
    el("pick-folder").addEventListener("click", pickFolder)
    el("pick-files").addEventListener("click", () => el("file-input").click())
    el("clear-files").addEventListener("click", () => {
      state.inputDirectoryHandle = null
      setItems([])
    })

    el("file-input").addEventListener("change", (event) => {
      addItems(files.collectFromFileList(event.target.files))
      event.target.value = ""
    })
    el("dir-input").addEventListener("change", (event) => {
      setItems(files.collectFromFileList(event.target.files))
      event.target.value = ""
    })

    const dropzone = el("dropzone")
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault()
      dropzone.classList.add("dragover")
    })
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"))
    dropzone.addEventListener("drop", async (event) => {
      event.preventDefault()
      dropzone.classList.remove("dragover")
      el("input-summary").textContent = "読み込み中..."
      state.inputDirectoryHandle = null
      addItems(await files.collectFromDataTransfer(event.dataTransfer))
    })

    el("pick-output").addEventListener("click", async () => {
      try {
        state.outputDirectoryHandle = null
        await ensureOutputDirectory()
      } catch (error) {
        if (error.name !== "AbortError") el("output-summary").textContent = `選択できませんでした: ${error.message}`
      }
    })

    el("run").addEventListener("click", () => {
      if (!state.running) run()
    })
    el("cancel").addEventListener("click", () => {
      state.cancelled = true
    })

    const rerender = [
      "rename-enabled",
      "rename-pattern",
      "rename-start",
      "rename-step",
      "rename-pad",
      "rename-sort",
      "extension-case",
      "force-extension",
      "format",
      "crop-mode",
      "resize-mode",
    ]
    for (const id of rerender) {
      el(id).addEventListener("change", () => {
        updateModeSections()
        updateFormatHint()
        renderFileList()
      })
    }
    el("rename-pattern").addEventListener("input", renderFileList)

    el("adjust-preset").addEventListener("change", () => {
      syncAdjustControls(el("adjust-preset").value)
      updateModeSections()
      schedulePreview()
    })
    for (const id of ["adjust-levels", "adjust-wb", "adjust-saturation", "adjust-sharpen", "adjust-tone"]) {
      el(id).addEventListener("input", () => {
        // 手で触ったらプリセットから外れたことを示す
        el("adjust-preset").value = "custom"
        updateModeSections()
        schedulePreview()
      })
    }
    el("quality").addEventListener("input", updateModeSections)
    for (const input of document.querySelectorAll('input[name="mode"], input[name="output"]')) {
      input.addEventListener("change", updateModeSections)
    }

    el("settings-preset").addEventListener("change", loadSelectedPreset)
    el("preset-save").addEventListener("click", saveCurrentPreset)
    el("preset-delete").addEventListener("click", deleteSelectedPreset)
    el("preset-name").addEventListener("keydown", (event) => {
      if (event.key === "Enter") saveCurrentPreset()
    })

    for (const id of CHECKBOX_FIELDS.concat(VALUE_FIELDS)) {
      el(id).addEventListener("change", scheduleLastUsedSave)
      el(id).addEventListener("input", scheduleLastUsedSave)
    }
    for (const input of document.querySelectorAll('input[name="mode"], input[name="output"]')) {
      input.addEventListener("change", scheduleLastUsedSave)
    }
  }

  async function init() {
    bindEvents()
    state.storage = getStorage()
    if (state.storage) {
      refreshPresetList("")
      applyForm(settingsStore.mergeKnown(collectForm(), settingsStore.loadLastUsed(state.storage)))
    } else {
      el("preset-save").disabled = true
      el("preset-delete").disabled = true
      el("settings-preset").disabled = true
      setPresetStatus("このブラウザでは設定を保存できません（ローカル保存領域が使えません）。")
    }
    updateModeSections()

    const hasFileSystemAccess = files.supportsFileSystemAccess()
    if (!hasFileSystemAccess) {
      const zipRadio = document.querySelector('input[name="output"][value="zip"]')
      const directoryRadio = document.querySelector('input[name="output"][value="directory"]')
      zipRadio.checked = true
      directoryRadio.disabled = true
      updateModeSections()
    }

    state.support = await encoder.detectSupport()
    updateFormatHint()

    const available = Object.keys(state.support)
      .filter((mime) => state.support[mime])
      .map((mime) => encoder.extensionFor(mime).toUpperCase())
    el("env-note").textContent = hasFileSystemAccess
      ? `出力可能な形式: ${available.join(" / ")}`
      : `出力可能な形式: ${available.join(
          " / ",
        )}（このブラウザではフォルダ書き出しに未対応のため ZIP でダウンロードします。file:// で開いている場合はローカルサーバー経由で開くとフォルダ書き出しが使えます）`
  }

  document.addEventListener("DOMContentLoaded", init)
})(typeof window !== "undefined" ? window : globalThis)
