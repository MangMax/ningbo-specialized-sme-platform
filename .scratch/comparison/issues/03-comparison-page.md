> **历史阶段说明（#591）**：下文保留 2026-10-14/15 阶段材料及验收记录。本地草稿不是当前 published tracker；当前工单见 [GitHub Issues](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/591)，使用规则见[仓库 tracker 规范](../../../docs/agents/issue-tracker.md)。原文中的完成状态、数字及成功/失败记录仅对应当时输入，本次文档注记不构成重跑或当前运行保证。
> 呈现方向后继见 [#22](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/22)及其[关闭说明](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/22#issuecomment-6262788708)：该说明继承既有验收、未重新运行测试，并删除旧 `verify:ledger-ui` 像素门禁，本次不恢复该门禁。[#440 的关闭说明](https://github.com/MangMax/ningbo-specialized-sme-platform/issues/440#issuecomment-6681620212)明确“不再计划”，不代表原 AC 全部完成，也不是本历史材料的已完成替代。Tabs/tooltip 漏检、tus 失败后通过及真实漂移未通过等原有记录仍按各自输入保留，不以 fixture 替代真实数据验收。
> 读取后继另见[历史差集 summary/full 契约](../../../docs/comparison-summary-contract.md)；本次未复验页面或导出。

# 03 — 比对页面 `/comparison` + 侧栏入口 + 导出

**What to build:** 新增只读页面 `/comparison`,按称号分 tab,每个 tab 下分「应纳未纳 / 应出未出」两个方向,各一张差异清单;可导出当前方向。侧栏加入口。

**Blocked by:** 02 — Nitro 接口 `GET /api/comparison`

**Status:** ✅ done(页面/侧栏/导出已完成;真实库漂移徽标验收受字段缺失阻塞,见下)

## 组件硬约束

- **只用 shadcn-vue 官方组件**(`pnpm dlx shadcn-vue@latest add @shadcn/<name>` 拉取),可组合 / 变体 / 业务性修改;**不得手写或用原生 `<table>/<input>/<select>`**。滚动条风格与台账表一致。
- 复用现有组件:`StatTile`(概览数字)、`TitleBadge`(称号)、`DrillChip`(下钻)、导出按钮(台账页现用那个)。
- 取数用 **Pinia Colada `useQuery`** + `placeholderData: (previous) => previous`,切 tab / 换方向**不闪回、不跳位**。

## 页面结构

- **Tabs**(shadcn Tabs)按称号:`专精特新中小企业` / `创新型中小企业`。**小巨人不出现在比对里**(恒空),不放空 tab;若要提示,放一句说明文案而非空表。
- 每个称号 tab 内,两个方向并置或再分 Tabs:**应纳未纳**(在经信局、不在工信部)/ **应出未出**(在工信部、不在经信局)。两方向各带**计数徽标**(取自接口 `counts`,不数当前页)。
- 每张表列:企业名称 / 统一社会信用代码 / 区县 / **另一侧状态** / 备注。单元格里对以下情形用 `Badge` 标注:
  - `当前城市 ≠ 宁波市`(漂移,如「嘉兴市」)—— 提示多半是这类原因;
  - 登记状态含「注销 / 吊销」;
  - `curated`(人工已核实)—— 票 04 接入后显示。
- 页顶一句**口径说明**(简短):按统代比对、不限年份、含 2021 入库培育、小巨人无经信局来源。

## 导出

- 复用现有导出通道,**列 = 企业名称 / 统一社会信用代码 / 区县 / 称号 / 方向 / 当前城市 / 登记状态 / 备注**;导出**当前 tab + 当前方向**的结果。
- 若导出路由是按台账筛选拼的,新增一个 `GET /api/comparison/export`(或在现有 export 路由上加 `mode=comparison`)——**择一**,不要两套并存。文件名含称号与方向。

## 侧栏

- `components/AppSidebar.vue` 加入口:`比对` → `/comparison`,图标沿用现有 lucide 风格(如 `GitCompareArrows`)。放在「数据质量」之后。
- 路由高亮沿用 `NavMain.vue` 现有前缀匹配规则。

## 测试

- 无 UI 单测;以**真实库人工验收**。
- 若导出是新路由,补一条接口测试断言列头与条数(参照现有 `tests/export.test.ts`)。

## 验收(人工)

- [x] 市专 tab:应纳未纳显示 **337** 条、应出未出 **13** 条;总数与 `/api/comparison` 的 counts 一致。
- [x] 创新型 tab:**543 / 28**。
- [x] 筛选/切 tab 时表格**不闪回原位**(与台账页同样的体验标准)。
- [ ] 漂移企业在表内**可见且被标注**(如 `宁波德业日用电器科技有限公司` 标「嘉兴市」)。
      **保持未勾**：真实库 `city` / `reg_status` 全空，无真实值可验；fixture 只能证渲染，不能证真实数据（见下「真实数据限制」）。属**已记录范围边界**，不另开外部采集。见文末收口说明。
- [x] 导出文件能打开,列与口径说明一致。
- [x] `pnpm typecheck`、`pnpm test` 通过。

**分支**:`feat/comparison-page`。**只提交本票涉及的文件。**


## 2026-10-14 实施与验证

- 新增 `pages/comparison.vue`:称号 Tabs + 方向 Tabs,徽标/概览数字来自全量 `counts`;Pinia Colada `useQuery` 保留 `placeholderData`,复用同一面板及固定高度滚动容器。每页 25 条,企业名可下钻,吸顶表头、等宽统代。小巨人仅在口径说明出现。
- 沿用 `PageHeader` / `StatTile` / `TitleBadge` 与台账 `Button as-child` 导出用法。实际仓库没有 `ExportButton.vue`,没有另造导出组件;DrillChip / BarRow / FilterChip 的 props 已读,本页没有对应的统计下钻、构成条或可移除筛选需求,不强塞这些控件。
- 官方 CLI `pnpm dlx shadcn-vue@latest add @shadcn/tabs` 新增 Tabs 组件,沿用品牌 token,触发器加 150ms 咔嗒反馈与减少动效支持。布局 `SidebarInset` 加 `min-w-0`,使宽表仅在表格容器滚动,1280px 窗口实测整页横向溢出为 0。
- 侧栏「比对」放在数据质量之后,图标 `GitCompareArrows`。
- 导出只扩展现有 `GET /api/export?mode=comparison&title=...&direction=...`,没有第二套端点;导出当前称号/方向的全部结果,文件名通过 UTF-8 `filename*` 含称号与方向。备注保留无统代说明,城市与登记状态单独成列。
- 未改 `lib/comparison.ts`、`server/api/comparison.get.ts`、schema;未实现票 04,没有人工标注读写。

### 命令与真实库

- `pnpm typecheck`:exit 0。
- `pnpm test`:9 个文件、112 项测试全部通过。新增 `tests/comparison-export.test.ts` 四项路由行为测试:完整选择集/八列/中文文件名、反方向、旧台账兼容、非法筛选 400。真实计算层用 fixture SQLite,Excel 文件写出后以 ExcelJS 读回断言;分页参数不截断导出(27 行用例)。
- 保留已有 3000 服务,通过 `NUXT_IGNORE_LOCK=1 pnpm dev --port 3470` 启动独立服务,读取原始 `data/roster.db`。
- `curl 'http://localhost:3470/api/comparison?title=specialized_sme'`:total=350,counts.specialized_sme=`{ missing_in_miit: 337, extra_in_miit: 13 }`。
- `curl 'http://localhost:3470/api/comparison?title=innovative_sme'`:total=571,counts.innovative_sme=`{ missing_in_miit: 543, extra_in_miit: 28 }`。
- 四个 `mode=comparison` 真实 HTTP 导出以 ExcelJS 成功打开,断言八列,行数依次 337 / 13 / 543 / 28。
- 浏览器人工验收:两称号的两方向徽标均与 counts 一致。延迟请求 1000ms 时切换称号:同一滚动容器、scrollTop=120、容器 top=368、window.scrollY=0、旧表体 25 行仍保留;响应后市专应出未出为 13 行,无清空/跳位。

### 截图与真实数据限制

截图保存在本机(遵循现有 `.gitignore`,不提交图片):

- 真实市专 337 / 13:`/Users/mang/Workfile/宁波/专精特新/20261013/app/.scratch/comparison/evidence/03-specialized-real.png`
- 真实创新型 543 / 28:`/Users/mang/Workfile/宁波/专精特新/20261013/app/.scratch/comparison/evidence/03-innovative-real.png`
- **独立 fixture** 城市/注销徽标:`/Users/mang/Workfile/宁波/专精特新/20261013/app/.scratch/comparison/evidence/03-badges-fixture.png`

**真实漂移徽标验收尚未通过,不能把 fixture 当真实数据证明。**只读 SQL `select count(*),count(city),count(reg_status) from enterprise` 返回 `(7425,0,0)`;德业日用企业 id=31 的 city/reg_status 均 NULL,API evidence 同样为空。页面按契约展示非宁波城市与含注销/吊销的登记状态,但现有真实库没有任何可展示值。未写入或修补真实库,也未改票 01/02 来伪造此字段。

为独立验证渲染,把真实库备份到 `/tmp/comparison-page-badges-fixture.db`,**仅在副本**把德业日用 city 设为「嘉兴市」、reg_status 设为「注销」,以 `NUXT_DB_PATH=/tmp/comparison-page-badges-fixture.db` 在 3471 启动。第 6 页可见该企业两个 Badge,fixture 截图已人工查看。真实库补齐这两个字段后,仍需重新做真实漂移/注销验收;这属于数据补齐,未扩入本票。

- 最终串行复跑 `pnpm test`:9 个文件、112 项通过(exit 0,3.60s);`pnpm typecheck` exit 0。期间一次并行复跑的旧 tus 重传测试超过默认 5 秒并连带清单断言失败;关闭临时 3471 服务、等待 typecheck 完成后串行复跑通过,未调整测试或超时。最终 `git diff --check` 通过。

## 收口说明（2026-10-15，docs-only）

- 页面 / 侧栏 / 导出按票已交付，`pnpm typecheck` / `pnpm test` 通过；设计期 337/13、543/28 属**当时库**，重建后当时为 170/30、318/37（`acceptance/20261015/evidence/comparison-regression/snapshot-counts.json`），**单条数据纠偏后现行为 553 行差异**（`root-formal-one-row-review/cache-publication-proof.json`）；票面旧数字不追改为终库值。
- **仍未勾项「漂移企业可见且被标注」保持未勾**：真实库 `city` / `reg_status` 全空，只有 fixture 副本证明渲染；不把 fixture 当真实数据证明，也不新增外部信息富化任务。
- 真实3470的**独立 UI 复核**已完成（含 `/files`），桌面1440/窄屏390的双tab双方向、553条解释与tooltip展开/点外关闭见 `acceptance/20261015/evidence/ui-files-final/independent-ui-final.md`。父复看发现窄屏tooltip右端裁切后，以固定 `26ac85a` 局部修复并另起独立定点代码/UI复验，见 `acceptance/20261015/tooltip-width-fix/independent-review.md`。当前样式以该报告为准；旧报告未识别此裁切，不以页面scrollWidth=0替代portal边界测量。
