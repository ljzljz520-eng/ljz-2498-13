// 引用标记：解析 / 序列化 / 计数 / 本次排版顺序编号
// 语法：
//   ![alt](figure://resourceId/versionId? "caption" #instanceId)
// versionId、alt、caption 均可省略；instanceId 是“文中引用实例”的稳定身份。

export const FIGURE_SCHEME = 'figure://'

const MARKER_RE =
  /!\[([^\]]*)\]\(figure:\/\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+#([A-Za-z0-9_-]+))?\s*\)/g

export function newInstanceId() {
  const rand = Math.random().toString(36).slice(2, 10)
  return `cit_${Date.now().toString(36)}${rand}`
}

export function makeMarker({ resourceId, versionId = null, alt = '', caption = '', instanceId = newInstanceId() }) {
  const altPart = alt
  const target = versionId ? `${resourceId}/${versionId}` : resourceId
  const captionPart = caption ? ` "${caption.replace(/"/g, '\\"')}"` : ''
  return `![${altPart}](${FIGURE_SCHEME}${target}${captionPart} #${instanceId})`
}

export function parseCitations(body) {
  const refs = []
  for (const match of body.matchAll(MARKER_RE)) {
    refs.push({
      alt: match[1] ?? '',
      resourceId: match[2],
      versionId: match[3] ?? null,
      captionOverride: match[4] ? match[4].replace(/\\"/g, '"') : '',
      instanceId: match[5] ?? `anon_${refs.length}_${match.index}`,
      index: match.index,
    })
  }
  return refs
}

// 从正文引用直接按实例计数（实时引用计数的输入）。
export function countLiveReferences(body) {
  const byResource = new Map()
  const byVersion = new Map()
  const instances = new Set()
  for (const ref of parseCitations(body)) {
    instances.add(ref.instanceId)
    byResource.set(ref.resourceId, (byResource.get(ref.resourceId) ?? 0) + 1)
    if (ref.versionId) byVersion.set(ref.versionId, (byVersion.get(ref.versionId) ?? 0) + 1)
  }
  return { byResource, byVersion, instances }
}

// 渲染编号：按文档顺序，同一资源首次出现分配编号；缺失标记（rid 解析失败）
// 使用占位键 `missing:<rid?>#<instanceId>`，同样有稳定顺序号。
// resolve(ref) -> { key, resourceId, resourceMissing?, ...meta } | null
export function assignNumbers(refs, resolve) {
  const keyToNumber = new Map()
  const numbered = []
  let next = 1
  for (const ref of refs) {
    const resolved = resolve(ref)
    const key = resolved?.key ?? `missing:${ref.resourceId ?? ''}#${ref.instanceId}`
    let number = keyToNumber.get(key)
    if (number == null) {
      number = next
      keyToNumber.set(key, number)
      next += 1
    }
    numbered.push({ ref, number, resolved })
  }
  return numbered
}
