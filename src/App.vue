<script setup>
import { computed, onMounted, ref } from 'vue'
import { buildPreview } from './figures/preview.js'
import { createBackend } from './figures/backend-singleton.js'
import { newInstanceId } from './figures/citations.js'
import ResourceLibrary from './components/ResourceLibrary.vue'
import VersionPanel from './components/VersionPanel.vue'

const DOC_ID = 'doc1'

const backend = ref(null)
const uploader = ref(null)
const ready = ref(false)
const currentUser = ref('u1')
const online = ref(true)

const source = ref('')
const versionNo = ref(0)
const previewHtml = ref('')
const problems = ref([])
const toasts = ref([])
const leftTab = ref('library')
const previewKey = ref(0)

const resourceItems = ref([])

const initialDoc = (rid) => `# 图片脚注资源库演示

在左侧**资源库**选择资源并“插入引用”，或直接编辑下面的标记：

${rid ? `![示例替代文本](figure://${rid} "现场示意图" #${newInstanceId()})

同一张图在文中可以多次引用（编号共享）：再次引用 ![](${`figure://${rid}`} #${newInstanceId()})。
` : `![缺失演示](figure://rid_not_found "这张图不存在" #${newInstanceId()})
`}
> 预览会显著标示缺失/撤权/解码失败；正式发布会被门禁整体拒绝。
`

function toast(message) {
  const item = { id: Math.random(), ...message }
  toasts.value.push(item)
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== item.id)
  }, 4200)
}

async function refreshResources() {
  if (!backend.value) return
  resourceItems.value = await backend.value.listResources()
  await renderPreview()
}

async function renderPreview() {
  if (!backend.value) return
  const result = await buildPreview(source.value, (ref) => backend.value.resolveForPreview(ref, currentUser.value))
  previewHtml.value = result.html
  problems.value = result.problems
  previewKey.value += 1
}

async function init() {
  ready.value = false
  const created = await createBackend({ seed: true, online: online.value })
  backend.value = created.backend
  uploader.value = created.uploader
  const man = await backend.value.getManuscript(DOC_ID)
  if (!man.body || man.versionNo === 0) {
    // 找一个 u1 的资源写示例正文
    const list = await backend.value.listResources('u1')
    source.value = initialDoc(list[0]?.resource.id)
    versionNo.value = 0
  } else {
    source.value = man.body
    versionNo.value = man.versionNo
  }
  await refreshResources()
  ready.value = true
}

onMounted(() => init())

function setUser(user) {
  currentUser.value = user
  renderPreview()
}

function toggleOnline() {
  online.value = !online.value
  backend.value.setOnline(online.value)
  toast({ type: online.value ? 'ok' : 'warn', text: online.value ? '已切换为在线' : '已切换为离线：上传分片将本地暂存' })
}

function insertCitation({ resourceId, versionId }) {
  const item = resourceItems.value.find((x) => x.resource.id === resourceId)
  const r = item?.resource
  const alt = r?.alt || ''
  const caption = r?.caption || ''
  const marker = `![${alt.replace(/]/g, '')}](figure://${resourceId}${versionId ? `/${versionId}` : ''}${caption ? ` "${caption.replace(/"/g, '\\"')}"` : ''} #${newInstanceId()})`
  source.value = source.value.endsWith('\n') ? `${source.value}${marker}\n` : `${source.value}\n\n${marker}\n`
  renderPreview()
  toast({ type: 'ok', text: '已插入引用实例（独立 instanceId，编号按排版顺序自动生成）' })
}

function onSaved(result) {
  versionNo.value = result.versionNo
  refreshResources()
}

async function resetAll() {
  localStorage.removeItem('catalpa.figures.relational.v1')
  // IndexedDB 清空
  if (typeof indexedDB !== 'undefined') {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('catalpa-figures')
      req.onsuccess = resolve
      req.onerror = resolve
      req.onblocked = resolve
    })
  }
  location.reload()
}

const problemSummary = computed(() => {
  const counts = problems.value.reduce((acc, p) => {
    acc[p.type] = (acc[p.type] ?? 0) + 1
    return acc
  }, {})
  return Object.entries(counts).map(([k, v]) => ({
    type: k,
    count: v,
    label: { missing: '缺失', revoked: '无权', undecodable: '解码失败' }[k] || k,
  }))
})

const lineCount = computed(() => source.value.split(/\r?\n/).length)
const charCount = computed(() => source.value.length)
</script>

<template>
  <div class="page" v-if="ready">
    <header class="hero">
      <div>
        <p class="eyebrow">图片脚注资源库 · 分片上传 / 版本与快照 / 可达性 GC</p>
        <h1>Catalpa 文稿 · 图片脚注工作台</h1>
        <p class="subtitle">内容寻址共享原件，授权与图注逻辑隔离；脚注身份与引用实例分离，编号按本次排版顺序生成。</p>
      </div>
      <div class="stats">
        <span>{{ lineCount }} 行</span>
        <span>{{ charCount }} 字符</span>
        <span :class="['net', online ? 'is-on' : 'is-off']">{{ online ? '在线' : '离线' }}</span>
      </div>
    </header>

    <div class="toast-stack">
      <transition-group name="toast">
        <div v-for="t in toasts" :key="t.id" :class="['toast', `toast-${t.type}`]">{{ t.text }}</div>
      </transition-group>
    </div>

    <main class="workspace three-col">
      <aside class="panel side-panel">
        <div class="tabs">
          <button type="button" :class="{ active: leftTab === 'library' }" @click="leftTab = 'library'">资源库 / 上传</button>
          <button type="button" :class="{ active: leftTab === 'version' }" @click="leftTab = 'version'">版本 / 发布 / GC</button>
        </div>
        <ResourceLibrary
          v-show="leftTab === 'library'"
          :backend="backend"
          :uploader="uploader"
          :resources="resourceItems"
          :current-user="currentUser"
          :online="online"
          :doc-id="DOC_ID"
          @change="refreshResources"
          @insert="insertCitation"
          @toast="toast"
          @set-user="setUser"
          @toggle-online="toggleOnline"
          @reset-all="resetAll"
        />
        <VersionPanel
          v-show="leftTab === 'version'"
          :backend="backend"
          :doc-id="DOC_ID"
          :current-user="currentUser"
          :body="source"
          :version-no="versionNo"
          @toast="toast"
          @saved="onSaved"
        />
      </aside>

      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区（文稿 v{{ versionNo }}）</h2>
          <div class="actions">
            <button class="ghost-btn" type="button" @click="renderPreview">刷新预览</button>
          </div>
        </div>
        <textarea
          v-model="source"
          class="editor"
          spellcheck="false"
          @input="renderPreview"
        />
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>预览区（以 {{ currentUser }} 身份）</h2>
        </div>
        <div v-if="problemSummary.length" class="problem-banner">
          ⚠️ 本次排版存在问题资源：
          <span v-for="p in problemSummary" :key="p.type" class="banner-chip" :data-type="p.type">
            {{ p.label }} × {{ p.count }}
          </span>
          —— 正式发布会被整体拒绝
        </div>
        <article class="preview markdown-body" :key="previewKey" v-html="previewHtml"></article>
      </section>
    </main>
  </div>
  <div v-else class="loading">正在加载本地资源库…</div>
</template>
