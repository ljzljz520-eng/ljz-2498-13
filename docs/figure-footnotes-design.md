# 图片脚注资源库 —— 设计说明（v1）

## 1. 需求拆解与核心不变量

| # | 需求 | 落地不变量 |
|---|------|-----------|
| 1 | 编辑器选择资源、填来源与替代文本 | 脚注内容（逻辑资源）是一等实体，含 `caption / alt / source` |
| 2 | 分片上传、离线续传 | 上传会话幂等：`uploadId + chunkIndex` 可重放；断点可探测 |
| 3 | 内容相同可共享存储；授权不同/图注不同不得去重合并 | **字节层**按 `sha256` 内容寻址共享；**逻辑层**资源不去重（owner/授权集合/图注任一不同即为独立资源） |
| 4 | 脚注内容身份 与 文中引用实例 分开 | 资源/版本（`Resource/Version`）与引用实例（`Citation`）为两张表，一对多 |
| 5 | 自动编号依据本次排版顺序 | 编号不持久化：每次渲染按"资源首次出现的文档顺序"重新编号 |
| 6 | 同脚注多次引用 | 同一资源多个 Citation 共享编号，各自拥有反向链接锚点 |
| 7 | 删除正文引用不删除历史版本仍需资源 | 垃圾回收根集 = 当前正文引用 ∪ 所有保留快照引用；快照未删则对象可达 |
| 8 | 比较实时引用计数 vs 快照可达性 | `refCount` 实时维护；`computeReachable` 从文稿+全部保留快照重算；`verifyConsistency` 比对 |
| 9 | 并发上传/发布/清理安全边界 | 所有写操作经单一互斥串行化；发布先冻结快照后导出；GC 与发布互斥；乐观版本号防丢更新 |
| 10 | 离线续传、替图不改旧版、同脚注多次引用、解码失败、导出时撤权 | 见验收矩阵（§10） |
| 11 | 预览标示缺失资源；不交付内容不完整正式文件 | 预览允许缺失并显著标记；正式导出走门禁，任一缺失/撤权/解码失败即整体失败 |

## 2. 数据模型（关系库）

```
BlobObject { sha256(PK), size, bytes(对象存储), createdAt }
     ▲ 1:N（多资源版本可指向同一 sha，物理只存一份原件）
Version  { id(PK), resourceId, sha256, mime, width?, height?, decodable,
           replaceReason, createdAt, createdBy }
Resource { id(PK), ownerId, currentVersionId, caption, alt, source,
           grants:[{principal, level}], createdAt, tombstone? }
     ▲ 1:N（脚注内容身份 : 文中引用实例 = 1:N）
Citation { instanceId(PK), resourceId, versionId|null,
           altOverride?, docId, createdAt }   // 正文标记内嵌 instanceId
Manuscript { docId(PK), body, versionNo, updatedAt }
Snapshot   { id(PK), docId, kind:'save'|'publish', body,
             refs:[{instanceId,resourceId,versionId}], createdAt, artifactId? }
UploadSession { uploadId(PK), ownerId, sha256, size, mime, chunkSize,
                received:[chunkIndex], status:'open'|'committed'|'aborted' }
```

关键规则：

- **版本不可变（immutable）**：换图或改图注都产生新 `Version + Resource` 状态行（current 指针前移），旧版字节与元数据永不被覆盖。正文中的旧 `versionId` 始终解析到旧图。
- **授权挂在逻辑资源上**：共享的 BlobObject 不直接对外可读；访问必须经由某条授权资源，且检查该资源的 `grants`。内容哈希不能作为绕过授权的取址凭证。
- **图注不同即不同资源**：caption/alt/source 是逻辑身份的一部分，禁止跨资源"摘要去重"合并；仅 `(sha256)` 在物理层共享。

## 3. 正文引用语法（Catalpa 扩展）

```
![替代文本](figure://rid_abc123/ver_9 "图注（覆盖资源默认）" #cit_instance_uuid)
```
- `rid` 必须；`ver` 可省（= 当前版本）；alt 可省（取资源默认）；`#cit` 是正文内**引用实例身份**。
- 独占一行 = 块级图注；出现在句子中 = 行内引用。
- 预览/导出解析器同时输出：结构化引用列表（用于快照、计数、可达性）与富 HTML。

## 4. API（分片上传 / 引用 / 发布 / GC）

| 分组 | 接口 | 要点 |
|------|------|------|
| 上传 | `initUpload(ownerId, sha256,size,mime,chunkSize)` | sha 已存在直接返回 `instant:true`；否则建会话，已收分片用于续传 |
|  | `putChunk(uploadId,index,bytes)` | 幂等：重复 index 返回既有状态；`offline` 时分片进入本地待发队列 |
|  | `completeUpload(uploadId)` | 校验全部到齐 + 哈希；成功才提交 BlobObject |
| 引用 | `createResource({ownerId,sha,mime,caption,alt,source,grants})` | 图注/授权不做内容去重；生成 Version 并置 current |
|  | `replaceImage(resourceId,{sha,mime,...},reason)` | 新增版本，旧版保留 |
|  | `revokeGrant(resourceId,principal)` | 立即生效，影响所有后续解析与导出门禁（旧快照引用仍在但导出被拒） |
| 文稿 | `saveDraft(docId,body,expectedVersionNo)` | 乐观锁；写实时引用计数（保存快照 kind=save，始终保留） |
| 发布 | `publish(docId,body)` | 事务内：校验 → 冻结快照 → 门禁导出 → 成功才标记 publish |
| 导出 | `exportArtifact(snapshotId, principal)` | 门禁：缺失/撤权/不可解码 → 抛 `ExportGateError(原因列表)`，不产 artifact |
| GC | `computeReachable()` | 从正文 + **所有保留快照**遍历引用求可达资源/版本/sha |
|  | `verifyConsistency()` | 返回实时计数与快照可达的逐项 diff |
|  | `runGC()` | 仅删除"不可达且无 open 上传会话引用"的逻辑资源与物理 blob；不触碰可达对象 |

并发：后端对象单例上的异步互斥（mutex）串行化全部写事务；`save/publish` 用互斥+版本号；`runGC` 与 `publish` 同锁，不可能在发布冻结快照后误删；`completeUpload` 与 `runGC` 同锁，提交中的 sha 计入根集。

## 5. 自动编号与多次引用

渲染时按文档顺序遍历引用，按"解析出的资源身份（缺失标记按 rid/实例）首次出现"分配编号 1,2,3…；同一资源后续实例复用编号并产生 `#fn-N-k` 回链。编号在每次预览/导出时重算——**本次排版顺序**。

## 6. 缺失资源与正式文件门禁

预览解析结果四态：`ok | missing | revoked | undecodable`，均以醒目占位（行内胶囊 / 块级虚线框 + 缺失清单横幅）标示；脚注列表照常列出并注明问题。

正式导出门禁在快照冻结后逐条复核：

1. rid/version 存在；2. principal 持有授权（即使导出瞬间撤权也拦截）；3. blob 可解码。
任一失败 → 整体失败、不写 artifactId、返回完整原因；`publish` 不产生已发布标记。

## 7. 前端/存储实现映射（本仓库）

纯前端项目，用可替换适配层完整模拟服务端，契约与真实后端一一对应：

- 对象存储：IndexedDB（`figure-blobs`）存 `ArrayBuffer` 原件，失败回退内存；**内容寻址去重只发生在此层**。
- 关系库：localStorage JSON 表（§2 全部实体），失败回退内存。
- `src/figures/api.js`：上述全部 API + 互斥 + 权限检查 + 上传会话状态机。
- `src/figures/uploader.js`：分片、哈希、断线重试/续传（模拟网络开关）。
- `src/figures/{citations,preview,export-gate,gc}.js`：纯逻辑，Node 直接测试。
- 验收：`node --test` 覆盖 §10 全部场景。
