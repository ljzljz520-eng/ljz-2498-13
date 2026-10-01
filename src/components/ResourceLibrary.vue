<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  backend: { type: Object, required: true },
  uploader: { type: Object, required: true },
  resources: { type: Array, default: () => [] },
  currentUser: { type: String, default: 'u1' },
  online: { type: Boolean, default: true },
  docId: { type: String, default: 'doc1' },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits([
  'change', 'insert', 'toast', 'set-user', 'toggle-online', 'reset-all',
])

const caption = ref('')
const altText = ref('')
const source = ref('')
const grantTo = ref('guest')
const uploadProgress = ref(null)
const pendingSha = ref(null)
const pendingMime = ref('')
const selected = ref(new Map()) // resourceId -> selected versionId for insert
const replaceFor = ref(null)

const versionListCache = ref({})
const expanded = ref(new Set())

function pickFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void doUpload(file)
  }
  input.click()
}

async function doUpload(file) {
  uploadProgress.value = { percent: 0, phase: 'start', name: file.name }
  try {
    const result = await props.uploader.upload({
      file,
      ownerId: props.currentUser,
      onProgress: (p) => {
        uploadProgress.value = { ...p, name: file.name }
      },
    })
    pendingSha.value = result.sha256
    pendingMime.value = result.mime
    if (!caption.value) caption.value = file.name
    if (!altText.value) altText.value = file.name
    emit('toast', { type: 'ok', text: result.deduped ? '上传完成（内容已存在，共享原件）' : '上传完成' })
  } catch (error) {
    if (error.code === 'OFFLINE_PENDING') {
      emit('toast', { type: 'warn', text: '离线：分片已暂存，联网后点击“续传完成”' })
    } else {
      emit('toast', { type: 'error', text: error.message })
    }
  } finally {
    setTimeout(() => {
      uploadProgress.value = null
    }, 1500)
  }
}

async function resumeAll() {
  const open = Object.values(props.backend.state.uploads).filter((u) => u.status === 'open')
  for (const session of open) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await props.uploader.resume(session.uploadId)
      emit('toast', { type: 'ok', text: `会话 ${session.uploadId.slice(0, 12)} 续传完成` })
    } catch (error) {
      emit('toast', { type: 'error', text: error.message })
    }
  }
  emit('change')
}

async function createResourceFromUpload() {
  if (!pendingSha.value) {
    emit('toast', { type: 'error', text: '请先上传图片' })
    return
  }
  const grants = grantTo.value.trim()
    ? [{ principal: grantTo.value.trim(), level: 'read' }]
    : []
  await props.backend.createResource({
    ownerId: props.currentUser,
    sha256: pendingSha.value,
    mime: pendingMime.value || 'image/png',
    caption: caption.value,
    alt: altText.value,
    source: source.value,
    grants,
  })
  pendingSha.value = null
  caption.value = ''
  altText.value = ''
  source.value = ''
  emit('toast', { type: 'ok', text: '资源已入库（图注/授权独立，不做内容去重）' })
  emit('change')
}

function selectVersion(rid, vid) {
  const value = vid === 'null' || vid === '' ? null : vid
  const next = new Map(selected.value)
  next.set(rid, value)
  selected.value = next
}

function insert(rid) {
  const vid = selected.value.get(rid) ?? null
  emit('insert', { resourceId: rid, versionId: vid })
}

async function toggleExpand(rid) {
  const next = new Set(expanded.value)
  if (next.has(rid)) next.delete(rid)
  else {
    next.add(rid)
    const versions = await props.backend.listVersions(rid)
    versionListCache.value = { ...versionListCache.value, [rid]: versions }
  }
  expanded.value = next
}

async function pickReplace(rid) {
  replaceFor.value = rid
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const result = await props.uploader.upload({
        file,
        ownerId: props.currentUser,
        onProgress: (p) => {
          uploadProgress.value = { ...p, name: file.name }
        },
      })
      await props.backend.replaceImage(rid, { sha256: result.sha256, mime: result.mime, reason: '编辑器替图' }, props.currentUser)
      emit('toast', { type: 'ok', text: '已生成新版本，旧版与历史快照不受影响' })
      emit('change')
    } catch (error) {
      emit('toast', { type: 'error', text: error.message })
    } finally {
      replaceFor.value = null
      uploadProgress.value = null
    }
  }
  input.click()
}

async function revoke(rid) {
  await props.backend.revokeGrant(rid, 'guest')
  emit('toast', { type: 'warn', text: '已撤回 guest 的访问授权（旧快照导出也会被门禁拦截）' })
  emit('change')
}

async function grantGuest(rid) {
  await props.backend.grant(rid, 'guest', 'read')
  emit('toast', { type: 'ok', text: '已授权 guest 只读' })
  emit('change')
}

const openUploads = computed(() =>
  Object.values(props.backend.state.uploads).filter((u) => u.status === 'open'))

function shortSha(sha) {
  return sha ? sha.slice(0, 8) : ''
}
</script>

<template>
  <div class="library">
    <section class="lib-section">
      <h3>当前身份 / 网络</h3>
      <div class="row">
        <label>身份
          <select :value="currentUser" @change="emit('set-user', $event.target.value)">
            <option value="u1">u1（作者）</option>
            <option value="u2">u2（另一作者）</option>
            <option value="guest">guest（被授权访客）</option>
          </select>
        </label>
        <button class="mini" type="button" :class="{ off: !online }" @click="emit('toggle-online')">
          {{ online ? '在线' : '离线' }}
        </button>
      </div>
    </section>

    <section class="lib-section">
      <h3>上传新原件（分片）</h3>
      <button class="primary" type="button" :disabled="busy" @click="pickFile">选择图片并分片上传</button>
      <div v-if="uploadProgress" class="progress">
        <div class="bar"><div class="bar-fill" :style="{ width: `${uploadProgress.percent ?? 0}%` }" /></div>
        <span>{{ uploadProgress.phase }} {{ uploadProgress.percent ?? '' }}{{ uploadProgress.phase === 'offline-pending' ? '（已暂存）' : '' }}</span>
      </div>
      <div class="form-grid">
        <label>图注 caption<input v-model="caption" placeholder="例如：现场示意图" /></label>
        <label>替代文本 alt<input v-model="altText" placeholder="供无障碍/缺失时使用" /></label>
        <label>来源 source<input v-model="source" placeholder="例如：某档案馆/URL" /></label>
        <label>授权给<input v-model="grantTo" placeholder="principal，如 guest" /></label>
      </div>
      <button class="primary" type="button" @click="createResourceFromUpload" :disabled="!pendingSha">
        {{ pendingSha ? `入库（sha ${shortSha(pendingSha)}…）` : '上传后入库为资源' }}
      </button>
      <button v-if="openUploads.length && online" class="mini" type="button" @click="resumeAll">续传未完成会话（{{ openUploads.length }}）</button>
    </section>

    <section class="lib-section">
      <h3>资源库（{{ resources.length }}）</h3>
      <p class="hint">同内容只共享物理原件；图注/授权不同即为不同脚注资源。</p>
      <ul class="res-list">
        <li v-for="item in resources" :key="item.resource.id" class="res-item">
          <div class="res-head">
            <strong>{{ item.resource.caption || '(无图注)' }}</strong>
            <span class="muted">{{ item.resource.id.slice(0, 10) }} · {{ item.resource.ownerId }}</span>
          </div>
          <div class="res-meta">
            alt：{{ item.resource.alt || '—' }} ｜ 来源：{{ item.resource.source || '—' }}
          </div>
          <div class="res-meta" :class="{ broken: item.version.decodable === false }">
            当前版本 {{ item.version.id.slice(0, 10) }} · sha {{ shortSha(item.version.sha256) }}
            <span v-if="item.version.decodable === false">· 🧩 解码失败</span>
          </div>
          <div class="res-meta">
            授权：{{ item.resource.ownerId }}(owner)
            <template v-for="g in item.resource.grants" :key="g.principal">
              , {{ g.principal }}:{{ g.level }}
            </template>
          </div>
          <div class="row wrap">
            <label class="mini-select">
              引用版本
              <select :value="selected.get(item.resource.id) ?? ''"
                      @change="selectVersion(item.resource.id, $event.target.value)">
                <option value="">当前版本（{{ item.version.id.slice(0, 8) }}）</option>
                <template v-if="expanded.has(item.resource.id)">
                  <option v-for="v in (versionListCache[item.resource.id] ?? [])"
                          :key="v.id" :value="v.id">{{ v.id.slice(0, 8) }} · {{ shortSha(v.sha256) }}</option>
                </template>
              </select>
            </label>
            <button class="mini" type="button" @click="insert(item.resource.id)">插入引用</button>
            <button class="mini" type="button" @click="toggleExpand(item.resource.id)">
              {{ expanded.has(item.resource.id) ? '收起版本' : '查看版本' }}
            </button>
            <button class="mini" type="button" :disabled="replaceFor === item.resource.id" @click="pickReplace(item.resource.id)">
              {{ replaceFor === item.resource.id ? '选择文件…' : '替图（保留旧版）' }}
            </button>
            <button class="mini danger" type="button" @click="revoke(item.resource.id)">撤回 guest 授权</button>
            <button class="mini" type="button" @click="grantGuest(item.resource.id)">授予 guest</button>
          </div>
        </li>
      </ul>
    </section>

    <section class="lib-section">
      <button class="mini danger" type="button" @click="emit('reset-all')">清空本地库（重置演示）</button>
    </section>
  </div>
</template>
