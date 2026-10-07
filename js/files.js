/**
 * 入力ファイルの収集と出力先への書き出し。
 * File System Access API が使えない場合は ZIP にまとめてダウンロードする。
 */
;(function (global) {
  "use strict"

  const IMAGE_EXTENSIONS = new Set([
    "jpg",
    "jpeg",
    "jpe",
    "jfif",
    "png",
    "webp",
    "avif",
    "gif",
    "bmp",
    "ico",
    "svg",
    "tif",
    "tiff",
    "heic",
    "heif",
  ])

  const MAX_DEPTH = 12

  function isImageName(name) {
    return IMAGE_EXTENSIONS.has(global.ImgOpt.rename.splitExtension(name).ext.toLowerCase())
  }

  function toItem(file, relativePath) {
    const segments = relativePath.split("/")
    return {
      file,
      relativePath,
      directory: segments.slice(0, -1).join("/"),
      parent: segments.length > 1 ? segments[segments.length - 2] : "",
      size: file.size,
      lastModified: file.lastModified,
    }
  }

  async function collectFromDirectoryHandle(directoryHandle, options) {
    const items = []
    const recursive = !options || options.recursive !== false

    async function walk(handle, prefix, depth) {
      if (depth > MAX_DEPTH) return
      for await (const entry of handle.values()) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.kind === "file") {
          if (!isImageName(entry.name)) continue
          items.push(toItem(await entry.getFile(), path))
        } else if (recursive && !entry.name.startsWith(".")) {
          await walk(entry, path, depth + 1)
        }
      }
    }

    await walk(directoryHandle, "", 0)
    return items
  }

  function collectFromFileList(fileList) {
    const items = []
    for (const file of Array.from(fileList)) {
      if (!isImageName(file.name)) continue
      items.push(toItem(file, file.webkitRelativePath || file.name))
    }
    return items
  }

  /** ドラッグ&ドロップ。ディレクトリを落とされた場合は再帰的にたどる */
  async function collectFromDataTransfer(dataTransfer) {
    const entries = []
    for (const item of Array.from(dataTransfer.items || [])) {
      if (item.kind !== "file") continue
      const entry = item.webkitGetAsEntry?.()
      if (entry) entries.push(entry)
    }
    if (entries.length === 0) return collectFromFileList(dataTransfer.files || [])

    const items = []

    function readEntries(reader) {
      return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    }

    async function walk(entry, prefix, depth) {
      if (depth > MAX_DEPTH) return
      if (entry.isFile) {
        if (!isImageName(entry.name)) return
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
        items.push(toItem(file, prefix ? `${prefix}/${entry.name}` : entry.name))
        return
      }
      if (!entry.isDirectory || entry.name.startsWith(".")) return
      const reader = entry.createReader()
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      let batch = await readEntries(reader)
      while (batch.length > 0) {
        for (const child of batch) {
          await walk(child, path, depth + 1)
        }
        batch = await readEntries(reader)
      }
    }

    for (const entry of entries) {
      await walk(entry, "", 0)
    }
    return items
  }

  function supportsFileSystemAccess() {
    return typeof global.showDirectoryPicker === "function"
  }

  /** 出力先フォルダに直接書き出す */
  class DirectoryWriter {
    constructor(directoryHandle) {
      this.directoryHandle = directoryHandle
      this.cache = new Map()
    }

    async resolveDirectory(relativeDirectory) {
      if (!relativeDirectory) return this.directoryHandle
      if (this.cache.has(relativeDirectory)) return this.cache.get(relativeDirectory)
      let handle = this.directoryHandle
      for (const segment of relativeDirectory.split("/")) {
        if (!segment || segment === "." || segment === "..") continue
        handle = await handle.getDirectoryHandle(segment, { create: true })
      }
      this.cache.set(relativeDirectory, handle)
      return handle
    }

    async write(relativeDirectory, fileName, blob) {
      const directory = await this.resolveDirectory(relativeDirectory)
      const fileHandle = await directory.getFileHandle(fileName, { create: true })
      const stream = await fileHandle.createWritable()
      await stream.write(blob)
      await stream.close()
    }

    async finalize() {
      return { kind: "directory" }
    }
  }

  /** ZIP に集めて最後にダウンロードさせる */
  class ZipCollector {
    constructor(zipName) {
      this.writer = new global.ImgOpt.zip.ZipWriter()
      this.zipName = zipName || "compressed.zip"
      this.count = 0
    }

    async write(relativeDirectory, fileName, blob) {
      const path = relativeDirectory ? `${relativeDirectory}/${fileName}` : fileName
      this.writer.add(path, new Uint8Array(await blob.arrayBuffer()), new Date())
      this.count += 1
    }

    async finalize() {
      if (this.count === 0) return { kind: "zip", skipped: true }
      const blob = this.writer.blob()
      const url = URL.createObjectURL(blob)
      const link = global.document.createElement("a")
      link.href = url
      link.download = this.zipName
      link.click()
      global.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return { kind: "zip", size: blob.size }
    }
  }

  global.ImgOpt = global.ImgOpt || {}
  global.ImgOpt.files = {
    IMAGE_EXTENSIONS,
    isImageName,
    collectFromDirectoryHandle,
    collectFromFileList,
    collectFromDataTransfer,
    supportsFileSystemAccess,
    DirectoryWriter,
    ZipCollector,
  }
})(typeof window !== "undefined" ? window : globalThis)
