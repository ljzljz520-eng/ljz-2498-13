// 图片脚注资源库 API（浏览器内全链路模拟，契约对应真实服务端）。
// 所有写操作经单一 mutex 串行化；GC / 发布 / completeUpload 互斥，杜绝竞态删除。

import { BlobObjectStore, RelationalStore } from './storage.js'
import { Mutex, id, sha256, bytesEqual, decodeProbe, toBase64 } from './util.js'
import { parseCitations } from './citations.js'
import { computeReachable, verifyConsistency, runGC } from './gc.js'
import { exportArtifact, evaluateRefs } from './export-gate.js'

export class ConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConflictError'
  }
}

export class FigureBackend {
  constructor({ blobStore = new BlobObjectStore(), relStore = new RelationalStore(), online = true } = {}) {
    this.blobStore = blobStore
    this.relStore = relStore
    this.mutex = new Mutex()
    this.online = online
  }

  async init() {
    this.state = await this.relStore.load()
    return this
  }

  async _persist() {
    await this.relStore.save()
  }

  setOnline(value) {
    this.online = value
  }

  // ---------- 分片上传 ----------

  // 幂等：同一 (owner, sha, size) 可复用 open 会话（续传）；对象已存在则秒完成。
  async initUpload({ ownerId, sha256: clientSha, size, mime, chunkSize = 256 * 1024 }) {
    return this.mutex.run(async () => {
      if (this.state.blobs[clientSha]) {
        return { instant: true, uploadId: null, received: [], totalChunks: 0, sha256: clientSha }
      }
      const existing = Object.values(this.state.uploads).find(
        (u) => u.ownerId === ownerId && u.sha256 === clientSha && u.size === size && u.status === 'open'
      )
      if (existing) {
        return {
          instant: false,
          uploadId: existing.uploadId,
          received: [...existing.received],
          totalChunks: existing.totalChunks,
          resumed: true,
        }
      }
      const totalChunks = Math.max(1, Math.ceil(size / chunkSize))
      const uploadId = id('up')
      this.state.uploads[uploadId] = {
        uploadId,
        ownerId,
        sha256: clientSha,
        size,
        mime,
        chunkSize,
        totalChunks,
        received: [],
        status: 'open',
        createdAt: Date.now(),
      }
      await this._persist()
      return { instant: false, uploadId, received: [], totalChunks, resumed: false }
    })
  }

  // 幂等写入：同一分片重复提交不报错；离线时分片仍落本地暂存（离线续传），
  // 但标记 pendingRemote，上线后由 syncOffline 重放。
  async putChunk(uploadId, index, bytes) {
    const data = new Uint8Array(bytes)
    // 先落本地暂存（无论在线与否），崩溃/刷新后仍可探测续传。
    await this.blobStore.putChunk(uploadId, index, data)
    if (!this.online) {
      return { stored: true, synced: false, index, offline: true }
    }
    return this.mutex.run(async () => {
      const session = this.state.uploads[uploadId]
      if (!session) throw new Error('上传会话不存在或已结束')
      if (session.status !== 'open') throw new Error(`上传会话已 ${session.status}`)
      if (index < 0 || index >= session.totalChunks) throw new RangeError('分片序号越界')
      if (!session.received.includes(index)) session.received.push(index)
      session.received.sort((a, b) => a - b)
      await this._persist()
      return { stored: true, synced: true, index, received: [...session.received] }
    })
  }

  // 恢复页面后探测已暂存分片（即使服务器会话状态丢失也能重建）。
  async probeSession(uploadId) {
    return this.mutex.run(async () => {
      const session = this.state.uploads[uploadId]
      if (!session) return null
      const onDisk = await this.blobStore.listChunks(uploadId, session.totalChunks)
      // 本地暂存是更全的真相（离线写入可能尚未同步会话状态）。
      session.received = onDisk
      await this._persist()
      return { ...session, received: onDisk }
    })
  }

  async completeUpload(uploadId) {
    return this.mutex.run(async () => {
      const session = this.state.uploads[uploadId]
      if (!session) throw new Error('上传会话不存在')
      if (session.status === 'committed') return { sha256: session.sha256, reused: true }
      if (session.status !== 'open') throw new Error(`上传会话已 ${session.status}`)
      if (!this.online) {
        const err = new Error('当前离线：分片已本地暂存，联网后可断点续传并完成')
        err.code = 'OFFLINE_PENDING'
        err.uploadId = uploadId
        throw err
      }
      const onDisk = await this.blobStore.listChunks(uploadId, session.totalChunks)
      if (onDisk.length !== session.totalChunks) {
        const missing = []
        for (let i = 0; i < session.totalChunks; i += 1) {
          if (!onDisk.includes(i)) missing.push(i)
        }
        const err = new Error(`分片不完整，缺少 ${missing.length} 片`)
        err.code = 'MISSING_CHUNKS'
        err.missingChunks = missing
        throw err
      }
      const parts = []
      for (let i = 0; i < session.totalChunks; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        parts.push(await this.blobStore.getChunk(uploadId, i))
      }
      const whole = concatBytes(parts)
      if (whole.length !== session.size) throw new Error('字节数与声明不符')
      const actual = await sha256(whole)
      if (actual !== session.sha256) throw new Error('内容哈希校验失败')
      const isNew = await this.blobStore.put(session.sha256, whole)
      if (!this.state.blobs[session.sha256]) {
        this.state.blobs[session.sha256] = {
          sha256: session.sha256,
          size: whole.length,
          createdAt: Date.now(),
        }
      }
      session.status = 'committed'
      await this.blobStore.clearChunks(uploadId, session.totalChunks)
      await this._persist()
      return { sha256: session.sha256, deduped: !isNew }
    })
  }

  async abortUpload(uploadId) {
    return this.mutex.run(async () => {
      const session = this.state.uploads[uploadId]
      if (session) {
        session.status = 'aborted'
        await this.blobStore.clearChunks(uploadId, session.totalChunks)
        await this._persist()
      }
      return { ok: true }
    })
  }

  // ---------- 资源与版本（逻辑身份） ----------

  async createResource({ ownerId, sha256: sha, mime, caption = '', alt = '', source = '', grants = [], forceBroken = false }) {
    return this.mutex.run(async () => {
      if (!this.state.blobs[sha]) throw new Error('对象尚未上传完成')
      const probe = forceBroken
        ? { decodable: false, reason: 'forced-failure' }
        : await decodeProbe(await this.blobStore.get(sha), mime)
      const resourceId = id('rid')
      const versionId = id('ver')
      const resource = {
        id: resourceId,
        ownerId,
        currentVersionId: versionId,
        caption,
        alt,
        source,
        grants: grants.map((g) => ({ ...g })),
        createdAt: Date.now(),
      }
      const version = {
        id: versionId,
        resourceId,
        sha256: sha,
        mime,
        decodable: probe.decodable,
        decodeReason: probe.reason ?? null,
        replaceReason: 'initial',
        createdAt: Date.now(),
        createdBy: ownerId,
      }
      this.state.resources[resourceId] = resource
      this.state.versions[versionId] = version
      await this._persist()
      return { resource, version }
    })
  }

  // 修改图注/来源/替代文本：逻辑行就地更新（旧正文实例不受影响——实例引用解析只依赖
  // resourceId/versionId 与快照；快照保存的是解析后的 refs，不再回读可变字段）。
  // 注意：快照引用包含 captionOverride/altOverride 快照值（见 freezeSnapshot）。
  async updateResourceMeta(resourceId, patch) {
    return this.mutex.run(async () => {
      const resource = this.state.resources[resourceId]
      if (!resource) throw new Error('资源不存在')
      for (const key of ['caption', 'alt', 'source']) {
        if (key in patch) resource[key] = patch[key]
      }
      await this._persist()
      return resource
    })
  }

  // 换图：新增不可变版本，旧版保留；未指定 version 的正文从现在起解析到新版，
  // 旧版引用（正文写了 ver_xxx 或历史快照 refs）永远解析到旧图。
  async replaceImage(resourceId, { sha256: sha, mime, reason = 'replace', forceBroken = false }, actorId) {
    return this.mutex.run(async () => {
      const resource = this.state.resources[resourceId]
      if (!resource) throw new Error('资源不存在')
      if (!this.state.blobs[sha]) throw new Error('对象尚未上传完成')
      const probe = forceBroken
        ? { decodable: false, reason: 'forced-failure' }
        : await decodeProbe(await this.blobStore.get(sha), mime)
      const versionId = id('ver')
      const version = {
        id: versionId,
        resourceId,
        sha256: sha,
        mime,
        decodable: probe.decodable,
        decodeReason: probe.reason ?? null,
        replaceReason: reason,
        createdAt: Date.now(),
        createdBy: actorId ?? resource.ownerId,
      }
      this.state.versions[versionId] = version
      resource.currentVersionId = versionId
      await this._persist()
      return { resource, version }
    })
  }

  async listVersions(resourceId) {
    return Object.values(this.state.versions)
      .filter((v) => v.resourceId === resourceId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async listResources(ownerId = null) {
    return Object.values(this.state.resources)
      .filter((r) => !ownerId || r.ownerId === ownerId)
      .map((r) => ({ resource: r, version: this.state.versions[r.currentVersionId] }))
  }

  // ---------- 授权 ----------

  async grant(resourceId, principal, level = 'read') {
    return this.mutex.run(async () => {
      const resource = this.state.resources[resourceId]
      if (!resource) throw new Error('资源不存在')
      const existing = resource.grants.find((g) => g.principal === principal)
      if (existing) existing.level = level
      else resource.grants.push({ principal, level })
      await this._persist()
      return resource
    })
  }

  async revokeGrant(resourceId, principal) {
    return this.mutex.run(async () => {
      const resource = this.state.resources[resourceId]
      if (!resource) throw new Error('资源不存在')
      resource.grants = resource.grants.filter((g) => g.principal !== principal)
      await this._persist()
      return resource
    })
  }

  hasAccess(resource, principal) {
    if (!resource || resource.tombstone) return false
    if (resource.ownerId === principal) return true
    return resource.grants.some((g) => g.principal === principal && g.level !== 'none')
  }

  // ---------- 文稿 / 引用计数 ----------

  async getManuscript(docId) {
    return this.state.manuscripts[docId] ?? { docId, body: '', versionNo: 0 }
  }

  // 保存草稿：乐观版本号防并发覆盖；同步重建实时引用计数表；
  // 同时落一个 kind=save 的保留快照（历史稿仍需的资源因此不可被 GC）。
  async saveDraft(docId, body, expectedVersionNo, { freeze = true } = {}) {
    return this.mutex.run(async () => {
      const current = this.state.manuscripts[docId] ?? { docId, body: '', versionNo: 0 }
      if (expectedVersionNo != null && expectedVersionNo !== current.versionNo) {
        throw new ConflictError(`版本冲突：期望 ${expectedVersionNo}，实际 ${current.versionNo}`)
      }
      const next = { docId, body, versionNo: current.versionNo + 1, updatedAt: Date.now() }
      this.state.manuscripts[docId] = next
      this._syncCitationRows(docId, body)
      let snapshotId = null
      if (freeze) snapshotId = this._freezeSnapshotLocked(docId, body, 'save')
      await this._persist()
      return { ...next, snapshotId }
    })
  }

  _syncCitationRows(docId, body) {
    for (const cid of Object.keys(this.state.citations)) {
      if (this.state.citations[cid].docId === docId) delete this.state.citations[cid]
    }
    for (const ref of parseCitations(body)) {
      this.state.citations[ref.instanceId] = {
        instanceId: ref.instanceId,
        resourceId: ref.resourceId,
        versionId: ref.versionId,
        altOverride: ref.alt,
        captionOverride: ref.captionOverride,
        docId,
        createdAt: Date.now(),
      }
    }
  }

  // 冻结快照：引用解析结果连同图注覆盖值一并固化；旧版永不被“替图”改变。
  _freezeSnapshotLocked(docId, body, kind) {
    // 冻结：把“此刻”的版本指针与图注/来源一并固化，换图或改图注都不影响旧快照。
    const refs = parseCitations(body).map((ref) => {
      const resource = this.state.resources[ref.resourceId]
      return {
        instanceId: ref.instanceId,
        resourceId: ref.resourceId,
        versionId: ref.versionId ?? resource?.currentVersionId ?? null,
        altOverride: ref.alt,
        captionOverride: ref.captionOverride,
        frozenCaption: ref.captionOverride || resource?.caption || '',
        frozenAlt: ref.alt || resource?.alt || '',
        frozenSource: resource?.source || '',
      }
    })
    const snapshotId = id('snap')
    this.state.snapshots[snapshotId] = {
      id: snapshotId,
      docId,
      kind,
      body,
      refs,
      createdAt: Date.now(),
      artifactId: null,
    }
    return snapshotId
  }

  listSnapshots(docId) {
    return Object.values(this.state.snapshots)
      .filter((s) => s.docId === docId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  // 删除某个保留版本（只有显式删除快照才会解除对其资源的 GC 保护）。
  async deleteSnapshot(snapshotId) {
    return this.mutex.run(async () => {
      delete this.state.snapshots[snapshotId]
      await this._persist()
      return { ok: true }
    })
  }

  // ---------- 发布 / 导出 ----------

  async publish(docId, body, principal) {
    return this.mutex.run(async () => {
      const current = this.state.manuscripts[docId] ?? { docId, body: '', versionNo: 0 }
      const next = { docId, body, versionNo: current.versionNo + 1, updatedAt: Date.now() }
      // 1) 先冻结快照（GC 与此互斥，不可能在导出进行时误删对象）。
      const snapshotId = this._freezeSnapshotLocked(docId, body, 'publish')
      const snapshot = this.state.snapshots[snapshotId]
      this.state.manuscripts[docId] = next
      this._syncCitationRows(docId, body)
      // 2) 门禁通过才交付正式文件并标记 artifactId；失败则快照保留（可诊断），但无发布产物。
      try {
        const result = await exportArtifact(this.state, this.blobStore, snapshot, principal)
        snapshot.artifactId = result.artifactId
        snapshot.manifest = result.manifest
        snapshot.publishedBy = principal
        await this._persist()
        return { ok: true, snapshot, artifact: result }
      } catch (error) {
        snapshot.publishError = error.problems ?? [{ message: error.message }]
        await this._persist()
        throw error
      }
    })
  }

  async exportSnapshot(snapshotId, principal) {
    const snapshot = this.state.snapshots[snapshotId]
    if (!snapshot) throw new Error('快照不存在')
    return exportArtifact(this.state, this.blobStore, snapshot, principal)
  }

  // 导出前（或任意时刻）的完整预检，返回问题清单，不抛异常。
  async preflightExport(docId, body, principal) {
    return evaluateRefs(this.state, body, principal)
  }

  // ---------- 可达性 / GC ----------

  reachable(docId) {
    const body = (this.state.manuscripts[docId] ?? { body: '' }).body
    return computeReachable(this.state, body)
  }

  verify(docId) {
    const body = (this.state.manuscripts[docId] ?? { body: '' }).body
    return verifyConsistency(this.state, docId, body)
  }

  async gc(docId) {
    const body = (this.state.manuscripts[docId] ?? { body: '' }).body
    return this.mutex.run(() => runGC(this.state, this.blobStore, body).then(async (result) => {
      await this._persist()
      return result
    }))
  }

  // ---------- 预览解析（四态） ----------

  async resolveForPreview(ref, principal) {
    const resource = this.state.resources[ref.resourceId]
    const baseKey = `res:${ref.resourceId}`
    if (!resource) {
      return { key: baseKey, status: 'missing', resourceId: ref.resourceId, problem: '资源不存在' }
    }
    const versionId = ref.versionId ?? resource.currentVersionId
    const version = this.state.versions[versionId]
    if (!version) {
      return { key: baseKey, status: 'missing', resourceId: ref.resourceId, versionId, problem: '版本不存在' }
    }
    if (!this.hasAccess(resource, principal)) {
      return {
        key: baseKey,
        status: 'revoked',
        resourceId: resource.id,
        versionId,
        caption: resource.caption,
        alt: resource.alt,
        problem: '当前身份无权访问（授权已撤回）',
      }
    }
    if (version.decodable === false) {
      return {
        key: baseKey,
        status: 'undecodable',
        resourceId: resource.id,
        versionId,
        caption: resource.caption,
        alt: resource.alt,
        source: resource.source,
        problem: version.decodeReason ? `解码失败：${version.decodeReason}` : '图片解码失败',
      }
    }
    const bytes = await this.blobStore.get(version.sha256)
    return {
      key: baseKey, // 身份 = 逻辑资源；同资源多次引用共享编号
      status: bytes ? 'ok' : 'missing',
      resourceId: resource.id,
      versionId,
      caption: resource.caption,
      alt: resource.alt,
      source: resource.source,
      dataUrl: bytes ? `data:${version.mime};base64,${toBase64(bytes)}` : null,
      problem: bytes ? null : '对象存储中缺少原件',
    }
  }

  async reset() {
    return this.mutex.run(async () => {
      await this.relStore.reset()
      this.state = await this.relStore.load()
    })
  }
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// 内部工具导出，便于测试与 seed。
export { concatBytes, bytesEqual }
