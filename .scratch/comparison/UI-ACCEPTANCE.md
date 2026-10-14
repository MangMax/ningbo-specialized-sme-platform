# `/comparison` UI/UX 验收

日期：2026-10-14。结论：**UI/UX 合格**，达到台账、统计、数据质量三页的现有视觉水平。

分支：`feat/comparison-ui-polish`，从 `main` 的 `ba13f23523e2c72d2a67c4f33aa49493b2586823` 切出。
基准：`.scratch/comparison/SPEC.md`、`.scratch/ui-redesign/DESIGN.md`，以及三张同门真实截图。
使用本机 `~/.claude/skills/oil-ui/SKILL.md` 的存量润色与评审流程；未安装 oil-ui-pro，未探索新视觉方向。

北极星：**让经办人先看清两侧差异，再逐条核实**。沿用藏青、蓝灰页面底、白色表面与既有控件语法，企业名是表格主角。

## 逐条结论

| 验收项 | 结论与理由 / 修改 |
| --- | --- |
| 政务藏青、金色只作图形标记 | 过，无需换色。复用现有 token；本页两种称号均为市级，没有人为加国家级金标，也没有金色文字。浅深色与三页基准一致。 |
| 4px 方标、等宽数字 | 过，无需改。真实浏览器读取 Badge 的 `borderRadius=4px`、Table 的 `fontVariantNumeric=tabular-nums`；统代继续使用等宽字体。 |
| 表头吸顶、约 44px 密度 | 改后过。原核实按钮与上下 padding 把普通行撑到 49px；按钮收为 28px、单元格上下 padding 6px，25 条普通行逐条实测均为 44px。`scrollTop=200` 时表头 top 与容器 top 同为 400px。异常徽标或已有备注确有内容时允许增高。 |
| 接口 counts、切 tab / 方向不闪不跳 | 改后过。保留 `placeholderData` 和同一个面板 / 滚动容器；徽标只放数字，至少 3ch，桌面方向触发器固定最小宽度，长计数说明移到表格上方。实际接口四组 counts 为 337/13、543/28，未用当前页行数计数。连续三轮真实操作均通过：容器对象不变、top 不变、scrollTop=40 不变、徽标没有闪成横线、徽标 x 坐标不变。第一和第三轮含被暂停后释放的请求；第二轮走缓存。逐帧采样见 JSON。 |
| 大面积空白的「核实与备注」列是否成立 | 改后过。该列实际还承担逐行核实操作，不能整列隐藏。将宽度从 288px 收到 192px，明确显示「待核实 / 已核实」，备注只在有内容时出现；长备注单行摘要，可悬停看全文或打开编辑。外市、注销和无统代标记并到对应企业名下面，仅存在时显示，不预留空白子行。企业名列从 26% 扩到 36%。 |
| 「显示已核实」及 N / M 文案 | 改后过。默认 `N 条（另 M 条已核实）`；开启后 `N 条（含 M 条已核实）`，M=0 时默认只写 N 条。计数说明集中一处，不塞进两个徽标或重复出现在统计卡。浏览器 fixture 验证 335+2 / 337含2；全部已核实空态提示开启开关查看。 |
| Unicode 码点排序 | 过，无需改。未改 `lib/comparison.ts` 或排序。真实 HTTP 分页读齐四组成员，逐个比较相邻企业名，四组均为 Unicode 顺序；与台账口径一致，未引入拼音排序。 |
| 短、准确的口径说明，无填充小字 | 改后过。保留「按统代比对，不限年份，含入库培育」及「小巨人无经信局名录」，删特指 2021 的冗余；两句按语义整体换行。删统计卡重复的「另 0 条已核实」及与已选称号 tab 重复的 TitleBadge。「另一侧无匹配统代」是判断依据，予以保留。 |
| 150–200ms 咔嗒、减少动效直接到位 | 改后过。按钮 / Tabs 原有 150ms、active 0.97 保留；Switch 根与滑块统一为 150ms；本页出场收为 200ms。为官方 Button / Switch 补减少动效规则。独立临时 Chrome 用 CDP **真实模拟** reduce：Button、Tab、Switch、Thumb 的 transition-property 均为 none，出场 animation-name=none，按住 Switch 的 scale=1。注意 CSS transition-none 可以保留 duration=0.15s，但 property=none，实际没有过渡。 |
| 官方 shadcn-vue 组件 | 过。复用 Tabs、Table、Badge、Button、Switch、Empty、Skeleton、Dialog 等现有官方组件组合；新增 Textarea 用官方 CLI `pnpm dlx shadcn-vue@latest add @shadcn/textarea --yes` 获取。页面及业务核实组件没有原生 `<table>/<input>/<select>`。Textarea 支持完整长备注与换行，Ctrl/⌘+Enter 保留快速保存入口。 |
| 空态、加载态 | 改后过。Empty 从宽表单元格中移出，在当前容器居中，窄屏不会把空态中心藏到屏幕外；区分没有差异和全部已核实。首次加载仍用 Skeleton 与横线计数，不把未知数量写成 0。浅深色均有实截。 |
| 390px 窄视口 | 改后过。两个方向 tab 均在视口内；整页横向溢出为 0，只有宽表在自身容器内滚动。统计卡移动端 padding 从 20px 收到 12px，首条记录从 496px 提前到 480px，不缩小文字。保留宽表模式，与台账一致；不是另造移动端卡片列表。 |

## 评审与复验

先保存修改前截图，依据实际画面修正；完成一轮隔离上下文独立评审（存量润色、不打分，评审者只看规范和截图，不读源码）。评审者实际看了 27 张图，结论「当前画面达到同门三页的视觉完成度，截图范围内合格」，无必须修问题。

评审提出两项提升，均已处理并由主验收者重截：收紧手机统计卡 padding；备注弹窗由单行 Input 改成官方多行 Textarea。保留评审认可的同门配色、固定表格骨架、紧凑核实列与状态文案。动态指标、组件来源和排序由主验收者另验，未以静态截图替代动态证明。最终两主题 × 两称号 × 两方向 × 隐藏/显示，共 16 张组合全部重截；手机、空态、加载态、非零核实数和备注弹窗另截。无视觉评分。

截图使用 T3 collaborative preview；Oil 的 shoot 工具另外完成实际 1x/2x 像素取证。`readability/report.json` 的两项 `issues=[]`、`lint=[]`，无控制台错误、整页横向溢出或图片加载失败。另以 CSS `zoom=2` 观察关键区域，和 2x 像素密度截图分开记录。

### 验证

- `pnpm typecheck`：exit 0。
- `pnpm test`：10 个文件、126 项全过，exit 0；未新增或修改测试。
- `git diff --check`：通过。
- 三轮切换交互检查：第 1 / 2 / 3 轮均通过；完整采样见 `shots/final/interaction-checks.json`，操作录像见 `switching.mp4`。无需处理企业数据即可检查 tab、方向、显示开关、滚动与备注弹窗。
- 减少动效：`node .scratch/comparison/shots/reduced-motion.mjs` exit 0，实测结果见 `reduced-motion.json`。

## 证据与边界

截图根路径：

`/Users/mang/Workfile/宁波/专精特新/20261013/app/.scratch/comparison/shots/`

`before/` 保存修改前 16 组合、mobile、empty/loading 和 `peer-ledger.png` / `peer-stats.png` / `peer-quality.png`。
最终截图全部在 **`final/`**：

- 真实库 16 组合：`{light,dark}-{specialized,innovative}-{missing,extra}-{hidden,shown}.png`。
- `mobile-light.png`：390×844，真实数据。
- `sticky-header.png`：滚动后吸顶表头，真实数据。
- `{light,dark}-loading-fixture.png`：首次请求暂缓，Skeleton 呈现。
- `{light,dark}-empty-fixture.png`、`mobile-empty-fixture.png`：空 API 响应的浏览器替身。
- `{light,dark}-curated-{hidden,shown}-fixture.png`：两个已核实条目、长备注及外市 / 注销标记的浏览器替身。
- `all-curated-empty-fixture.png`：全部已核实但默认隐藏的浏览器替身。
- `note-dialog-fixture.png`：多行备注弹窗，取消退出，未保存。
- `reduced-motion.png` / `reduced-motion.json`：实际 reduce 模拟及计算样式。
- `zoom-200-percent.png`：CSS 200% 缩放截图。
- `readability/page.png` / `page-@2x.png` / `report.json`：真实页面的原尺寸与双像素取证。
- `source-readback.json`：真实库字段缺失计数、四方向 counts、完整名单排序检查。

桌面 CSS 视口 1440×1000；T3 PNG 可能缩到 1280 宽，手机 PNG 为 2x 像素。原尺寸截图另由 shoot 保留。

**真实数据限制仍如实保留**：只读 SQLite 查得 enterprise 7425 家，city / reg_status 非空数均为 0；四组 curatedCounts 均为 0。因此非零核实数、外市 / 注销、空数据和长备注用浏览器内只读响应替身验证呈现，不能宣称真实库已有这些字段或真实标注保存已验。未发送 PATCH，未改 data、schema、pipeline、API 或比对逻辑。UI 合格结论不代替票 03 原有「真实漂移数据」验收边界。

口径说明：鄞州区规划设计院因两来源统代不同而双向出现，是既定数据问题，本次没有在 UI 或比对逻辑中特判。

全部截图、录像和临时验证脚本位于已忽略的 shots 目录，不入提交。提交仅包含本页、核实组件、Button/Switch 的动效呈现调整、官方 Textarea 和本验收记录。

## 补记：验收后的缺陷与根因（2026-10-14，用户实测发现）

**上文「合格」结论漏掉了亮色主题下 Tabs 选中态与背景难以区分的问题。** 用户实测发现，判定为验收不充分。

**根因是主题 token，不是 Tabs 本身。** 本主题把 `--background` 设成了**页面底**（`#EFF3F9`），而 shadcn 的组件把 `bg-background` 当作**抬起的表面**用 —— Tabs 选中态、`Dialog`/`Sheet`、`outline` 按钮、`Switch` 滑块都是。于是这些表面渲染成了页面底色：

- 亮色下 Tabs 选中态 = `#EFF3F9`，轨道 `--muted` = `#F1F4F8` —— ΔL 仅 **0.003**，几乎不可见；
- 暗色下因为 Tabs 另有 `dark:` 覆盖，所以只有亮色暴露了这个问题（用户看到的正是亮色）。

**修法（把两个 token 的语义分开，并给轨道一个真正的下沉面）：**

1. `--page` 立为**页面底**（亮 `#EFF3F9` / 暗 `#0A1020`），`body` 与 `SidebarInset`（内容区）改用它；
2. `--background` 还原为**抬起的表面**（亮 = 卡片白，暗 = 卡片 `#111A2C`）。所有 `bg-background` 的抬起面随之正确 —— 实测 `Dialog` 背景从 `#EFF3F9` 变为 `oklch(1 0 0)`（纯白）；
3. `SidebarInput` → `bg-page`，`TooltipContent` → `text-page`（保持原观感）；
4. Tabs 轨道 `bg-muted` → `bg-accent`（亮 `#E8EFF9` / 暗 `#232F45`，给控件一个真实的蓝灰下沉面），选中态白底 + 阴影、未选中 `text-muted-foreground`。

**复验**：亮 / 暗两主题逐页看（台账、统计、数据质量、比对），实测计算样式确认页面底、抬起面与轨道三档分离；126 测试与 typecheck 全绿。

**教训**：只在**新建页面**上做视觉验收会漏掉**全局 token** 的问题 —— 该缺陷同页三兄弟（台账 / 统计 / 质量）同样受影响，只是那三页恰好没用到 Tabs。以后改视觉 token 必须**四页一起看**。
