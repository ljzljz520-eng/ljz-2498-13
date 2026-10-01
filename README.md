# Catalpa 编辑与预览项目

## 项目介绍
本项目基于 `Vue 3 + Vite` 实现了一个 Catalpa 文本编辑与实时预览工具。  
页面采用左右分栏布局，左侧用于输入 Catalpa 内容，右侧用于即时渲染预览，适合本地写作、语法演示和轻量文档编辑场景。

## 项目功能
- 支持 Catalpa 文本实时编辑与预览
- 支持常见语法：标题、列表、引用、分割线、粗体、斜体、链接、代码块
- 内置“恢复示例”“清空内容”快捷操作
- 显示行数和字符数统计
- 使用 `pnpm` 最新版，并配置国内镜像源（`npmmirror`）
- 支持 `Docker Compose` 一键启动开发环境

## 项目目录结构
```text
.
├── Dockerfile                 # Docker 镜像构建文件
├── docker-compose.yml         # Docker Compose 启动配置
├── .dockerignore              # Docker 构建忽略文件
├── .npmrc                     # pnpm/npm 国内镜像源配置
├── index.html                 # Vite 入口 HTML
├── package.json               # 项目依赖与脚本
├── pnpm-lock.yaml             # pnpm 锁文件
├── public/                    # 静态资源目录
├── src/
│   ├── App.vue                # 主页面（编辑区 + 预览区）
│   ├── main.js                # Vue 应用入口
│   ├── style.css              # 全局样式
│   └── utils/
│       └── catalpa.js         # Catalpa 渲染逻辑
└── vite.config.js             # Vite 配置
```

## 项目部署

### 1. 本地部署（推荐开发调试）
```bash
corepack prepare pnpm@latest --activate
pnpm install
pnpm dev
```

启动后访问：`http://localhost:3000`

### 2. Docker 部署（一键启动）
```bash
docker compose up --build
```

启动后访问：`http://localhost:3000`

### 3. 生产构建
```bash
pnpm build
```

构建产物输出到 `dist/` 目录，可部署到任意静态资源服务器（如 Nginx、CDN、对象存储静态托管）。

## 镜像源说明
项目根目录 `.npmrc` 已配置：

```ini
registry=https://registry.npmmirror.com/
```

## 图片脚注资源库（本次新增）

为文稿产品提供图片脚注的**资源库 → 分片上传 → 正文引用 → 快照/发布 → 可达性 GC** 全链路。
纯前端仓库用「IndexedDB 对象存储 + localStorage 关系库」完整模拟服务端，API 契约可一一映射到真实对象存储/关系库。

- 设计文档：[`docs/figure-footnotes-design.md`](docs/figure-footnotes-design.md)
- 核心模块：`src/figures/`
  - `storage.js`：内容寻址对象存储（同 sha 物理只存一份原件）+ 关系库 + 分片暂存
  - `api.js`：上传会话/资源版本/授权/文稿/发布/GC 全部 API，单互斥串行化写操作
  - `uploader.js`：客户端分片、离线暂存、断点续传
  - `citations.js`：引用标记解析、实时计数、本次排版顺序编号
  - `preview.js`：预览富化（ok / missing / revoked / undecodable 四态 + 脚注列表）
  - `export-gate.js`：正式导出门禁（任一资源问题则整体拒绝，不交付不完整文件）
  - `gc.js`：从「正文 ∪ 全部保留快照 ∪ open 上传」计算可达对象，`verifyConsistency` 对账实时计数
- 验收测试：`pnpm test`（13 项，覆盖全部验收点）

### 关键规则

| 规则 | 实现 |
|------|------|
| 同内容共享存储；授权/图注不同不去重合并 | BlobObjectStore 按 sha256 共享原件；Resource 是独立逻辑实体，授权检查挂在资源上，哈希不能作为越权取件凭证 |
| 脚注身份与引用实例分离 | `Resource/Version`（身份、可多版本）vs 正文标记内 `#cit_instanceId`（实例），一对多 |
| 自动编号依本次排版顺序 | 每次渲染按资源首次出现重新编号；同资源多次引用共享编号并列脚注回链 |
| 删正文引用不删历史稿资源 | GC 根集包含所有保留快照引用；只有删除最后一个保留快照后对象才可回收 |
| 实时计数 vs 快照可达 | 「版本/发布/GC」面板可随时对账，偏差显式列出 |
| 并发安全边界 | 全部写操作走单一互斥；草稿乐观版本号；发布先冻结快照后门禁导出；GC 与发布/completeUpload 互斥 |
| 预览标示缺失、正式文件完整 | 预览四态显著占位 + 缺失横幅；发布/导出走门禁，缺失/撤权/解码失败即拒绝且不写 artifactId |
| 替图不改旧版 | 换图新增不可变版本；快照冻结版本指针与图注，旧引用永远解析旧图 |

### 验收点 → 测试

离线续传 / 秒传去重 → `figures.test.js` 用例 1、2；共享存储与授权/图注隔离 → 3；多次引用与重排编号 → 4；计数对账 → 5；删引用+GC+保留版本 → 6；替图不改旧版 → 7；解码失败 → 8；导出时撤权 → 9；缺失资源标示/门禁 → 10；并发保存/GC 竞态 → 11；完整发布清单 → 12。

### 操作提示（界面）

1. 左侧「资源库/上传」选择图片（可先切换到**离线**体验分片暂存，再联网点「续传」）；
2. 填写图注、替代文本、来源、授权 principal，入库后「插入引用」（可在同文多次插入）；
3. 「版本/发布/GC」页保存草稿（产生保留快照）、发布正式文件、运行计数对账与 GC；
4. 用「撤回 guest 授权」「替图」后，切换到 guest 身份预览/重新导出旧快照，观察门禁拒绝；
5. 预览顶部横幅汇总缺失/无权/损坏资源——这些问题存在时后端不会交付正式文件。
