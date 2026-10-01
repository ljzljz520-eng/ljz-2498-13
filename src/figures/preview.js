// 预览富化：把渲染 HTML 中的 figure 标记替换为图片/占位，并生成脚注列表。
// 编号在每次渲染时按本次排版顺序重新分配（不持久化）。

import { renderCatalpa } from '../utils/catalpa.js'
import { parseCitations } from './citations.js'
import { escapeHtml } from './util.js'

const MARKER_SOURCE =
  '!\\[([^\\]]*)\\]\\(figure:\\/\\/[A-Za-z0-9_/-]+(?:\\s+"(?:[^"\\\\]|\\\\.)*")?(?:\\s+#[A-Za-z0-9_-]+)?\\s*\\)'
const MARKER_RE = new RegExp(MARKER_SOURCE, 'g')
const STANDALONE_RE = new RegExp('^\\s*' + MARKER_SOURCE + '\\s*$')

// resolver(ref) 可为 async，返回：
// { key, status:'ok'|'missing'|'revoked'|'undecodable',
//   resourceId, versionId, caption, alt, source, dataUrl?, problem? }
export async function buildPreview(body, resolver) {
  const refs = parseCitations(body)
  const resolvedList = await Promise.all(refs.map((ref) => Promise.resolve(resolver ? resolver(ref) : null)))

  // 本次排版顺序编号：按解析身份首次出现分配；缺失标记按“资源+实例”独立占位。
  const keyToNumber = new Map()
  const numbered = []
  let next = 1
  resolvedList.forEach((resolved, i) => {
    const key = resolved?.key ?? `missing:${refs[i].resourceId}#${refs[i].instanceId}`
    let number = keyToNumber.get(key)
    if (number == null) {
      number = next
      keyToNumber.set(key, number)
      next += 1
    }
    numbered.push({ ref: refs[i], number })
  })

  const occurrenceCounter = new Map()
  const occurrenceOf = new Map()
  numbered.forEach((item, i) => {
    const key = resolvedList[i]?.key ?? `missing:${item.ref.resourceId}#${item.ref.instanceId}`
    const k = (occurrenceCounter.get(key) ?? 0) + 1
    occurrenceCounter.set(key, k)
    occurrenceOf.set(i, k)
  })

  const problems = []
  const blockMarkers = new Set(
    body.split(/\r?\n/).map((line) => line.trim()).filter((line) => STANDALONE_RE.test(line))
  )
  let cursor = 0
  MARKER_RE.lastIndex = 0
  let html = renderCatalpa(body).replace(MARKER_RE, (marker) => {
    const idx = cursor
    cursor += 1
    return blockMarkers.has(marker.trim())
      ? renderFigure(numbered[idx], resolvedList[idx], occurrenceOf.get(idx), problems)
      : renderInlineFigure(numbered[idx], resolvedList[idx], problems)
  })

  const footnotesHtml = renderFootnotes(numbered, resolvedList, occurrenceCounter)
  if (footnotesHtml) html += `\n<aside class="figure-footnotes">${footnotesHtml}</aside>`

  return {
    html,
    footnotes: numbered.map((item, i) => ({ ...item, resolved: resolvedList[i] })),
    problems,
  }
}

function pushProblem(problems, type, fields) {
  problems.push({ type, ...fields })
}

function renderInlineFigure(item, resolved, problems) {
  const { ref, number } = item
  if (!resolved || resolved.status === 'missing') {
    const message = resolved?.problem || `资源 ${ref.resourceId} 缺失`
    pushProblem(problems, 'missing', { number, instanceId: ref.instanceId, resourceId: ref.resourceId, message })
    return `<span class="fig-inline fig-inline-missing">⚠️ 缺失图片：${escapeHtml(message)}</span><sup class="fig-inline-num">[图${number}]</sup>`
  }
  if (resolved.status === 'revoked') {
    pushProblem(problems, 'revoked', { number, instanceId: ref.instanceId, resourceId: resolved.resourceId, message: resolved.problem || '授权已撤回' })
    return `<span class="fig-inline fig-inline-revoked">⛔ 图片无权访问</span><sup class="fig-inline-num">[图${number}]</sup>`
  }
  if (resolved.status === 'undecodable') {
    pushProblem(problems, 'undecodable', { number, instanceId: ref.instanceId, resourceId: resolved.resourceId, message: resolved.problem || '解码失败' })
    return `<span class="fig-inline fig-inline-broken">🧩 图片解码失败</span><sup class="fig-inline-num">[图${number}]</sup>`
  }
  const alt = ref.alt || resolved.alt || ''
  return `<img class="fig-inline-img" src="${resolved.dataUrl}" alt="${escapeHtml(alt)}" /><sup class="fig-inline-num"><a href="#fn-${number}">[图${number}]</a></sup>`
}

function renderFigure(item, resolved, occurrence, problems) {
  const { ref, number } = item
  const anchor = `fnref-${number}-${occurrence}`
  const alt = ref.alt || resolved?.alt || ''
  const caption = ref.captionOverride || resolved?.caption || ''

  if (!resolved || resolved.status === 'missing') {
    const message = resolved?.problem || `资源 ${ref.resourceId} 缺失或不存在`
    problems.push({ type: 'missing', number, instanceId: ref.instanceId, resourceId: ref.resourceId, message })
    return (
      `<figure class="fig fig-missing" data-fig-number="${number}" data-instance="${escapeHtml(ref.instanceId)}">` +
      `<div class="fig-box">⚠️ 缺失图片资源：${escapeHtml(message)}</div>` +
      `<figcaption>图 ${number}${caption ? `：${escapeHtml(caption)}` : ''} ` +
      `<sup class="fig-badge" id="${anchor}">[缺失]</sup></figcaption></figure>`
    )
  }

  if (resolved.status === 'revoked') {
    const message = resolved.problem || '当前身份无权访问该资源（授权已撤回）'
    problems.push({ type: 'revoked', number, instanceId: ref.instanceId, resourceId: resolved.resourceId, message })
    return (
      `<figure class="fig fig-revoked" data-fig-number="${number}" data-instance="${escapeHtml(ref.instanceId)}">` +
      `<div class="fig-box">⛔ 授权已撤回，无法显示该图片</div>` +
      `<figcaption>图 ${number}${caption ? `：${escapeHtml(caption)}` : ''} ` +
      `<sup class="fig-badge" id="${anchor}">[无权]</sup></figcaption></figure>`
    )
  }

  if (resolved.status === 'undecodable') {
    const message = resolved.problem || '图片解码失败（文件损坏或格式不支持）'
    problems.push({ type: 'undecodable', number, instanceId: ref.instanceId, resourceId: resolved.resourceId, message })
    return (
      `<figure class="fig fig-broken" data-fig-number="${number}" data-instance="${escapeHtml(ref.instanceId)}">` +
      `<div class="fig-box">🧩 图片解码失败：${escapeHtml(message)}</div>` +
      `<figcaption>图 ${number}${caption ? `：${escapeHtml(caption)}` : ''} ` +
      `<sup class="fig-badge" id="${anchor}">[损坏]</sup></figcaption></figure>`
    )
  }

  return (
    `<figure class="fig fig-ok" data-fig-number="${number}" data-instance="${escapeHtml(ref.instanceId)}">` +
    (resolved.dataUrl ? `<img src="${resolved.dataUrl}" alt="${escapeHtml(alt)}" />` : '<div class="fig-box">（无图像数据）</div>') +
    `<figcaption>图 ${number}：${escapeHtml(caption || alt || '未命名图片')}` +
    (resolved.source ? ` <span class="fig-source">来源：${escapeHtml(resolved.source)}</span>` : '') +
    ` <a class="fig-goto" href="#fn-${number}"><sup id="${anchor}">[${number}]</sup></a></figcaption></figure>`
  )
}

function renderFootnotes(numbered, resolvedList, occurrenceCounter) {
  const byKey = new Map()
  numbered.forEach((item, i) => {
    const key = resolvedList[i]?.key ?? `missing:${item.ref.resourceId}#${item.ref.instanceId}`
    if (!byKey.has(key)) {
      byKey.set(key, { number: item.number, resolved: resolvedList[i], ref: item.ref })
    }
  })
  if (!byKey.size) return ''
  const items = [...byKey.values()].map(({ number, resolved, ref }) => {
    const caption = ref.captionOverride || resolved?.caption || ''
    const alt = ref.alt || resolved?.alt || ''
    const source = resolved?.source || ''
    const status = !resolved ? 'missing' : resolved.status
    const note = { missing: '（缺失资源）', revoked: '（授权已撤回）', undecodable: '（图片解码失败）', ok: '' }[status]
    const key = resolved?.key ?? `missing:${ref.resourceId}#${ref.instanceId}`
    const count = occurrenceCounter.get(key) ?? 1
    return (
      `<li id="fn-${number}" class="fn-item fn-${status}">` +
      `<span class="fn-no">${number}</span> ` +
      `<span class="fn-caption">${escapeHtml(caption || alt || '未命名图片')} ${note}</span>` +
      (source ? ` <span class="fn-source">来源：${escapeHtml(source)}</span>` : '') +
      ` <a class="fn-back" href="#fnref-${number}-1">↩ 返回正文${count > 1 ? `（文中引用 ${count} 次）` : ''}</a>` +
      `</li>`
    )
  })
  return `<h3 class="fn-title">图片脚注（${items.length}）</h3><ol class="fn-list">${items.join('')}</ol>`
}
