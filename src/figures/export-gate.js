// 正式导出门禁：
// 逐条复核引用 —— 资源存在、版本存在、导出者授权有效、原件可解码。
// 任一失败：整体失败，返回完整问题清单，绝不产出内容不完整的正式文件。
// 快照导出以冻结的 refs 为准（版本指针与图注都不回读当前可变状态）。

import { parseCitations } from './citations.js'
import { ExportGateError } from './util.js'

function hasAccess(resource, principal) {
  if (!resource || resource.tombstone) return false
  if (resource.ownerId === principal) return true
  return resource.grants.some((g) => g.principal === principal && g.level !== 'none')
}

function evaluateEntries(refs, state, principal) {
  const problems = []
  const entries = []
  for (const ref of refs) {
    const resource = state.resources[ref.resourceId]
    if (!resource) {
      problems.push({ type: 'missing-resource', ...ref, message: `资源 ${ref.resourceId} 不存在` })
      continue
    }
    const versionId = ref.versionId ?? resource.currentVersionId
    const version = state.versions[versionId]
    if (!version) {
      problems.push({ type: 'missing-version', ...ref, versionId, message: '引用的版本不存在' })
      continue
    }
    if (!hasAccess(resource, principal)) {
      problems.push({ type: 'revoked', ...ref, versionId, message: `导出者 ${principal} 对资源 ${ref.resourceId} 的授权已撤回` })
      continue
    }
    const blobMeta = state.blobs[version.sha256]
    if (!blobMeta) {
      problems.push({ type: 'missing-blob', ...ref, versionId, sha256: version.sha256, message: '对象存储中缺少原件' })
      continue
    }
    if (version.decodable === false) {
      problems.push({ type: 'undecodable', ...ref, versionId, message: '图片解码失败，禁止导出' })
      continue
    }
    entries.push({
      instanceId: ref.instanceId,
      resourceId: resource.id,
      versionId,
      sha256: version.sha256,
      caption: ref.frozenCaption ?? (ref.captionOverride || resource.caption),
      alt: ref.frozenAlt ?? (ref.altOverride ?? ref.alt ?? resource.alt),
      source: ref.frozenSource ?? resource.source,
    })
  }
  return { problems, entries }
}

// 实时正文预检（未冻结）。
export function evaluateRefs(state, body, principal) {
  const parsed = parseCitations(body).map((ref) => {
    const resource = state.resources[ref.resourceId]
    return {
      ...ref,
      versionId: ref.versionId ?? resource?.currentVersionId ?? null,
      frozenCaption: ref.captionOverride || resource?.caption || '',
      frozenAlt: ref.alt || resource?.alt || '',
      frozenSource: resource?.source || '',
    }
  })
  return evaluateEntries(parsed, state, principal)
}

export async function exportArtifact(state, blobStore, snapshot, principal) {
  const { problems, entries } = evaluateEntries(snapshot.refs, state, principal)
  if (problems.length) throw new ExportGateError(problems)
  const manifest = {
    snapshotId: snapshot.id,
    docId: snapshot.docId,
    principal,
    createdAt: Date.now(),
    files: [],
  }
  for (const entry of entries) {
    // 安全边界：数据只能沿“授权资源 -> 版本 -> sha”路径取出；
    // 持有相同内容哈希的其他资源不能借道取件。
    // eslint-disable-next-line no-await-in-loop
    const bytes = await blobStore.get(entry.sha256)
    if (!bytes) {
      throw new ExportGateError([{ type: 'missing-blob', ...entry, message: '对象存储中缺少原件' }])
    }
    manifest.files.push({
      instanceId: entry.instanceId,
      resourceId: entry.resourceId,
      versionId: entry.versionId,
      sha256: entry.sha256,
      size: bytes.length,
      caption: entry.caption,
      alt: entry.alt,
      source: entry.source,
    })
  }
  return { artifactId: `art_${snapshot.id}_${Date.now().toString(36)}`, manifest }
}
