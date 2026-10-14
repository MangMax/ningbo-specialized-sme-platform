# 09 — 文件管理页 + 文件表(统一管理)

**What to build:** app 新增 `/files` 页,统一管理**现有 23 个 + 之后上传的**全部文件;新增一张表记录文件的元数据与处理状态。

**Blocked by:** —

**Status:** implemented(实现已完成,**待独立复核 + oil-ui 验收** —— 见文末「实现记录」)

## 为什么先做这张表

现在 `files/` 里的文件**只有磁盘上的路径**(`record_evidence.source_file` 引它),**没有一行元数据**:谁来分「来源 / 类别 / 年份 / 批次」、谁记「已分类 / 待分类」「已解析 / 未解析」、谁挂 OCR 结果?—— 都缺。故先立表。

## 表:`stored_file`(建议名)

| 列 | 说明 |
|---|---|
| `id` PK | |
| `rel_path` UQ | 文件库内相对路径(`jxj/announcement/2024/1/….pdf`) |
| `filename` / `ext` / `bytes` / `sha256` | 磁盘事实(启动时扫描 `files/` 回填) |
| `source` / `kind` / `year` / `batch` | **可空** —— 允许「上传时未定、后续回写」(票 12) |
| `title_code` | 可空;该文件对应的称号 |
| `category_state` | `set` / `inferred` / `unset` |
| `parse_state` | `unparsed` / `parsed` / `failed` |
| `created_at` | |

> 现有 23 个文件:写一个**一次性回填**(扫 `files/` + 按目录规则反推 source/kind/year/batch,复用 `pipeline/src/files.ts` 的 `resolveJxjParts`)。**回填要幂等**。

## 页面 `/files`

- 列表:文件名 / 来源 / 类别 / 年份 / 批次 / **分类状态** / **解析状态** / 引用记录数 / 大小。
- 筛选:来源、分类状态、解析状态;搜索文件名。
- 行操作:**编辑元数据**(shadcn `Dialog` + `Select`/`Input`)、**预览**(复用平行会话已做的 `FilePreviewDialog`)、**删除**。
- 顶部:**上传**(票 10 接 tus)。
- 侧栏加入口(`AppSidebar.vue`),图标如 `FolderOpen`/`Files`。

## 接口(概要)

- `GET /api/files?source=&categoryState=&parseState=&q=&page=&pageSize=` → 列表
- `PATCH /api/files/:id` → 改 `source/kind/year/batch/title_code`(仅元数据,**不动磁盘文件**)
- `DELETE /api/files/:id` → 仅从库与索引移除 + 打标;**默认不删磁盘文件**(要删磁盘须显式二次确认)

## 测试

- [x] 回填幂等:重跑两次,行数不变。
- [x] `PATCH` 只改元数据、不改 `rel_path`、不动磁盘。
- [x] 列宽/排序稳定;分类状态筛选正确。

## 验收

- [x] 页面上能看到**现有 23 个**文件,元数据与目录规则一致。
- [x] 改一个文件的年份 → 列表即时更新,磁盘文件不变。
- [x] app `pnpm typecheck && pnpm test` 全绿。

**分支**:`feat/file-manager`。**只提交本票文件。**

---

# 实现记录(会话交付;非自评通过)

## 一、已完成

| 项 | 落点 |
| --- | --- |
| 新表 `stored_file` + drizzle 迁移 | `db/schema.ts`、`db/migrations/0002_smart_runaways.sql` |
| 一次性回填(扫 `files/` 反推分类,**幂等**) | `lib/stored-file.ts`(纯规则)、`server/utils/stored-files.ts`(扫描+落库) |
| 页面 `/files`(列表/筛选/搜索/分页) | `pages/files.vue` |
| 行操作:编辑元数据 / 预览 / 移出 | `components/files/EditFileDialog.vue`、`components/files/DeleteFileDialog.vue`、复用 `components/preview/FilePreviewDialog.vue` |
| 侧栏入口 + 上传占位 | `components/AppSidebar.vue`、`pages/files.vue` |
| 接口 | `server/api/files/index.get.ts`、`server/api/files/[id].patch.ts`、`server/api/files/[id].delete.ts` |
| 文案标签单一来源 | `lib/labels.ts` 新增 `KINDS` / `CATEGORY_STATES` / `PARSE_STATES` 及其顺序 |
| 测试 | `tests/stored-file.test.ts`(31 条) |

**规则复用(票面允许的「照抄并注明来源」)**:`lib/stored-file.ts` 的 `parseBatch`
照抄 `pipeline/src/normalize.ts`;`resolveJxjParts` 的取段思路照抄 `pipeline/src/files.ts`。
app 不能 import `../pipeline`(本仓之外),故照抄。**两处 `parseBatch` 必须同步**;文件头已注明。

## 二、未完成(本票范围之外,按票面就是下一张)

- **上传通道未接**:票面明说「票 10 才接 tus」,本票只在页头放了**置灰**的「上传」按钮
  (带 tooltip 说明),没有伪造可用上传。
- **分类回写未做**:`category_state='unset'` 的推断/回写是票 12;**本票只把状态记出来并支持筛选**。
- **「待分类 N 件」入口未做**:票 12 的页面要求。
- **物理移动未做**:改 `source/kind/year/batch` **只改元数据,不移动磁盘文件**(票面硬要求)。
  因此改完之后 `rel_path` 与分类**可以不一致**;把文件搬到与分类一致的位置是后续决策,
  本票**不做**(见「已知缺口」)。

## 三、已知缺口 / 需要复核者注意

1. **`files/2022/公布.pdf` 的年份是 2022,不是 null。**
   该文件路径是 `jxj/announcement/2022/公布.pdf` —— 目录里有 `2022` 段,按规则
   (年份取目录)`year=2022`、`batch=null`(目录无批次段)。这是**目录给出的**,不是硬填。
   我先前在会话里说过它会是 `year=null`,那是错的,以此处为准:规则只从目录反推,
   文件名无年份就**不**从文件名补,但**目录有就取目录**。
   实测分布:2022×2、2023×6、2024×5、2025×4、2026×3、miit×3(无年份)—— 合计 23。
2. **两个 `.doc` 的「被引用」是 0**:`2023/1` 的两份 `.doc` 是归档原件,
   台账里 `record_evidence.source_file` 指向的是同名的**转出件 `.docx`**(见 `files/README.md`)。
   所以 `.docx` 有引用数、`.doc` 为 0 —— 是事实,不是漏算。
3. **`parse_state` 全部是 `unparsed`**:它记的是**新的解析管线**有没有从文件产出记录
   (票 11/14),而这批文件是**旧管线**产出的。是否把「已被台账引用」的文件标成 `parsed`
   是**口径问题**,本票保守留 `unparsed`,并把「被引用数」单独一列摆出来 —— 两列合看
   就是「有没有被用过」。**若复核认为该标 `parsed`,这是一处待定的口径。**
4. **删除是软删除**:`DELETE` 只打 `removed_at` 标,列表默认不显示;这样回填不会把它复活
   (回填幂等要求)。磁盘默认不动,`?deleteDisk=1` 才 unlink —— 界面为它做了**单独勾选**的二次确认。
5. **`title_code` 回填时一律留空**:从文件名猜称号是**票 12** 的活,本票不猜(**空值优于错值**)。
6. **列表未用虚拟化**:台账页有 `@tanstack/vue-virtual`,本页没有 —— 文件量级(23→以后几十~几百)
   用**分页**即可,虚拟化是多余复杂度。滚动容器与吸顶表头与台账页**同款 class**,
   「表格滚动条与台账页一致」这条满足;若复核要求连虚拟化也一致,再补。

## 四、测试与核对证据

- **测试**:`pnpm test` → **12 files / 168 passed**(基线 137 + 本票 31)。
- **类型**:`pnpm typecheck` → 通过(0 error)。
- **回填核对**:首次 `GET /api/files` 触发懒回填 → `{inserted: 23, updated: 0, unchanged: 0, skipped: []}`,
  列表 `total=23`。逐个核对(来源/类别/年份/批次)与目录规则一致,见上「已知缺口 1」的分布。
- **PATCH 核对**(对真实文件 `jxj/announcement/2022/公布.pdf`):改年份前后
  `sha256`/`bytes`/`mtime` **逐字节不变**,`rel_path` 不变,列表立即返回新值;
  传 `{relPath}` / `{bytes}` / `{sha256}` 一律 **HTTP 400**。
- **UI 核对**:真实 dev server 上 —— 列表 23 行;来源筛选「工信部」→ 3 行(全 `miit/export`);
  编辑对话框改年份保存 → 列表即时更新;删除对话框正确显示「有 3268 条记录把它作为出处」;
  预览弹窗渲染出真实 PDF 正文。

### 截图(过程产物,`.gitignore` 已忽略 `.scratch/**/evidence/`)

| 场景 | 路径 |
| --- | --- |
| `/files` 列表(23 个文件) | `.scratch/ingest-pipeline/evidence/09-files-main.png` |
| 编辑元数据对话框 | `.scratch/ingest-pipeline/evidence/09-files-edit-dialog.png` |
| 改年份后列表即时更新(首行 `2031`) | `.scratch/ingest-pipeline/evidence/09-files-after-edit.png` |
| 移出确认(含引用数提醒 + 删盘二次确认) | `.scratch/ingest-pipeline/evidence/09-files-delete-dialog.png` |
| 预览(复用 `FilePreviewDialog`,渲染真实 PDF) | `.scratch/ingest-pipeline/evidence/09-files-preview.png` |

> 截图为**实现分支上**所拍(油 3472);合并 `main` 后的 oil-ui 验收会话请自行在 `main` 上复拍。

## 五、独立评审(`code-review`,两轴)与处置

按 implement-spec 第 7 步,对 `main...feat/file-manager` 跑了 Standards + Spec 两轴独立评审。**采纳并已修**:

| 发现 | 轴 | 处置 |
| --- | --- | --- |
| `EditFileDialog.vue` 把「经信局/工信部/公布文件/导出表」写死在组件里,违反「标签只从 `lib/labels.ts` 取」 | Standards(**硬**) | 改为从 `SOURCE_ORDER`/`KIND_ORDER` + `SOURCES`/`KINDS` 生成下拉项 |
| `pages/files.vue` 的 `onSizeInput`、`scrollRef` 是死代码 | Standards | 删掉(分页条数走 shadcn `Select`) |
| `countByCategoryState` 导出但无人调用(票 12 的接口提前出货) | Standards/Spec | 删掉,留到票 12 |
| `listStoredFiles` 与 `getStoredFile` 的 15 列投影逐字重复 | Standards | 抽成 `fileColumns` 一处 |
| `KINDS`/`CATEGORY_STATES`/`PARSE_STATES` 数组与 `labels.ts` 的 `*_ORDER` 重了一份 | Standards | 改为从 `labels.ts` 的 `*_ORDER` 派生(那里已是唯一来源) |
| `StoredFileQuery` 用 `string[]`,逼出 `as FileSource[]` 断言 | Standards | 直接用领域联合类型 |
| `PATCH` 白名单多收了 `categoryState` / `parseState`(票面只给五项) | Spec | 白名单收回到 `source/kind/year/batch/titleCode`;状态仍由「分类是否补齐」自动维持 |
| 响应里多了个没人消费的 `enums` 对象 | Spec | 删掉(前端直接用 `labels.ts`) |
| `?includeRemoved=1` 是未记载的接口参数 | Spec | 从 HTTP 层撤掉(查询层与测试仍保留,用于验证软删除) |
| 注释称搜索「大小写不敏感」,而 SQLite `LIKE` 只对 ASCII 如此 | Spec | 注释改成准确表述 |

**未采纳 / 已解释**:

- **`inferred` 从不产生**(23 个全是 `set`)。这是**有意的口径**:文件库的目录结构
  (`files/<source>/<kind>/<year>/<batch>/`)是 pipeline 依规则**放**出来的**既成事实**,
  不是猜 —— 所以回填记 `set`。`inferred` 留给票 12(从**文件名/正文**猜,需带依据、需人确认);
  否则 23 行会全挂「推断分类」,反而把「真正待确认」淹没。**若复核认为目录反推也算推断,请指明** ——
  改一行即可(`categoryStateOf` 返回值),但那样票 12 的「待确认」信号会失去分辨力。
- **年份/批次会回退文件名**:与 `files/README.md`「year/batch 取值」第 3 条
  (「目录给不出时,回退到文件名里解析」)以及 `pipeline/src/files.ts` 的 `resolveJxjParts`
  **逐条一致** —— 票面要求复用该规则,故保留。已知风险:文件名里的四位数字可能是**文号**年份
  (如 `〔2024〕19号关于公布2023年第二批…` → `parseBatch` 取到 2024)。**目录有就绝不用文件名**,
  所以这批 23 个文件不受影响;已补一条测试把这个兜底行为钉住并注明风险。
- **`?rescan=1`**:未记载但有意保留 —— 一次性回填默认只在本进程首请求跑一次;文件在 app 外
  被改动后要能重扫。已在 `index.get.ts` 的文档注释里写明。
- **改共享 README**:票面交付项明确要求「更新票 09 状态与 README 表格」,故加了 `状态` 列
  (只动 `.scratch/ingest-pipeline/issues/README.md`,不涉源码)。

**修后复验**:`pnpm test` → 12 files / **169 passed**;`pnpm typecheck` → 0 error;
`/api/files` 返回键收敛为 `{rows,total,backfill}`;`source=miit`→3、`categoryState=unset`→0、
`parseState=unparsed`→23、`q=58号`→1;`PATCH {relPath}` 与 `PATCH {categoryState}` 均 **400**;
重启后回填 `{inserted:0, unchanged:23}`(幂等)。

