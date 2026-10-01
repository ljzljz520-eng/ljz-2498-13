// 存储适配层：
// - BlobObjectStore：对象存储，按 sha256 内容寻址；同内容物理上只保留一份原件。
// - RelationalStore：关系库，JSON 表（localStorage），失败回退内存。
// 适配接口与真实后端（S3 + RDBMS）一一对应，便于整体替换。

import { toBytes } from './util.js'

const DB_NAME = 'catalpa-figures'
const BLOB_STORE = 'blobs'
const CHUNK_STORE = 'upload-chunks'
const REL_KEY = 'catalpa.figures.relational.v1'

function idbAvailable() {
  return typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function'
}

function openIdb() {
  return new Promise((resolve, reject) => {
    if (!idbAvailable()) {
      reject(new Error('no-indexeddb'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE)
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        db.createObjectStore(CHUNK_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const r = tx.objectStore(storeName).get(key)
    r.onsuccess = () => resolve(r.result ?? null)
    r.onerror = () => reject(r.error)
  })
}

function idbPut(db, storeName, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbDelete(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbAllKeys(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const r = tx.objectStore(storeName).getAllKeys()
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export class BlobObjectStore {
  constructor() {
    this.memory = new Map()
    this.chunkMemory = new Map()
    this.dbPromise = null
    this.usingIdb = false
  }

  async _db() {
    if (this.dbPromise) return this.dbPromise
    this.dbPromise = openIdb()
      .then((db) => {
        this.usingIdb = true
        return db
      })
      .catch(() => null)
    return this.dbPromise
  }

  // 返回 true 表示新写入；false 表示原件已存在（内容寻址共享存储）。
  async put(sha, bytes) {
    const data = toBytes(bytes)
    const db = await this._db()
    if (db) {
      const existing = await idbGet(db, BLOB_STORE, sha)
      if (existing) return false
      await idbPut(db, BLOB_STORE, sha, data.slice().buffer)
      return true
    }
    if (this.memory.has(sha)) return false
    this.memory.set(sha, data.slice())
    return true
  }

  async get(sha) {
    const db = await this._db()
    if (db) {
      const value = await idbGet(db, BLOB_STORE, sha)
      if (!value) return null
      return new Uint8Array(value)
    }
    const value = this.memory.get(sha)
    return value ? value.slice() : null
  }

  async has(sha) {
    const db = await this._db()
    if (db) return (await idbGet(db, BLOB_STORE, sha)) != null
    return this.memory.has(sha)
  }

  async delete(sha) {
    const db = await this._db()
    if (db) {
      await idbDelete(db, BLOB_STORE, sha)
      return
    }
    this.memory.delete(sha)
  }

  async keys() {
    const db = await this._db()
    if (db) return idbAllKeys(db, BLOB_STORE)
    return [...this.memory.keys()]
  }

  // ---- 分片暂存（键：uploadId/chunkIndex），离线时落本地，上线后续传 ----
  async putChunk(uploadId, index, bytes) {
    const data = toBytes(bytes)
    const key = `${uploadId}/${index}`
    const db = await this._db()
    if (db) {
      await idbPut(db, CHUNK_STORE, key, data.slice().buffer)
      return
    }
    this.chunkMemory.set(key, data.slice())
  }

  async getChunk(uploadId, index) {
    const key = `${uploadId}/${index}`
    const db = await this._db()
    if (db) {
      const value = await idbGet(db, CHUNK_STORE, key)
      return value ? new Uint8Array(value) : null
    }
    const value = this.chunkMemory.get(key)
    return value ? value.slice() : null
  }

  async hasChunk(uploadId, index) {
    const key = `${uploadId}/${index}`
    const db = await this._db()
    if (db) return (await idbGet(db, CHUNK_STORE, key)) != null
    return this.chunkMemory.has(key)
  }

  async listChunks(uploadId, total) {
    const received = []
    for (let i = 0; i < total; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await this.hasChunk(uploadId, i)) received.push(i)
    }
    return received
  }

  async clearChunks(uploadId, total) {
    const db = await this._db()
    for (let i = 0; i < total; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (db) await idbDelete(db, CHUNK_STORE, `${uploadId}/${i}`)
      else this.chunkMemory.delete(`${uploadId}/${i}`)
    }
  }
}

const EMPTY_STATE = () => ({
  blobs: {}, // sha -> { sha256, size, createdAt }  元数据行（原件在对象存储）
  resources: {}, // resourceId -> Resource
  versions: {}, // versionId -> Version
  citations: {}, // instanceId -> Citation
  manuscripts: {}, // docId -> { docId, body, versionNo, updatedAt }
  snapshots: {}, // snapshotId -> Snapshot
  uploads: {}, // uploadId -> UploadSession
})

export class RelationalStore {
  constructor() {
    this.state = EMPTY_STATE()
    this.loaded = false
  }

  async load() {
    if (this.loaded) return this.state
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(REL_KEY)
        if (raw) this.state = { ...EMPTY_STATE(), ...JSON.parse(raw) }
      } catch {
        // 损坏数据回退空库
      }
    }
    this.loaded = true
    return this.state
  }

  async save() {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(REL_KEY, JSON.stringify(this.state))
      } catch {
        // 容量/隐私模式：仅内存态
      }
    }
  }

  async reset() {
    this.state = EMPTY_STATE()
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(REL_KEY)
      } catch {
        // ignore
      }
    }
  }
}
