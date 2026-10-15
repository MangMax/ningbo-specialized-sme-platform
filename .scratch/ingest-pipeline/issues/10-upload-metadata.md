# 10 — 上传与元数据:页面接 tus + 手动设来源/年份/批次

**What to build:** 把已存在的 tus 上传端点接到 `/files` 页;上传时可由用户**手动设置**来源 / 类别 / 年份 / 批次;也可留空(交给票 12 回写)。

**Blocked by:** 09

**Status:** done — 实现 af5d1c8 已经 ffad2e2 合入本地主线；下文实现者交接中的待 rebase / main 尚无路由为历史状态，现已失效。2026-10-15 全新流程上传复验另见票12。

## 交接(实现者 → 主代理)

**踩坑提醒**:本票从 `0857686` 起(用户指定)。**但 `main` 期间前进了** ——
`58242ba` 已合入票 13/16/18/19/11/15 并带来迁移 `0004`。本票的改动面与那些**不重叠**
(见下「与 main 的关系」),但**合入时需要先 rebase 到当前 main**。

### 已完成

1. **`/files` 页接了上传**:`PageHeader` 的「上传」按钮(原先 `disabled` 占位)现在打开
   `components/files/UploadDialog.vue`(shadcn `Dialog`),里面复用**未改动内部逻辑**的
   `UploadPanel`(票 09 的产物)。
2. **传完登记进 `stored_file`**:新 `POST /api/files/register` + `server/utils/stored-files-upload.ts`。
   客户端从 tus 响应头 **`X-Upload-Path`** 拿落位路径(**不在客户端重推**),连同用户填的
   来源/类别/年份/批次送出;`rel_path` / `bytes` / `sha256` **由服务端从盘上读**
   (客户端自称的一律拒:`bytes`/`sha256` 出现在请求体里直接 400)。
3. **元数据校验在服务端**(400 且**不落库**):
   - 来源/类别走 `server/utils/tus.ts` 的 `landingSegments`(**该文件的落位规则一行未改,只调用**);
   - 年份四位、批次**正整数**(`landingSegments` 的 `isBatch` 放行 `0`,登记侧按票 09 `PATCH`
     的口径再收紧一道);
   - **声明与实际落位必须一致**(目录段逐段比):路径是服务端算的、声明是客户端发的,
     不一致说明有人改了声明;
   - 路径锁根 + 磁盘上必须真有这个文件。
4. **空值优于错误值**:来源/类别没填 → `null` + `category_state='unset'`(由票 09 同一条
   `categoryStateOf` 推出,**不硬填**),交票 12 回写。
5. **列表立即出现**:登记成功后 `UploadDialog` emit `registered` → 页面
   `queryCache.invalidateQueries({ key: ['files'] })`,新行**不用手动刷新**。
6. **文件名建议值**:`MetadataFields` 从文件名推导(`lib/upload.ts` 的 `suggestBatch`)显示成
   一行「文件名里有 2025 · 第2批 [采纳]」,**不自动回填** —— 用户点了「采纳」才写入,且
   **只补空着的字段**(票 10「最终以用户填写为准」)。
   > 顺带删掉了 `UploadPanel.openAddDialog` 里原先的**自动预填**:那正是「替用户拍板」,
   > 而文件名里的年份常是复核的原始认定年份(`lib/stored-file.ts` 有同名告诫),猜错就是错落位。

### 未完成 / 已知缺口

- **「全部字段都不填」在 UI 上到不了**。tus 的落位规则**要求** `source`/`kind`
  (票 02 定的、本票不得改),没有它们文件无处可落。所以 UI 上能有的「未填」是
  **年份/批次留空**(公布文件 → `category_state='unset'`)。**全空的 `null` 行在
  API/登记层是支持的、有单测覆盖**(`registerStoredFile` 传全 `null`),
  只是 tus 那条路走不到 —— 票 12 若要「一口气传一批不填」,得先解决「没分类的文件落哪」。
- **关掉上传弹窗会中止在传的上传**(`UploadPanel` 原有的卸载行为:保留服务端断点,
  重新选入同一文件即可续)。本票没改这个行为,也没做「传输中禁止关闭」。
- **登记失败时文件已在盘上、库里没有**:UI 会红字说明并把落位路径列出来(不假装成功),
  但**没有自动重试**。重传同一文件会落 ` (n)` 而不是复用那一行。
  (登记本身**幂等**,手动重试同路径不会产生第二行。)
- **`register` 会接受「文件库里已存在、但不是经 tus 传上来的」路径**(只要声明与落位一致)。
  这是**有意的**:回填先插、登记后到时,同一行被刷新而不是冲突;代价是没有「必须是本会话传的」这条约束。
- 本票**未建迁移**(约束要求),也**未改** `server/utils/tus.ts` / `lib/file-parts.ts` /
  `lib/stored-file.ts` 的既有规则(只调用;`tus.ts`/`file-parts.ts`/`stored-file.ts` 的 diff 为空)。

### 独立评审(`code-review`,两轴)与处置

**Standards 轴**(DESIGN / SPEC 硬约束 / UI 验收基线):无 UI 回归(未加原生控件、
沿用 shadcn、`text-destructive!` 对比度处理与路径块样式延续)。提出并**已修**:

| 发现 | 处置 |
|---|---|
| `sha256Of` 在 `stored-files-upload.ts` 里逐字复制了一份 | 从 `stored-files.ts` **导出**并引用 |
| 锁根判据`abs !== root && !abs.startsWith(root+sep)` 已有 3 份 | 抽 `resolveInsideRoot()`,删除/预览/登记三处共用 |
| `describeFetchError` 在 `UploadDialog` 与 `pages/files.vue` 各一份 | 抽到新 `lib/upload-register.ts` |
| `chrome?: 'card' \| 'plain'` 只有 1 个调用点、恒为 `plain` | **删掉该 prop**,面板只留无外壳布局,标题归弹窗 |
| `task.declaredMeta ?? buildMetadata(当下 meta)` 会退回读当下表单 | 改为断言(快照在 `startTask` 必已赋值) |
| `pages/files.vue` 里 `uploadOpen` 的注释写的是 `refresh()` | 注释归位 |
| `nullable()` 与 `text()` 两处同形 | `lib/upload-register.ts` 的 `toRegisterBody` 一处收口 |

**Spec 轴**:硬约束全过(tus/file-parts/stored-file 未改、无迁移、只用 shadcn、
`X-Upload-Path` 复用、Colada 失效)。指出并**已修**:

- 「文件名建议值」原先只存在于 `openAddDialog` 的自动预填里(与「不要自动填死」相抵) →
  改为 `MetadataFields` 的显式「采纳」;
- 「列表端到端」缺测试 → 补 `listStoredFiles`(票 09 的查询层,含 `removed_at IS NULL`/分页/投影)
  的两条断言;
- 「400 未在路由层证」→ 仓库没有 Nitro 路由测试台(`defineEventHandler` 等是自动导入的全局),
  改为**对真跑的 dev server 用 curl 证**(见下「验收证据」第 3 条),并保留 util 层抛出
  `UploadRegistrationError`(带 `statusCode=400`)的单测。

**未采纳**:「`lib/upload.ts` 的选项标签改成取自 `lib/labels.ts` 属范围外」。本票硬约束是
**「标签只从 `lib/labels.ts` 取」**;改动前是 `lib/upload.ts` 里手写的「经信局/工信部」,
属性别与约束都不合。改动**文案零变化**(同值同序),故保留。

### 与 main 的关系

`git diff 0857686 main --name-only` 与本次改动面**无交集**:`pages/files.vue`、`lib/upload.ts`、
`components/upload/*` 在 main 上都**未变**;main 新增的 `0004` 迁移本票**不使用**。
`POST /api/files/register` 在 main 上尚不存在(无路由冲突)。

## 现状

- `server/utils/tus.ts` + `server/middleware/tus.ts` 已是**可用的写路径**,落位规则 `landingSegments`(纯函数)。
- `components/upload/` 下已有 `UploadPanel` / `UploadDropzone` / `MetadataFields` / `UploadItem`(oil-ui 打磨过)。**复用它们**,不要重写。

## 要做的

1. 把 `UploadPanel` 挂进 `/files` 页(或它的弹窗里)。
2. 上传完成后,把落位结果**登记进 `stored_file`**(票 09 的表):`rel_path`、大小、sha256;`source/kind/year/batch` 取用户填的,没填就是 `null` + `category_state='unset'`。
3. **metadata 校验**:来源/类别走白名单(沿用 `tus.ts` 的 `SOURCES`/`KINDS`);年份为四位数字;批次为正整数或空。
4. 若用户在**文件名**里已写明年份批次(如 `…2024年第2批…`),`MetadataFields` 可给**建议值**(复用 `lib/upload.ts` 的 `suggestBatch`/`fingerprint`),但**最终以用户填写为准**。

## 测试

- [x] 上传成功 → `stored_file` 出现一行,`rel_path` 与磁盘一致。
- [x] 元数据非法(来源不在白名单、年份非四位)→ 400,不落库。
- [x] 上传未填元数据 → 行存在、`category_state='unset'`。
- [x] 上传成功后 `/files` 列表能看到它(端到端:`listStoredFiles` 断言)。
  > 路由层(HTTP 400 + 列表出现)没有单测台可跑,改为对真跑的 dev server 用 curl 验;见「验收证据」。

## 验收

- [x] 在页面上传一个 PDF,能在列表看到它、来源/年份/批次与所填一致。
- [x] 磁盘上文件落在 `files/<source>/<kind>/<year>/<batch>/` 规则路径。
- [x] app 测试全绿。

## 验收证据(2026-10-14,worktree `/tmp/up-wt/app`,`pnpm dev --port 3483`)

1. **页面上传一个 PDF → 列表出现、来源/年份/批次与所填一致。**
   截图:`.scratch/ingest-pipeline/evidence/10-upload-dialog.png`(弹窗)、
   `10-uploaded-list.png`(传完,列表 23 → 24、新行在首行)。
2. **实际落盘路径**(磁盘为证):
   - `files/jxj/announcement/2026/2/sample.pdf`(勾选经信局/公布文件 + 年份 2026 + 批次 2);
   - `files/jxj/announcement/2025/2/甬经信中小〔2025〕30号关于公布2025年度第二批名单的通知.pdf`
     (用文件名建议「采纳」出的 2025/2 —— 建议可采纳、但**不自动填**)。
   两次的 `stored_file` 行经 `GET /api/files` 复核:`rel_path` 与磁盘逐字一致,
   `bytes`/`sha256` 由服务端从盘上算(`sample.pdf`:69 B)。
3. **元数据非法 → 拒绝,且 `stored_file` 没有新行**(对真跑的 dev server):
   | 请求 | 结果 |
   |---|---|
   | `source: "evil"` | **400** `source 不在白名单: evil` |
   | `year: "26"` | **400** `year 必须是四位数字: 26` |
   | `batch: "0"` | **400** 批次必须是正整数:0 |
   | 请求体带 `bytes` | **400** 不可提交的字段:bytes |
   | tus 建传时 `source=evil` | **400**,且文件库里**不留任何落位文件** |
   以上四次 `POST /api/files/register` 前后 `GET /api/files` 的 `total` **都是 24(未变)** → 不落库。
   UI 侧另有前端即时拦截(年份 `26` → 输入框转红 + 「年份要四位数字」、`加入队列` 置灰),
   截图 `10-invalid-rejected.png`。
4. **未填年份/批次 → 行存在、`category_state='unset'`**:
   传 `unset.pdf`(来源=经信局、类别=公布文件、年份批次留空)→ 落 `files/jxj/announcement/unset.pdf`,
   行 `year: null, batch: null, categoryState: "unset"`(API 复核)。
5. **亮/暗两套**:`10-upload-dialog.png` / `10-upload-dialog-dark.png`。

**测试**:`pnpm typecheck` exit 0;`pnpm test` → **14 files / 214 tests 全部通过**
(基线 196 项 + 本票新增 18 项)。

> 截图目录 `.scratch/**/evidence/` 已在 `.gitignore` 里(过程产物不入库),故上面写的是**路径**。

**分支**:`feat/upload-metadata`。
