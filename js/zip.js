/**
 * 無圧縮（store）ZIP の書き出し。
 * 画像は既に圧縮済みなので deflate は使わず、外部ライブラリ無しで完結させる。
 */
;(function (global) {
  "use strict"

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let value = i
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      table[i] = value >>> 0
    }
    return table
  })()

  function crc32(bytes) {
    let crc = 0xffffffff
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  function isDate(value) {
    return Boolean(value) && typeof value.getFullYear === "function"
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear())
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    }
  }

  class ZipWriter {
    constructor() {
      this.entries = []
      this.parts = []
      this.offset = 0
    }

    /** name はディレクトリ区切りに "/" を使う。bytes は Uint8Array */
    add(name, bytes, modifiedAt) {
      const encoder = new TextEncoder()
      const nameBytes = encoder.encode(name)
      const crc = crc32(bytes)
      const stamp = dosDateTime(isDate(modifiedAt) ? modifiedAt : new Date())

      const header = new Uint8Array(30 + nameBytes.length)
      const view = new DataView(header.buffer)
      view.setUint32(0, 0x04034b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 0x0800, true) // ファイル名を UTF-8 として扱わせる
      view.setUint16(8, 0, true) // store
      view.setUint16(10, stamp.time, true)
      view.setUint16(12, stamp.date, true)
      view.setUint32(14, crc, true)
      view.setUint32(18, bytes.length, true)
      view.setUint32(22, bytes.length, true)
      view.setUint16(26, nameBytes.length, true)
      view.setUint16(28, 0, true)
      header.set(nameBytes, 30)

      this.parts.push(header, bytes)
      this.entries.push({ nameBytes, crc, size: bytes.length, offset: this.offset, stamp })
      this.offset += header.length + bytes.length
    }

    blob() {
      const centralParts = []
      let centralSize = 0
      for (const entry of this.entries) {
        const record = new Uint8Array(46 + entry.nameBytes.length)
        const view = new DataView(record.buffer)
        view.setUint32(0, 0x02014b50, true)
        view.setUint16(4, 20, true)
        view.setUint16(6, 20, true)
        view.setUint16(8, 0x0800, true)
        view.setUint16(10, 0, true)
        view.setUint16(12, entry.stamp.time, true)
        view.setUint16(14, entry.stamp.date, true)
        view.setUint32(16, entry.crc, true)
        view.setUint32(20, entry.size, true)
        view.setUint32(24, entry.size, true)
        view.setUint16(28, entry.nameBytes.length, true)
        view.setUint32(42, entry.offset, true)
        record.set(entry.nameBytes, 46)
        centralParts.push(record)
        centralSize += record.length
      }

      const end = new Uint8Array(22)
      const endView = new DataView(end.buffer)
      endView.setUint32(0, 0x06054b50, true)
      endView.setUint16(8, this.entries.length, true)
      endView.setUint16(10, this.entries.length, true)
      endView.setUint32(12, centralSize, true)
      endView.setUint32(16, this.offset, true)

      return new Blob([...this.parts, ...centralParts, end], { type: "application/zip" })
    }
  }

  global.ImgOpt = global.ImgOpt || {}
  global.ImgOpt.zip = { ZipWriter, crc32 }
})(typeof window !== "undefined" ? window : globalThis)
