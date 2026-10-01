import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeBackend, uploadBytes, makeResource, marker, b64ToBytes,
  RED_PNG_B64, BLUE_PNG_B64, digest,
} from './helpers.js'
import { buildPreview } from '../src/figures/preview.js'
import { ExportGateError } from '../src/figures/util.js'
import { parseCitations, assignNumbers, countLiveReferences, makeMarker } from '../src/figures/citations.js'
import { computeReachable } from '../src/figures/gc.js'

const DOC = 'doc1'

// 1) 分片上传：幂等 + 秒传 + 哈希校验
test('分片上传：重复分片幂等，同内容秒传/共享对象', async () => {
  const b = await makeBackend()
  const bytes = b64ToBytes(RED_PNG_B64)
  const sha = await digest(bytes)
  const init = await b.initUpload({ ownerId: 'u1', sha256: sha, size: bytes.length, mime: 'image/png', chunkSize: 20 })

  const part0 = bytes.subarray(0, 20)
  const ack1 = await b.putChunk(init.uploadId, 0, part0)
  const ack2 = await b.putChunk(init.uploadId, 0, part0) // 重放
  assert.equal(ack1.stored, true)
  assert.deepEqual(ack2.received, [0]) // 仍然只有一片

  for (let i = 1; i < init.totalChunks; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await b.putChunk(init.uploadId, i, bytes.subarray(i * 20, Math.min((i + 1) * 20, bytes.length)))
  }
  const done = await b.completeUpload(init.uploadId)
  assert.equal(done.sha256, sha)

  // 同样内容再次 initUpload -> instant；物理原件只一份
  const again = await b.initUpload({ ownerId: 'u2', sha256: sha, size: bytes.length, mime: 'image/png', chunkSize: 20 })
  assert.equal(again.instant, true)
  assert.equal((await b.blobStore.keys()).length, 1)

  // 坏哈希必须拒绝
  const bad = await b.initUpload({ ownerId: 'u1', sha256: 'deadbeef', size: bytes.length, mime: 'image/png', chunkSize: 100 })
  await b.putChunk(bad.uploadId, 0, bytes)
  await assert.rejects(() => b.completeUpload(bad.uploadId), /哈希/)
})

// 2) 离线续传：离线上传本地暂存，联网探测补齐并完成
test('离线续传：断网分片暂存，恢复后探测缺失分片并完成', async () => {
  const b = await makeBackend({ online: false })
  const bytes = b64ToBytes(BLUE_PNG_B64)
  const sha = await digest(bytes)
  const init = await b.initUpload({ ownerId: 'u1', sha256: sha, size: bytes.length, mime: 'image/png', chunkSize: 24 })
  assert.equal(init.instant, false)

  await b.putChunk(init.uploadId, 0, bytes.subarray(0, 24))
  await b.putChunk(init.uploadId, 1, bytes.subarray(24, 48))
  await assert.rejects(() => b.completeUpload(init.uploadId), (e) => e.code === 'OFFLINE_PENDING')
  // 会话状态在离线时未登记 received，但本地分片可探测
  assert.deepEqual((await b.probeSession(init.uploadId)).received.sort(), [0, 1])

  // 模拟“页面重开”：全新后端实例共用同一对象存储（本地暂存不丢）
  const b2 = await makeBackend({ online: false })
  b2.blobStore = b.blobStore
  b2.state = b.state
  // 联网：重放已暂存分片、补传剩余分片
  b2.online = true
  const session = await b2.probeSession(init.uploadId)
  for (const idx of session.received) {
    // eslint-disable-next-line no-await-in-loop
    await b2.putChunk(init.uploadId, idx, await b2.blobStore.getChunk(init.uploadId, idx))
  }
  for (let i = 2; i < init.totalChunks; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await b2.putChunk(init.uploadId, i, bytes.subarray(i * 24, Math.min((i + 1) * 24, bytes.length)))
  }
  const done = await b2.completeUpload(init.uploadId)
  assert.equal(done.sha256, sha)
})

// 3) 内容相同共享存储；不同授权/不同图注不得合并
test('内容共享存储但逻辑资源不合并：授权与图注隔离', async () => {
  const b = await makeBackend()
  const bytes = b64ToBytes(RED_PNG_B64)
  const up1 = await uploadBytes(b, 'u1', bytes, 'image/png')
  const r1 = await b.createResource({
    ownerId: 'u1', sha256: up1.sha256, mime: 'image/png',
    caption: '同图 A 图注', alt: 'A', source: '来源A', grants: [{ principal: 'u3', level: 'read' }],
  })
  const r2 = await b.createResource({
    ownerId: 'u2', sha256: up1.sha256, mime: 'image/png',
    caption: '同图 B 图注', alt: 'B', source: '来源B', grants: [],
  })
  // 物理层：一个 sha；逻辑层：两个资源、两个版本
  assert.equal((await b.blobStore.keys()).length, 1)
  assert.notEqual(r1.resource.id, r2.resource.id)
  assert.equal(r1.version.sha256, r2.version.sha256)

  // u3 有 r1 授权、无 r2 授权：不能借相同内容跨资源访问
  const p1 = await b.resolveForPreview(parseCitations(marker(r1.resource.id))[0], 'u3')
  const p2 = await b.resolveForPreview(parseCitations(marker(r2.resource.id))[0], 'u3')
  assert.equal(p1.status, 'ok')
  assert.equal(p2.status, 'revoked')
  assert.equal(p1.caption, '同图 A 图注')
  assert.equal(p2.caption, '同图 B 图注')

  // 不同图注是两条独立脚注身份（编号各自独立）
  const body = `${marker(r1.resource.id)}\n\n${marker(r2.resource.id)}`
  const refs = parseCitations(body)
  const numbered = assignNumbers(refs, (ref) => ({ key: `res:${ref.resourceId}` }))
  assert.deepEqual(numbered.map((n) => n.number), [1, 2])
})

// 4) 脚注身份 vs 引用实例；多次引用共享编号；编号依本次排版顺序
test('同脚注多次引用共享编号；编号按本次排版顺序重算', async () => {
  const b = await makeBackend()
  const { resource: ra } = await makeResource(b, { caption: '甲' })
  const { resource: rb } = await makeResource(b, { bytes: b64ToBytes(BLUE_PNG_B64), caption: '乙' })

  const ma = marker(ra.id)
  const mb = marker(rb.id)
  const ma2 = marker(ra.id)
  const ma3 = marker(ra.id)
  const body1 = `${ma}\n\n正文再次引用 ${ma2}，然后 ${mb}，最后 ${ma3}。`
  const refs1 = parseCitations(body1)
  assert.equal(new Set(refs1.map((r) => r.instanceId)).size, 4) // 四个引用实例（同一资源三个实例）
  const n1 = assignNumbers(refs1, (ref) => ({ key: `res:${ref.resourceId}` }))
  assert.deepEqual(n1.map((x) => x.number), [1, 1, 2, 1])

  // 调整排版顺序（乙先出现），编号整体重排
  const body2 = `${mb}\n\n${ma}`
  const n2 = assignNumbers(parseCitations(body2), (ref) => ({ key: `res:${ref.resourceId}` }))
  assert.deepEqual(n2.map((x) => x.number), [1, 2])
})

// 5) 实时引用计数 与 快照可达对象 对账
test('实时计数与快照可达性一致；verify 能发现偏差', async () => {
  const b = await makeBackend()
  const { resource: ra } = await makeResource(b)
  const { resource: rb } = await makeResource(b, { bytes: b64ToBytes(BLUE_PNG_B64) })
  const body = `${marker(ra.id)}\n\n${marker(rb.id)} ${marker(ra.id)}`
  await b.saveDraft(DOC, body, 0)

  const report = b.verify(DOC)
  assert.equal(report.ok, true, JSON.stringify(report.problems))
  assert.equal(report.live.byResource.get(ra.id), 2)
  const reach = b.reachable(DOC)
  assert.ok(reach.resources.has(ra.id))
  assert.ok(reach.resources.has(rb.id))

  // 手工制造一条陈旧引用行，verify 必须发现
  b.state.citations['cit_ghost'] = { instanceId: 'cit_ghost', resourceId: ra.id, versionId: null, docId: DOC }
  const bad = b.verify(DOC)
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.some((p) => p.type === 'live-count-mismatch'))
})

// 6) 删除正文引用不删除历史稿仍需资源；GC 检查保留版本
test('移除正文引用后，被历史快照保留的资源不被 GC；删除快照后才可回收', async () => {
  const b = await makeBackend()
  const { resource: ra, version: va } = await makeResource(b)
  const { resource: rb, version: vb } = await makeResource(b, { bytes: b64ToBytes(BLUE_PNG_B64) })
  const v1 = await b.saveDraft(DOC, `${marker(ra.id)}\n\n${marker(rb.id)}`, 0)
  assert.ok(v1.snapshotId)

  // 正文移除 rb 的引用并保存：rb 实时计数归零，但 v1 快照仍引用
  await b.saveDraft(DOC, marker(ra.id), 1)
  assert.equal(countLiveReferences(b.state.manuscripts[DOC].body).byResource.get(rb.id), undefined)
  let reach = computeReachable(b.state, b.state.manuscripts[DOC].body)
  assert.ok(reach.resources.has(rb.id))
  assert.ok(reach.shas.has(vb.sha256))

  const gc1 = await b.gc(DOC)
  assert.deepEqual(gc1.deleted.resources, [])
  assert.deepEqual(gc1.deleted.blobs, [])

  // 删除唯一保留该引用的快照后，rb 及其原件成为垃圾（ra 仍被正文引用）
  await b.deleteSnapshot(v1.snapshotId)
  const gc2 = await b.gc(DOC)
  assert.deepEqual(gc2.deleted.resources, [rb.id])
  assert.ok(gc2.deleted.blobs.includes(vb.sha256))
  assert.ok(!gc2.deleted.blobs.includes(va.sha256))
  reach = computeReachable(b.state, b.state.manuscripts[DOC].body)
  assert.ok(reach.resources.has(ra.id))
  assert.ok(!reach.resources.has(rb.id))
})

// 7) 替图不改旧版
test('替换图片：新版本生效，旧快照与显式旧版引用仍指向旧图', async () => {
  const b = await makeBackend()
  const { resource, version: v1 } = await makeResource(b, { bytes: b64ToBytes(RED_PNG_B64) })
  await b.saveDraft(DOC, marker(resource.id), 0)
  const snapshotsBefore = b.listSnapshots(DOC)

  const blue = b64ToBytes(BLUE_PNG_B64)
  const upBlue = await uploadBytes(b, 'u1', blue, 'image/png')
  const { version: v2 } = await b.replaceImage(resource.id, { sha256: upBlue.sha256, mime: 'image/png', reason: '换蓝底' }, 'u1')
  assert.notEqual(v1.id, v2.id)
  assert.equal(b.state.resources[resource.id].currentVersionId, v2.id)

  // 未写版本号的新引用 -> 新版（蓝）；旧快照 refs 冻结在 v1（红）
  const nowRef = parseCitations(marker(resource.id))[0]
  const resolvedNow = await b.resolveForPreview(nowRef, 'u1')
  assert.equal(resolvedNow.versionId, v2.id)

  const oldSnap = snapshotsBefore.find((s) => s.kind === 'save')
  assert.equal(oldSnap.refs[0].versionId, v1.id)
  const artifact = await b.exportSnapshot(oldSnap.id, 'u1')
  assert.equal(artifact.manifest.files[0].versionId, v1.id)
  assert.equal(artifact.manifest.files[0].sha256, v1.sha256)

  // 正文显式引用旧版 -> 仍解析到旧图
  const oldInline = parseCitations(marker(resource.id, { versionId: v1.id }))[0]
  const resolvedOld = await b.resolveForPreview(oldInline, 'u1')
  assert.equal(resolvedOld.versionId, v1.id)

  // 两个版本都被保留：GC 不删任何原件
  const report = await b.gc(DOC)
  assert.deepEqual(report.deleted.blobs, [])
})

// 8) 图片解码失败：预览标示 + 正式导出拒绝
test('不可解码图片：预览显示损坏占位，门禁拒绝导出', async () => {
  const b = await makeBackend()
  const { resource, version } = await makeResource(b, {
    bytes: new TextEncoder().encode('this is not a png at all'),
    mime: 'image/png',
    forceBroken: true,
    caption: '坏图',
  })
  assert.equal(version.decodable, false)

  const body = marker(resource.id)
  const preview = await buildPreview(body, (ref) => b.resolveForPreview(ref, 'u1'))
  assert.ok(preview.problems.some((p) => p.type === 'undecodable'))
  assert.match(preview.html, /fig-broken/)

  await assert.rejects(
    () => b.publish(DOC, body, 'u1'),
    (err) => err instanceof ExportGateError && err.problems.some((p) => p.type === 'undecodable')
  )
  const snaps = b.listSnapshots(DOC).filter((s) => s.kind === 'publish')
  assert.equal(snaps.length, 1)
  assert.equal(snaps[0].artifactId, null) // 未交付正式文件
})

// 9) 导出时授权撤回：即使发布后、即使内容相同有共享资源，也拒绝交付
test('导出瞬间撤权：门禁失败且不产正式文件；共享 sha 的其他授权资源不受影响', async () => {
  const b = await makeBackend()
  const bytes = b64ToBytes(RED_PNG_B64)
  const up = await uploadBytes(b, 'u1', bytes, 'image/png')
  const rShared = await b.createResource({
    ownerId: 'u1', sha256: up.sha256, mime: 'image/png',
    caption: '共享给访客', grants: [{ principal: 'guest', level: 'read' }],
  })
  const rPrivate = await b.createResource({
    ownerId: 'u2', sha256: up.sha256, mime: 'image/png',
    caption: '私人资源', grants: [],
  })

  const body = marker(rShared.resource.id)
  const pub = await b.publish(DOC, body, 'guest')
  assert.ok(pub.artifact.artifactId)

  // 撤回授权后重新导出旧快照 -> 拒绝
  await b.revokeGrant(rShared.resource.id, 'guest')
  await assert.rejects(
    () => b.exportSnapshot(pub.snapshot.id, 'guest'),
    (err) => err instanceof ExportGateError && err.problems[0].type === 'revoked'
  )
  // 同 sha 的另一资源（u2 私有）依旧正常
  const resolved = await b.resolveForPreview(parseCitations(marker(rPrivate.resource.id))[0], 'u2')
  assert.equal(resolved.status, 'ok')
  // 撤权没有物理删除原件
  assert.ok(await b.blobStore.has(up.sha256))
})

// 10) 预览清楚标示缺失资源
test('缺失资源：预览显著占位 + 缺失清单，门禁拒绝，缺失不影响其他脚注编号', async () => {
  const b = await makeBackend()
  const { resource } = await makeResource(b, { caption: '存在的图' })
  const body = `![幽灵](figure://rid_does_not_exist #cit_ghost)\n\n${marker(resource.id)}`
  const preview = await buildPreview(body, (ref) => b.resolveForPreview(ref, 'u1'))
  assert.ok(preview.html.includes('fig-missing'))
  assert.ok(preview.problems.some((p) => p.type === 'missing'))
  // 存在的资源仍编号为 2（缺失实例按本次顺序占位为 1）
  assert.equal(preview.footnotes.find((f) => f.resolved?.status === 'ok').number, 2)
  const { problems } = await b.preflightExport(DOC, body, 'u1')
  assert.ok(problems.some((p) => p.type === 'missing-resource'))
})

// 11) 并发发布/保存：乐观锁与互斥；GC 与发布竞态不删活对象
test('并发保存乐观锁；并发完成上传与 GC 不产生误删', async () => {
  const b = await makeBackend()
  const { resource } = await makeResource(b)
  const body = marker(resource.id)
  await b.saveDraft(DOC, body, 0)

  // 两个并发保存都基于版本 1：只有一个成功
  const results = await Promise.allSettled([
    b.saveDraft(DOC, `${body}\n新增 A`, 1),
    b.saveDraft(DOC, `${body}\n新增 B`, 1),
  ])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason.message, /版本冲突/)

  // 并发：一个 open 上传（sha 尚未成为版本）+ GC + 完成上传
  const blue = b64ToBytes(BLUE_PNG_B64)
  const shaBlue = await digest(blue)
  const init = await b.initUpload({ ownerId: 'u1', sha256: shaBlue, size: blue.length, mime: 'image/png', chunkSize: 30 })
  await b.putChunk(init.uploadId, 0, blue.subarray(0, 30))
  const gcPromise = b.gc(DOC)
  const restParts = []
  for (let i = 1; i < init.totalChunks; i += 1) {
    restParts.push(b.putChunk(init.uploadId, i, blue.subarray(i * 30, Math.min((i + 1) * 30, blue.length))))
  }
  await Promise.all([gcPromise, ...restParts, b.completeUpload(init.uploadId)])
  assert.ok(await b.blobStore.has(shaBlue)) // open 会话的 sha 受保护
})

// 12) 发布成功交付完整正式文件（含图注/来源/哈希清单）
test('完整发布：正式文件包含全部图片条目', async () => {
  const b = await makeBackend()
  const { resource: ra, version: va } = await makeResource(b, { caption: '封面', source: '档案馆' })
  const { resource: rb, version: vb } = await makeResource(b, { bytes: b64ToBytes(BLUE_PNG_B64), caption: '插图' })
  const body = `${marker(ra.id)}\n\n文字段落引用 ${marker(rb.id)}。`
  const result = await b.publish(DOC, body, 'u1')
  assert.ok(result.artifact.artifactId)
  assert.equal(result.artifact.manifest.files.length, 2)
  assert.deepEqual(result.artifact.manifest.files.map((f) => f.sha256).sort(), [va.sha256, vb.sha256].sort())
  assert.equal(result.artifact.manifest.files[0].caption, '封面')
  assert.equal(result.artifact.manifest.files[0].source, '档案馆')
})
