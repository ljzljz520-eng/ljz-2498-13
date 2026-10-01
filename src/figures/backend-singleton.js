// 全局后端单例（页面生命周期），并播种演示数据。
import { FigureBackend } from './api.js'
import { BlobObjectStore, RelationalStore } from './storage.js'
import { Uploader } from './uploader.js'

const SEED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

export async function createBackend({ seed = true, online = true } = {}) {
  const backend = await new FigureBackend({
    blobStore: new BlobObjectStore(),
    relStore: new RelationalStore(),
    online,
  }).init()
  const uploader = new Uploader(backend, { chunkSize: 64 * 1024 })
  if (seed) await seedIfEmpty(backend)
  return { backend, uploader }
}

async function seedIfEmpty(backend) {
  if (Object.keys(backend.state.resources).length > 0) return
  const bytes = b64ToBytes(SEED_PNG)
  const digest = await crypto.subtle.digest('SHA-256', bytes).then((buf) =>
    [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join(''))
  // 直接落一个原件
  await backend.blobStore.put(digest, bytes)
  backend.state.blobs[digest] = { sha256: digest, size: bytes.length, createdAt: Date.now() }
  const { resource } = await backend.createResource({
    ownerId: 'u1',
    sha256: digest,
    mime: 'image/png',
    caption: '示例图片（1×1 PNG）',
    alt: '红色示例像素',
    source: '系统示例库',
    grants: [{ principal: 'guest', level: 'read' }],
  })
  backend.state.manuscripts['doc1'] = {
    docId: 'doc1',
    body: '',
    versionNo: 0,
    updatedAt: Date.now(),
  }
  await backend.relStore.save()
  return resource.id
}

export { SEED_PNG }
