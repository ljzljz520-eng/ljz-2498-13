// 通用工具：编码、内容哈希、图片可解码探测、异步互斥、HTML 转义
// 同时可在 Node 20（node --test）与浏览器中运行。

export function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') {
    if (globalThis.TextEncoder) return new TextEncoder().encode(value)
    return Uint8Array.from(Buffer.from(value, 'utf8'))
  }
  if (value && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer)
  }
  throw new TypeError('不支持的字节类型')
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export async function sha256(bytes) {
  const data = toBytes(bytes)
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  // Node 兜底
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(Buffer.from(data)).digest('hex')
}

export function toBase64(bytes) {
  const data = toBytes(bytes)
  if (typeof btoa === 'function') {
    let bin = ''
    for (let i = 0; i < data.length; i += 1) bin += String.fromCharCode(data[i])
    return btoa(bin)
  }
  return Buffer.from(data).toString('base64')
}

export function fromBase64(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

// 读取常见图片签名。浏览器端额外用 createImageBitmap 复核；Node 端只验签名。
const SIGNATURES = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offsetCheck: { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
]

export function sniffImage(bytes) {
  const data = toBytes(bytes)
  for (const sig of SIGNATURES) {
    if (data.length < sig.bytes.length) continue
    let ok = sig.bytes.every((b, i) => data[i] === b)
    if (ok && sig.offsetCheck) {
      ok = sig.offsetCheck.bytes.every((b, i) => data[sig.offsetCheck.at + i] === b)
    }
    if (ok) return sig.mime
  }
  return null
}

// 模拟“图片解码”：签名不符即失败；浏览器中再尝试原生解码以更贴近真实。
export async function decodeProbe(bytes, mimeHint) {
  const data = toBytes(bytes)
  const sniffed = sniffImage(data)
  if (!sniffed || (mimeHint && mimeHint !== sniffed)) {
    return { decodable: false, reason: 'not-an-image' }
  }
  if (typeof createImageBitmap === 'function') {
    try {
      const type = sniffed === 'image/jpeg' ? 'image/jpeg' : sniffed
      await createImageBitmap(new Blob([data], { type }))
    } catch {
      return { decodable: false, reason: 'decode-failed' }
    }
  }
  return { decodable: true, mime: sniffed }
}

// 异步互斥：所有状态写操作串行化，保证并发上传/发布/GC 的安全边界。
export class Mutex {
  constructor() {
    this.tail = Promise.resolve()
  }

  async run(task) {
    const release = this.tail.then(() => {})
    this.tail = release.catch(() => {})
    await release
    try {
      return await task()
    } finally {
      // release 在 microtask 中闭合
    }
  }
}

let idCounter = 0
export function id(prefix) {
  idCounter = (idCounter + 1) % 1_000_000
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeAttr(text) {
  return escapeHtml(text)
}

export class ExportGateError extends Error {
  constructor(problems) {
    super(`正式导出门禁未通过：${problems.length} 个问题`)
    this.name = 'ExportGateError'
    this.problems = problems
  }
}
