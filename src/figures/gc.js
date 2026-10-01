// 可达性分析与垃圾回收。
// 关键不变量：GC 根集 = 当前文稿正文引用 ∪ 所有“保留版本”（save/publish 快照）引用
// ∪ 未结束的分片上传会话。删除正文引用不会让仍被历史快照引用的对象变成垃圾。

import { parseCitations } from './citations.js'

export function collectSnapshotRefs(state) {
  const refs = []
  for (const snapshot of Object.values(state.snapshots)) {
    for (const ref of snapshot.refs) refs.push({ ...ref, snapshotId: snapshot.id, kind: snapshot.kind })
  }
  return refs
}

function resolveVersionId(state, ref) {
  const resource = state.resources[ref.resourceId]
  if (!resource) return null
  if (ref.versionId && state.versions[ref.versionId]) return ref.versionId
  return resource.currentVersionId
}

// 从文稿正文 + 全部保留快照计算可达对象。
export function computeReachable(state, currentBody) {
  const resources = new Set()
  const versions = new Set()
  const shas = new Set()

  const touch = (resourceId, versionId) => {
    const resource = state.resources[resourceId]
    if (!resource) return
    resources.add(resourceId)
    const vid = versionId && state.versions[versionId] ? versionId : resource.currentVersionId
    const version = state.versions[vid]
    if (!version) return
    versions.add(vid)
    shas.add(version.sha256)
  }

  for (const ref of parseCitations(currentBody)) {
    touch(ref.resourceId, ref.versionId)
  }
  for (const ref of collectSnapshotRefs(state)) {
    touch(ref.resourceId, ref.versionId)
  }
  for (const upload of Object.values(state.uploads)) {
    if (upload.status === 'open') shas.add(upload.sha256)
  }
  return { resources, versions, shas }
}

// 实时引用计数：以 Citations 表为准；与正文即时解析结果对比，
// 再与“快照可达性”对账。任何不一致都显式暴露（不静默合并/删除）。
export function verifyConsistency(state, docId, currentBody) {
  const problems = []

  const liveByResource = new Map()
  const liveInstances = new Set()
  for (const ref of parseCitations(currentBody)) {
    liveByResource.set(ref.resourceId, (liveByResource.get(ref.resourceId) ?? 0) + 1)
    liveInstances.add(ref.instanceId)
  }

  const rows = Object.values(state.citations).filter((row) => row.docId === docId)
  const rowsByResource = new Map()
  const rowInstances = new Set()
  for (const row of rows) {
    rowsByResource.set(row.resourceId, (rowsByResource.get(row.resourceId) ?? 0) + 1)
    rowInstances.add(row.instanceId)
  }

  for (const [rid, count] of liveByResource) {
    if ((rowsByResource.get(rid) ?? 0) !== count) {
      problems.push({ type: 'live-count-mismatch', resourceId: rid, live: count, stored: rowsByResource.get(rid) ?? 0 })
    }
  }
  for (const [rid, count] of rowsByResource) {
    if (!liveByResource.has(rid)) {
      problems.push({ type: 'stale-citation-row', resourceId: rid, stored: count })
    }
  }
  for (const instanceId of liveInstances) {
    if (!rowInstances.has(instanceId)) problems.push({ type: 'missing-citation-row', instanceId })
  }

  const reachable = computeReachable(state, currentBody)
  for (const rid of reachable.resources) {
    if (!state.resources[rid]) problems.push({ type: 'reachable-resource-missing', resourceId: rid })
  }
  for (const vid of reachable.versions) {
    if (!state.versions[vid]) problems.push({ type: 'reachable-version-missing', versionId: vid })
  }
  for (const sha of reachable.shas) {
    if (!state.blobs[sha]) problems.push({ type: 'reachable-blob-missing', sha256: sha })
  }
  for (const row of rows) {
    if (!state.resources[row.resourceId]) problems.push({ type: 'dangling-citation', instanceId: row.instanceId, resourceId: row.resourceId })
    if (row.versionId && !state.versions[row.versionId]) {
      problems.push({ type: 'dangling-citation-version', instanceId: row.instanceId, versionId: row.versionId })
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    live: { byResource: liveByResource, instances: liveInstances },
    stored: { byResource: rowsByResource, instances: rowInstances },
    reachable,
  }
}

// 执行 GC：仅移除不可达对象。调用方必须已持有写互斥（与发布/上传完成互斥）。
export async function runGC(state, blobStore, currentBody) {
  const reachable = computeReachable(state, currentBody)
  const deleted = { resources: [], versions: [], blobs: [] }

  for (const rid of Object.keys(state.resources)) {
    if (!reachable.resources.has(rid)) {
      deleted.resources.push(rid)
      delete state.resources[rid]
    }
  }
  for (const vid of Object.keys(state.versions)) {
    if (!reachable.versions.has(vid)) {
      deleted.versions.push(vid)
      delete state.versions[vid]
    }
  }
  for (const cid of Object.keys(state.citations)) {
    const row = state.citations[cid]
    if (!state.resources[row.resourceId]) {
      delete state.citations[cid]
    }
  }
  // 物理原件：只有当没有任何可达版本引用时才从对象存储删除。
  const neededShas = new Set()
  for (const vid of reachable.versions) {
    const version = state.versions[vid]
    if (version) neededShas.add(version.sha256)
  }
  for (const sha of Object.keys(state.blobs)) {
    if (!neededShas.has(sha)) {
      deleted.blobs.push(sha)
      delete state.blobs[sha]
      await blobStore.delete(sha)
    }
  }
  return { deleted, reachable }
}
