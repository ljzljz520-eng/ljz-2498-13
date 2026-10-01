<script setup>
import { computed, ref } from 'vue'
import { ExportGateError } from '../figures/util.js'

const props = defineProps({
  backend: { type: Object, required: true },
  docId: { type: String, default: 'doc1' },
  currentUser: { type: String, default: 'u1' },
  body: { type: String, default: '' },
  versionNo: { type: Number, default: 0 },
})
const emit = defineEmits(['toast', 'saved'])

const lastManifest = ref(null)
const gateProblems = ref([])
const gcReport = ref(null)
const consistency = ref(null)
const busy = ref(false)

const snapshots = computed(() => props.backend.listSnapshots(props.docId))

const stats = computed(() => {
  const s = props.backend.state
  return {
    blobs: Object.keys(s.blobs).length,
    resources: Object.keys(s.resources).length,
    versions: Object.keys(s.versions).length,
    openUploads: Object.values(s.uploads).filter((u) => u.status === 'open').length,
  }
})

async function saveDraft() {
  busy.value = true
  try {
    const result = await props.backend.saveDraft(props.docId, props.body, props.versionNo)
    emit('saved', result)
    emit('toast', { type: 'ok', text: `草稿已保存 v${result.versionNo}，保留快照 ${result.snapshotId.slice(0, 10)}` })
    runVerify()
  } catch (error) {
    emit('toast', { type: 'error', text: error.message })
  } finally {
    busy.value = false
  }
}

async function publish() {
  busy.value = true
  gateProblems.value = []
  try {
    const result = await props.backend.publish(props.docId, props.body, props.currentUser)
    lastManifest.value = result.artifact.manifest
    emit('saved', { versionNo: result.snapshot ? props.versionNo + 1 : props.versionNo })
    emit('toast', { type: 'ok', text: `发布成功：${result.artifact.artifactId.slice(0, 14)}，交付 ${result.artifact.manifest.files.length} 个图片条目` })
    runVerify()
  } catch (error) {
    if (error instanceof ExportGateError) {
      gateProblems.value = error.problems
      emit('toast', { type: 'error', text: `发布被门禁拒绝（${error.problems.length} 个问题）：后端不交付不完整的正式文件` })
    } else {
      emit('toast', { type: 'error', text: error.message })
    }
  } finally {
    busy.value = false
  }
}

async function preflight() {
  const { problems } = await props.backend.preflightExport(props.docId, props.body, props.currentUser)
  gateProblems.value = problems
  if (!problems.length) emit('toast', { type: 'ok', text: '预检通过：当前正文可完整导出' })
  else emit('toast', { type: 'warn', text: `预检发现 ${problems.length} 个问题` })
}

async function reexport(snap) {
  gateProblems.value = []
  try {
    const result = await props.backend.exportSnapshot(snap.id, props.currentUser)
    lastManifest.value = result.manifest
    emit('toast', { type: 'ok', text: `快照 ${snap.id.slice(0, 8)} 导出成功` })
  } catch (error) {
    if (error instanceof ExportGateError) {
      gateProblems.value = error.problems
      emit('toast', { type: 'error', text: '导出被拒绝（授权/缺失/损坏），未产出正式文件' })
    }
  }
}

async function removeSnapshot(snap) {
  await props.backend.deleteSnapshot(snap.id)
  emit('toast', { type: 'warn', text: `保留版本 ${snap.id.slice(0, 8)} 已删除（解除其资源的 GC 保护）` })
  runVerify()
}

function runVerify() {
  consistency.value = props.backend.verify(props.docId)
}

async function runGc() {
  gcReport.value = await props.backend.gc(props.docId)
  const { deleted } = gcReport.value
  emit('toast', {
    type: deleted.blobs.length || deleted.resources.length ? 'warn' : 'ok',
    text: `GC：删除资源 ${deleted.resources.length}、版本 ${deleted.versions.length}、原件 ${deleted.blobs.length}`,
  })
  runVerify()
}

function typeLabel(t) {
  return {
    'missing-resource': '资源缺失',
    'missing-version': '版本缺失',
    'missing-blob': '原件缺失',
    revoked: '授权撤回',
    undecodable: '解码失败',
    'live-count-mismatch': '实时计数不一致',
    'stale-citation-row': '陈旧引用行',
    'missing-citation-row': '缺引用行',
    'dangling-citation': '悬挂引用',
    'dangling-citation-version': '悬挂版本引用',
    'reachable-resource-missing': '可达资源缺失',
    'reachable-version-missing': '可达版本缺失',
    'reachable-blob-missing': '可达原件缺失',
  }[t] || t
}

function time(ts) {
  return new Date(ts).toLocaleTimeString()
}
</script>

<template>
  <div class="version-panel">
    <section class="lib-section">
      <h3>保存 / 发布 / 导出</h3>
      <div class="row wrap">
        <button class="mini" type="button" :disabled="busy" @click="saveDraft">保存草稿（v{{ versionNo }} → v{{ versionNo + 1 }}）</button>
        <button class="primary" type="button" :disabled="busy" @click="publish">正式发布（门禁导出）</button>
        <button class="mini" type="button" @click="preflight">导出预检</button>
      </div>
      <ul v-if="gateProblems.length" class="problem-list">
        <li v-for="(p, i) in gateProblems" :key="i" class="problem">
          <span class="badge" :data-type="p.type">{{ typeLabel(p.type) }}</span>
          {{ p.message }}
          <span class="muted" v-if="p.instanceId">[{{ p.instanceId.slice(0, 12) }}]</span>
        </li>
      </ul>
      <details v-if="lastManifest" class="manifest">
        <summary>最近交付清单（{{ lastManifest.files.length }} 个文件）</summary>
        <pre>{{ JSON.stringify(lastManifest.files.map(f => ({ sha256: f.sha256.slice(0,12), caption: f.caption, alt: f.alt, source: f.source, versionId: f.versionId.slice(0,8) })), null, 2) }}</pre>
      </details>
    </section>

    <section class="lib-section">
      <h3>保留版本（{{ snapshots.length }}）—— GC 保护根集</h3>
      <ul class="snap-list">
        <li v-for="snap in snapshots" :key="snap.id" class="snap-item">
          <div>
            <span class="tag" :data-kind="snap.kind">{{ snap.kind === 'publish' ? '发布' : '保存' }}</span>
            <span class="muted">{{ snap.id.slice(0, 10) }} · {{ time(snap.createdAt) }} · 引用 {{ snap.refs.length }}</span>
          </div>
          <div class="res-meta" v-if="snap.artifactId">正式文件：✅ {{ snap.artifactId.slice(0, 16) }}</div>
          <div class="res-meta warn" v-else-if="snap.kind === 'publish'">未交付（门禁未通过），快照保留用于诊断</div>
          <div class="row">
            <button class="mini" type="button" @click="reexport(snap)">以 {{ currentUser }} 重新导出</button>
            <button class="mini danger" type="button" @click="removeSnapshot(snap)">删除该保留版本</button>
          </div>
        </li>
      </ul>
    </section>

    <section class="lib-section">
      <h3>引用计数对账 与 垃圾回收</h3>
      <div class="row wrap">
        <button class="mini" type="button" @click="runVerify">实时计数 vs 快照可达性</button>
        <button class="mini danger" type="button" @click="runGc">运行 GC</button>
      </div>
      <p class="hint">
        物理原件 {{ stats.blobs }} · 资源 {{ stats.resources }} · 版本 {{ stats.versions }} · 未完成上传 {{ stats.openUploads }}
      </p>
      <div v-if="consistency" class="consistency">
        <strong :class="consistency.ok ? 'ok-text' : 'err-text'">
          {{ consistency.ok ? '✓ 实时引用计数与可达对象一致' : `✗ 发现 ${consistency.problems.length} 项不一致` }}
        </strong>
        <ul v-if="!consistency.ok" class="problem-list">
          <li v-for="(p, i) in consistency.problems" :key="i" class="problem">
            <span class="badge" :data-type="p.type">{{ typeLabel(p.type) }}</span>
            {{ p.resourceId || p.instanceId || (p.sha256?.slice(0, 10)) }}
          </li>
        </ul>
        <p class="hint">
          可达：资源 {{ consistency.reachable.resources.size }} · 版本 {{ consistency.reachable.versions.size }} · sha {{ consistency.reachable.shas.size }}
        </p>
      </div>
      <div v-if="gcReport" class="hint">
        上次 GC 删除：资源 {{ gcReport.deleted.resources.length }}，版本 {{ gcReport.deleted.versions.length }}，原件 {{ gcReport.deleted.blobs.length }}
      </div>
    </section>
  </div>
</template>
