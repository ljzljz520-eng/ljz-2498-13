# 图片脚注资源库 — 系统设计

> 范围：文稿产品的图片脚注（图注）资源库。覆盖编辑器选图与元数据填写、分片上传 API、
> 关系库中的资源代次与正文关联、对象存储原件保留、去重边界、自动编号、
> 垃圾回收双账本与并发安全边界、导出权限闸门与验收标准。

## 1. 核心概念：四层身份模型

去重与生命周期的所有规则都建立在"身份分层"上，四层必须严格分开：

| 层 | 实体 | 身份（唯一键） | 可变性 | 去重规则 |
|---|---|---|---|---|
| 存储层 | `blob`（对象存储原件） | 内容摘要 `sha256` | 不可变 | **同内容共享存储**：相同字节全库仅存一份 |
| 资源层 | `asset` + `asset_generation`（资源代次） | `(asset_id, generation_no)` | 代次不可变；替图 = 新代次 | 不跨代次合并；**替图不改旧版** |
| 脚注层 | `footnote`（脚注内容身份） | `identity_hash = sha256(workspace ‖ generation_id ‖ 授权快照 ‖ 图注 ‖ 来源 ‖ 替代文本)` | 不可变；编辑 = 新建身份 | 仅当五元组全同才复用；**不同授权或不同图注绝不因摘要相同而合并** |
| 引用层 | `footnote_ref`（文中引用实例） | `(document_version_id, instance_key)` | 随版本快照不可变 | 同一脚注可被多次引用，实例各自独立 |

关键推论：

- **Blob 可以按摘要去重，脚注不可以。** 两张字节完全相同的图片，只要授权（license）
  或图注（caption）任一不同，就是两个不同的 `footnote` 身份，各自计数、各自审计。
  去重只发生在 `blob` 层（省存储），绝不发生在 `footnote` 层（保语义）。
- **脚注身份与引用实例分开。** 正文里保存的是引用实例节点
  `{type:"image_footnote_ref", instance_key, footnote_id}`，不内联脚注内容；
  改图注/换授权 = 生成新 `footnote` 并把实例重指过去，历史版本仍指旧身份。
- **编号不属于身份。** 自动编号在渲染/发布/导出时按**本次排版顺序**现算：
  按正文块序扫描引用实例，同一 `footnote_id` 首次出现分配下一个序号，
  后续实例复用该序号（"同脚注多次引用"只产生一个条目）。编号不写入正文、不持久化，
  重排后自然重号；已发布版本因正文不可变，重算结果恒定。

## 2. 数据模型（关系库 DDL）

```sql
-- 2.1 对象存储原件登记（内容寻址）
CREATE TABLE blob (
  digest            CHAR(64) PRIMARY KEY,          -- sha256(hex)
  byte_size         BIGINT      NOT NULL,
  mime              TEXT        NOT NULL,          -- 服务端嗅探的真实类型，不信客户端声明
  storage_key       TEXT        NOT NULL UNIQUE,   -- 对象存储 key，原件永不覆写
  status            TEXT        NOT NULL DEFAULT 'active',  -- active|pending_delete|deleted
  ref_count         INT         NOT NULL DEFAULT 0,         -- 实时引用计数（对账用，不作删除充分条件）
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  pending_delete_at TIMESTAMPTZ
);

-- 2.2 分片上传会话（离线续传的状态载体）
CREATE TABLE upload_session (
  id              UUID PRIMARY KEY,
  workspace_id    UUID NOT NULL,
  owner_id        UUID NOT NULL,
  declared_size   BIGINT NOT NULL,
  declared_sha256 CHAR(64) NOT NULL,
  chunk_size      INT NOT NULL,
  chunk_count     INT NOT NULL,
  received_chunks JSONB NOT NULL DEFAULT '[]',     -- 已收分片位图/清单（含每片 etag）
  status          TEXT NOT NULL DEFAULT 'initiated',
    -- initiated → uploading → completing → committed
    --                          └→ failed_decode（解码失败，隔离）
    -- 任意 → aborted | expired（会话过期由上传看门人清理分片）
  blob_digest     CHAR(64) REFERENCES blob(digest),
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL             -- 例：7 天；过期分会话由看门人回收
);

-- 2.3 资源与资源代次
CREATE TABLE asset (
  id                    UUID PRIMARY KEY,
  workspace_id          UUID NOT NULL,
  name                  TEXT NOT NULL,
  current_generation_id UUID,                      -- 指向最新代次；历史代次完整保留
  created_by            UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);

CREATE TABLE asset_generation (
  id            UUID PRIMARY KEY,
  asset_id      UUID NOT NULL REFERENCES asset(id),
  generation_no INT  NOT NULL,
  blob_digest   CHAR(64) NOT NULL REFERENCES blob(digest),
  width         INT  NOT NULL,
  height        INT  NOT NULL,
  format        TEXT NOT NULL,                     -- 解码确认后的真实格式
  ref_count     INT  NOT NULL DEFAULT 0,
  created_by    UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, generation_no)
);

-- 2.4 授权（参与脚注身份；可撤回、可过期）
CREATE TABLE license_grant (
  id           UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  licensor     TEXT NOT NULL,
  license_type TEXT NOT NULL,                      -- 如 CC-BY-4.0 / 内部授权 / 图库购买
  scope_text   TEXT,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ                         -- 撤回时间；导出闸门检查
);

-- 2.5 脚注内容身份（不可变；五元组定身份）
CREATE TABLE footnote (
  id            UUID PRIMARY KEY,
  workspace_id  UUID NOT NULL,
  identity_hash CHAR(64) NOT NULL,
  generation_id UUID NOT NULL REFERENCES asset_generation(id),  -- 钉住代次：替图不影响旧脚注
  license_id    UUID REFERENCES license_grant(id),
  license_text  TEXT NOT NULL,        -- 授权快照文本，防 license 行被改导致身份漂移
  caption       TEXT NOT NULL,        -- 图注
  source        TEXT NOT NULL,        -- 来源（编辑器填写）
  alt_text      TEXT NOT NULL,        -- 替代文本（编辑器填写）
  ref_count     INT  NOT NULL DEFAULT 0,
  created_by    UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, identity_hash)  -- 同五元组幂等复用；不同授权/图注 → 不同身份
);

-- 2.6 文稿与版本快照
CREATE TABLE document (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  title TEXT NOT NULL DEFAULT ''
);

CREATE TABLE document_version (
  id           UUID PRIMARY KEY,
  document_id  UUID NOT NULL REFERENCES document(id),
  version_no   INT  NOT NULL,
  body         JSONB NOT NULL,          -- 正文；图片处以引用实例节点内联
  state        TEXT NOT NULL,           -- draft|published|archived
  retain_until TIMESTAMPTZ,             -- 保留期；NULL = 永久保留（历史稿）
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);

-- 2.7 引用实例（正文关联的物化，供 GC 与对账直接查询，避免解析 JSON 正文）
CREATE TABLE footnote_ref (
  id                  UUID PRIMARY KEY,
  document_version_id UUID NOT NULL REFERENCES document_version(id),
  footnote_id         UUID NOT NULL REFERENCES footnote(id),
  instance_key        TEXT NOT NULL,    -- 正文内节点 id
  position            INT  NOT NULL,    -- 排版顺序（块序），编号计算的输入
  UNIQUE (document_version_id, instance_key)
);

CREATE INDEX idx_ref_footnote   ON footnote_ref (footnote_id);
CREATE INDEX idx_ref_version    ON footnote_ref (document_version_id);
CREATE INDEX idx_version_retain ON document_version (retain_until) WHERE state <> 'archived';
CREATE INDEX idx_gen_blob       ON asset_generation (blob_digest);
CREATE INDEX idx_footnote_gen   ON footnote (generation_id);
```

**版本保留与引用计数的维护规则（全部在保存/发布同一事务内完成）：**

- 保存草稿/发布时：插入 `document_version` + 解析正文物化 `footnote_ref` 行 +
  沿链 `footnote → generation → blob` 三级 `ref_count` 增减，**同一事务提交**。
  GC 永远看不到"版本已存在但引用未登记"的中间态。
- 版本被取代（草稿覆盖）或保留期届满被清除时：同事务删除其 `footnote_ref` 并递减计数。
- **删除正文引用 ≠ 删除资源**：只要任一 retained 版本（历史稿、已发布版）仍持有
  该脚注的 `footnote_ref`，资源三层都不可回收。

## 3. 对象存储布局

```
blobs/{sha256[0:2]}/{sha256}                 # 原件，写入后永不覆写（内容寻址天然幂等）
derivatives/{sha256}/{preset}.webp           # 派生图（缩略/预览），可随时重建，不参与 GC 语义
uploads/{upload_id}/chunks/{index}           # 未组装分片，会话过期即清
quarantine/{upload_id}                       # 解码失败/校验失败的隔离区，保留排查窗口后删除
```

- 原件只增不改；替图产生新 digest 的新对象，旧对象由 GC 按可达性决定去留。
- 派生图丢失不阻塞正式导出（可重建）；**原件缺失则阻塞**（见 §7 闸门）。

## 4. API 设计

### 4.1 分片上传（支持离线续传）

| 方法 | 路径 | 语义 |
|---|---|---|
| POST | `/v1/uploads` | 声明 `{size, sha256, mime}` 创建会话；若该 digest 的 blob 已存在 → 直接 `committed`（秒传，仍走解码校验结果复用） |
| GET | `/v1/uploads/{id}` | 返回 `{status, received_chunks, expires_at}` —— **离线续传**：客户端本地持久化 upload_id，断线重连后拉取位图，只补传缺失分片 |
| PUT | `/v1/uploads/{id}/chunks/{n}` | 幂等上传分片，带分片级 sha256 校验；重复传同片返回 200 不报错 |
| POST | `/v1/uploads/{id}/complete` | 组装 → 校验整体 sha256/大小 → 嗅探真实类型 → **服务端解码**（像素上限、解压炸弹防护）→ 建 `blob`；解码失败 → 会话置 `failed_decode`，分片移隔离区，返回 `422 IMAGE_DECODE_FAILED`，**不产生任何代次** |
| POST | `/v1/uploads/{id}/abort` | 主动放弃，清理分片 |

### 4.2 资源库与脚注

| 方法 | 路径 | 语义 |
|---|---|---|
| POST | `/v1/assets` | 用已 committed 会话建资源（首个代次） |
| POST | `/v1/assets/{id}/generations` | **替图**：新代次 `generation_no+1`，更新 `current_generation_id`；旧代次与旧脚注完全不动 |
| GET | `/v1/assets`, `/v1/assets/{id}` | 资源库浏览（含代次列表、引用计数） |
| POST | `/v1/licenses`, `/v1/licenses/{id}/revoke` | 授权登记 / 撤回（`revoked_at` 落库即生效） |
| POST | `/v1/footnotes` | 绑定 `{generation_id, license_id, caption, source, alt_text}`；按 `identity_hash` 幂等返回既有或新建身份 —— 编辑器"选资源 + 填来源与替代文本"的落点 |
| GET | `/v1/footnotes/{id}` | 读取脚注身份与当前授权状态 |

### 4.3 文稿、预览与导出

| 方法 | 路径 | 语义 |
|---|---|---|
| PUT | `/v1/documents/{id}/draft` | 保存草稿版本（正文含引用实例）；事务内物化 `footnote_ref` |
| POST | `/v1/documents/{id}/publish` | 发布：完整性+权限校验通过后生成不可变版本 |
| GET | `/v1/documents/{id}/preview?version=` | 预览渲染；**缺失/无权/解码失败的资源渲染为明确占位块**（灰底 + 原因码 + alt 文本 + "资源缺失"徽标），响应头 `X-Resource-Incomplete: true`，绝不静默裂图 |
| POST | `/v1/documents/{id}/exports` | **正式导出闸门**：逐引用复核 ①blob 存在 ②解码状态 ok ③授权未撤回未过期 ④调用者对该 asset 有读权限；任一失败 → `422 EXPORT_INCOMPLETE` + 机读明细，**不生成、不交付内容不完整的正式文件**（全有或全无） |

## 5. 垃圾回收：双账本与安全边界

### 5.1 两本账

1. **实时引用计数**（`ref_count` 三级）：随引用增删在事务内维护，快但可能漂移
   （崩溃、bug、历史数据）。只作为候选筛选条件，**绝不单独作为删除依据**。
2. **快照可达性**（权威）：从全部 retained 版本（`retain_until IS NULL OR retain_until > now()`，
   含已发布历史稿）经 `footnote_ref → footnote → generation → blob` 算可达集。
   **删除正文里的引用，只要历史稿仍可达，资源就必须保留。**

对账任务定期重算可达集并与 `ref_count` 比对：不一致 → 告警 + 以可达性为准修正计数；
漂移本身不触发任何删除。

### 5.2 清扫算法（mark-and-sweep，带视界与宽限期）

```
sweep_start = now()
horizon     = sweep_start - 10min                      -- 排除刚创建的在途对象
candidates  = blob WHERE status='active' AND ref_count=0 AND created_at < horizon
              AND 无未过期 upload_session 指向它
对每个候选（分批、SELECT ... FOR UPDATE 锁定复查 ref_count 仍为 0）：
    若不可达 → status='pending_delete', pending_delete_at = now() + 7天宽限期
janitor（宽限期届满）：
    删除前最后一次重算可达性 → 仍不可达 → 删对象存储原件 → status='deleted'
```

不变式：**宁可多留，不可误删**。任何一步不确定都偏向保留。

### 5.3 并发安全边界（竞态矩阵）

| 并发场景 | 风险 | 安全边界 |
|---|---|---|
| 上传 complete × GC | 新 blob 尚无代次引用被误删 | blob 创建即被会话引用；GC 视界排除 `created_at > horizon` 及有活动会话的对象；删除前锁行复查 |
| 发布 × 引用删除 | 发布到一半引用被删致版本残缺 | 版本行与 `footnote_ref` **同事务**插入；发布事务对涉及 `footnote` 行取 SHARE 锁；GC 只读已提交且早于视界的版本 |
| 导出 × 授权撤回 | 导出途中授权被撤回 | 导出事务开始即快照校验并锁定所涉 `license_grant` 行（或交付前最终复核一次）；撤回与导出序列化，进行中导出要么完整交付要么整单失败 |
| 清理 × 历史稿保留 | 误删历史稿仍引用的资源 | 可达性取**所有 retained 版本的并集**；`ref_count=0` 只是候选条件不是删除条件 |
| 计数漂移 | 漏删（可接受）/误删（不可接受） | 对账任务纠偏并告警；删除决策要求"计数为 0 **且** 不可达 **且** 过宽限期"三者同时成立 |
| 会话过期看门人 × 资源 GC | 职责混淆 | 看门人只清 `uploads/` 分片与隔离区；资源 GC 只动 `blobs/`；两套独立视界 |

## 6. 验收标准映射

| 验收项 | 机制落点 | 测试要点 |
|---|---|---|
| 离线续传 | §4.1 会话状态 + 分片位图 + 幂等 PUT | 上传到 60% 断网 → 恢复后 GET 会话 → 仅补传缺失分片 → complete 成功且整体 sha256 校验通过；会话过期后重传走新会话或秒传 |
| 替图不改旧版 | §2 代次钉住：`footnote.generation_id` 不变 | 替图后：旧发布版本渲染旧图、旧代次与旧 blob 保留且 `ref_count>0`；新脚注可用新代次 |
| 同脚注多次引用 | §1 身份/实例分离 + 首次出现编号 | 正文两处引用同一 `footnote_id` → 同一编号、脚注列表只出现一次；删其中一处实例，脚注与资源均存活 |
| 图片解码失败 | §4.1 complete 的服务端解码 | 伪造扩展名/截断文件/解压炸弹 → `422 IMAGE_DECODE_FAILED`，会话 `failed_decode`，分片隔离，无代次无脚注，预览与导出不受影响 |
| 导出时资源权限撤回 | §4.3 导出闸门 | 发布后撤回授权或 ACL → 导出 `422 EXPORT_INCOMPLETE` 且无机密文件落盘；预览同步转为"无权限"占位 |
| 预览清楚标示缺失资源 | §4.3 预览占位 | blob 缺失/待删/无权/解码失败 → 占位块含原因码与 alt 文本，`X-Resource-Incomplete: true` |
| 后端不交付内容不完整的正式文件 | §4.3 全有或全无 | 任一引用不完整 → 导出整单失败并返回机读明细；不存在"带占位的正式文件" |

## 7. 监控指标

`upload_session_active`、`upload_decode_failed_total`、`gc_pending_delete`、
`gc_refcount_drift_total`（对账漂移，>0 即告警）、`export_blocked_total`、
`preview_incomplete_total`。
