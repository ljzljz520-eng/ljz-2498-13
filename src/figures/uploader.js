// 上传编排器：客户端计算哈希 -> init -> 分片幂等提交 -> complete。
// 离线：分片本地暂存 + 任务持久化；恢复后探测缺失分片继续上传（断点续传）。

import { sha256, toBytes } from './util.js'

export class Uploader {
  constructor(backend, { chunkSize = 256 * 1024, maxRetry = 3 } = {}) {
    this.backend = backend
    this.chunkSize = chunkSize
    this.maxRetry = maxRetry
    this.jobs = new Map()
  }

  async upload({ file, bytes, ownerId, mime, onProgress, signal }) {
    const data = bytes ? toBytes(bytes) : new Uint8Array(await file.arrayBuffer())
    const size = data.length
    const computedMime = mime || file?.type || 'application/octet-stream'
    const digest = await sha256(data)

    const init = await this.backend.initUpload({
      ownerId,
      sha256: digest,
      size,
      mime: computedMime,
      chunkSize: this.chunkSize,
    })
    if (init.instant) {
      onProgress?.({ phase: 'instant', loaded: size, total: size, percent: 100 })
      return { sha256: digest, mime: computedMime, size, deduped: true }
    }

    const { uploadId, totalChunks } = init
    const job = { uploadId, digest, size, mime: computedMime, data, cancelled: false, loadedChunks: new Set(init.received) }
    this.jobs.set(uploadId, job)
    onProgress?.({ phase: 'uploading', loaded: job.loadedChunks.size * this.chunkSize, total: size, percent: 0, resumed: !!init.resumed })

    for (let i = 0; i < totalChunks; i += 1) {
      if (signal?.aborted || job.cancelled) {
        job.cancelled = true
        const err = new Error('上传已取消（分片保留，可稍后续传）')
        err.code = 'ABORTED'
        throw err
      }
      if (job.loadedChunks.has(i)) continue
      const start = i * this.chunkSize
      const chunk = data.subarray(start, Math.min(start + this.chunkSize, size))
      // eslint-disable-next-line no-await-in-loop
      await this._putWithRetry(uploadId, i, chunk, job)
      job.loadedChunks.add(i)
      onProgress?.({
        phase: 'uploading',
        loaded: Math.min(job.loadedChunks.size * this.chunkSize, size),
        total: size,
        percent: Math.round((job.loadedChunks.size / totalChunks) * 100),
      })
    }

    try {
      const result = await this.backend.completeUpload(uploadId)
      onProgress?.({ phase: 'done', loaded: size, total: size, percent: 100, deduped: result.deduped })
      return { sha256: digest, mime: computedMime, size, deduped: result.deduped }
    } catch (error) {
      if (error.code === 'OFFLINE_PENDING') {
        onProgress?.({ phase: 'offline-pending', uploadId, totalChunks, loaded: job.loadedChunks.size })
      }
      throw error
    }
  }

  async _putWithRetry(uploadId, index, chunk, job) {
    // 离线不重试：分片已本地暂存，待 resume 重放；在线瞬时失败按指数退避重试。
    let lastError = null
    for (let attempt = 0; attempt <= this.maxRetry; attempt += 1) {
      try {
        const ack = await this.backend.putChunk(uploadId, index, chunk)
        if (ack.offline) job.loadedChunks.add(index)
        return
      } catch (error) {
        lastError = error
        // 会话级错误不重试
        if (error.message?.includes('会话')) throw error
        if (!this.backend.online) return // 中途断网：分片已落本地
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50))
      }
    }
    throw lastError
  }

  // 网络恢复后：用本地暂存分片重放缺失序号，再 complete（离线续传）。
  async resume(uploadId, { onProgress } = {}) {
    const session = await this.backend.probeSession(uploadId)
    if (!session) throw new Error('没有可恢复的上传会话')
    for (const index of session.received) {
      // eslint-disable-next-line no-await-in-loop
      const chunk = await this.backend.blobStore.getChunk(uploadId, index)
      if (chunk) {
        // eslint-disable-next-line no-await-in-loop
        await this.backend.putChunk(uploadId, index, chunk)
      }
    }
    onProgress?.({ phase: 'resuming', received: session.received.length, totalChunks: session.totalChunks })
    return this.backend.completeUpload(uploadId)
  }

  cancel(uploadId) {
    const job = this.jobs.get(uploadId)
    if (job) job.cancelled = true
  }
}
