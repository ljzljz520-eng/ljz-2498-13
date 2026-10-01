// 测试辅助：内存后端 + 1x1 PNG 原件 + 快速建资源。
import { FigureBackend } from '../src/figures/api.js'
import { BlobObjectStore, RelationalStore } from '../src/figures/storage.js'
import { concatBytes } from '../src/figures/api.js'
import { makeMarker } from '../src/figures/citations.js'

// 1x1 红 / 蓝 PNG
export const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
export const BLUE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwAEgwG/xT9MhAAAAABJRU5ErkJggg=='

export function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

// 内存版对象存储/关系库（测试隔离，不触碰浏览器 API）
class MemoryBlobStore extends BlobObjectStore {
  constructor() {
    super()
    this.dbPromise = Promise.resolve(null)
  }
  async _db() {
    return null
  }
}

class MemoryRelStore extends RelationalStore {
  constructor() {
    super()
  }
  async load() {
    return this.state
  }
  async save() {}
  async reset() {
    this.state = {
      blobs: {}, resources: {}, versions: {}, citations: {},
      manuscripts: {}, snapshots: {}, uploads: {},
    }
  }
}

export async function makeBackend({ online = true } = {}) {
  const backend = new FigureBackend({
    blobStore: new MemoryBlobStore(),
    relStore: new MemoryRelStore(),
    online,
  })
  await backend.init()
  return backend
}

// 直接把字节以分片方式上传（返回 sha/mime/size）
export async function uploadBytes(backend, ownerId, bytes, mime, { chunkSize = 32 } = {}) {
  const init = await backend.initUpload({
    ownerId,
    sha256: await digest(bytes),
    size: bytes.length,
    mime,
    chunkSize,
  })
  if (init.instant) return { sha256: await digest(bytes), mime, size: bytes.length, deduped: true }
  const total = Math.ceil(bytes.length / chunkSize)
  for (let i = 0; i < total; i += 1) {
    const part = bytes.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, bytes.length))
    // eslint-disable-next-line no-await-in-loop
    await backend.putChunk(init.uploadId, i, part)
  }
  const done = await backend.completeUpload(init.uploadId)
  return { sha256: done.sha256, mime, size: bytes.length, deduped: done.deduped, uploadId: init.uploadId }
}

export async function digest(bytes) {
  const { sha256 } = await import('../src/figures/util.js')
  return sha256(bytes)
}

export async function makeResource(backend, {
  ownerId = 'u1', bytes = b64ToBytes(RED_PNG_B64), mime = 'image/png',
  caption = '图一', alt = '红图', source = '资料室', grants = [], forceBroken = false,
} = {}) {
  const up = await uploadBytes(backend, ownerId, bytes, mime)
  const { resource, version } = await backend.createResource({
    ownerId, sha256: up.sha256, mime, caption, alt, source, grants, forceBroken,
  })
  return { resource, version, upload: up }
}

export function marker(resourceId, extra = {}) {
  return makeMarker({ resourceId, ...extra })
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { concatBytes }
