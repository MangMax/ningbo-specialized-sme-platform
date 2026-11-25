# 设计规范

本文件把项目的 UI 约定固化成可检查的条目。规则的出处是共享组件、业务页面和样式文件 `layers/core/app/assets/css/tailwind.css`；设计变量的结构化镜像是 `layers/core/lib/design-tokens.ts`，开发态可视化预览在 `/design-tokens`（只在 `import.meta.dev` 下可访问，不进生产路由）。改设计先改这里，再改代码；三处（样式表 / 目录 / 本文）必须一致。

## 1. Design Tokens（12 类速查表）

色板采用「中性办公灰 + 清透商务蓝 + 12 通用强调色相」（对齐 LobeUI 体系），所有颜色都通过 `layers/core/app/assets/css/tailwind.css` 里的 CSS 变量引用，页面与组件不写死色值。

除特别注明外，颜色 token 都在 `:root` 与 `.dark` 双色板成对定义；同一变量名在明暗主题下自动切换，组件不按主题分支。`--shadow-*`、`--z-*`、`--duration-*`、`--table-*`、`--control-*`、`--drawer-width-*` 由 `@theme`（层级/尺寸/时长三组为 `@theme static`，保证变量实体落到 `:root`）声明。

### 1.1 Surface 表面

| token | 角色 | 用法 |
| --- | --- | --- |
| `--page` (`bg-page`) | **页面底**：body 与内容区的下沉面，带一点蓝 | 只用于页面/工作台的最底层背景（`body`、`SidebarInset`、`OcrWorkbench` 根） |
| `--background` (`bg-background`) | **抬起的表面**：与卡片同档的纯白/深色 | shadcn 组件把它当抬起面用：Tabs 选中态、Dialog/Sheet、outline 按钮、Switch 滑块 |
| `--card` (`bg-card`) | 卡片表面 | `Card` / `SectionCard` / `DataTableCard` |
| `--popover` / `--popover-foreground` | 浮层表面与浮层文字 | 下拉、弹出层、日期面板、toast |
| `--sidebar` / `--sidebar-accent` | 侧栏表面与侧栏悬停面 | 只给侧栏，内容区不用 |
| `--surface-sunken` (`bg-surface-sunken`) | 内嵌下沉面 | 卡片内嵌套画布、代码片段或预览底 |
| `--mask` (`bg-mask`) | 遮罩层（Scrim） | 模态弹窗与抽屉背后的半透明压暗层 |

- 不许把 `--background` 设成页面底色：一旦同色，Tabs 选中态、Dialog、Switch 会和页面糊在一起（亮色下尤其明显）。页面底永远用 `--page`。
- 层级靠色相偏移区分，不只靠明暗：页面底带蓝相，卡片纯白。

#### 1.1.1 业务区域与页面底

- **业务控件须有承载面（用户确认）**：从属于同一任务的筛选、业务按钮、结果和状态提示放进同一个承载区域。页面内用 `Card`，浮层用 `DialogContent`、`SheetContent` 或 `PopoverContent`。布局外壳、导航和页面标题沿用各自的共享组件。
- 筛选、列表或表格、空态和失败重试属于同一流程时，放在同一个承载面里，按内容和操作分区。一组控件共用边界。（Agent 推断）

### 1.2 Text 文字

| token | 角色 | 对比度基线 |
| --- | --- | --- |
| `--foreground` (`text-foreground`) | 正文与标题 | 对 `--page`/`--card` 远高于 7:1 |
| `--muted-foreground` (`text-muted-foreground`) | 说明、表头、元信息 | 亮色对页面底约 5.05:1；暗色对卡片约 6.1:1 |
| `--text-tertiary` / `--text-quaternary` | 占位/弱提示、禁用态文字 | 不承载正文或唯一关键信息 |
| `--card-foreground` / `--popover-foreground` | 卡片 / 浮层内正文 | 与各自表面成对 |
| `--primary-foreground` 等实心面文字 | 叠在对应实心色上 | 只叠在自己的实心底上，不跨用 |
| `--sidebar-foreground` | 侧栏文字 | 只给侧栏 |

- **对比度基线**：正文、标签与可操作的次要文字在明暗两套色板上都不低于 **4.5:1**；`--muted-foreground` 是允许的最低档，不要用它承载唯一的关键信息。
- **高明度色相不直接写正文**：`--hue-yellow` / `--hue-gold` / `--hue-lime` 在浅底上对比度不足，不得直接用作正文文字色。
- 表格与 `.tabular` 容器一律 `font-variant-numeric: tabular-nums`：标识码与计数纵向对齐。
- h1–h3/p 开 `text-wrap: pretty`，中文标点能撑开行高。

### 1.3 Border 描边

| token | 角色 | 用法 |
| --- | --- | --- |
| `--border` (`border-border`) | 通用分隔线与卡片描边 | 卡片外框、主分隔线、section 边界 |
| `--border-secondary` (`border-border-secondary`) | 轻分隔线 | 表格内部网格、卡片内弱分组线 |
| `--input` (`border-input`) | 输入控件默认描边 | Input / SelectTrigger / Textarea 未聚焦时 |
| `--ring` (`ring-ring`) | 焦点环 | **复用主色**，不单独配色 |
| `--sidebar-border` / `--sidebar-ring` | 侧栏边界与焦点环 | 只给侧栏控件 |

### 1.4 Fill 填充

| token | 角色 | 用法 |
| --- | --- | --- |
| `--muted` (`bg-muted`) | 最轻的中性填充 | 表头底、骨架屏、行悬停、占位块 |
| `--accent` (`bg-accent`) | 悬停/选中面，比 muted 带一点蓝 | ghost 按钮悬停、菜单高亮、已生效筛选按钮底 |
| `--secondary` (`bg-secondary`) | 次级按钮/标签实心面 | 与 `--secondary-foreground` 成对 |
| `--sidebar-accent` | 侧栏项悬停/选中面 | 只给侧栏 |

填充面不承载语义：状态与业务含义走 Status / Domain Accents，不要用填充色「暗示」状态。

### 1.5 Shadow & Z-Index 阴影与层级

卡片默认不投影，层级靠表面色与描边区分；只有浮层投影。投影颜色一律由主题 token 经 `color-mix` 派生：亮色从 `--foreground` 混出，暗色从 `--page` 向黑混合——浅色前景在暗底上会读成「光晕」而不是影子。

| token | 亮色 | 暗色 | 用法 |
| --- | --- | --- | --- |
| `--shadow-card` | `none` | `none` | 卡片不投影；需要浮起时改用下面两档 |
| `--shadow-popover` | `0 4px 16px color-mix(… --foreground 10% …)` | `0 4px 20px color-mix(… --page 20%, black)` | 下拉、弹出层、日期面板、toast |
| `--shadow-drawer` | `0 8px 24px color-mix(… --foreground 16% …)` | `0 8px 28px color-mix(… --page 15%, black)` | 业务侧抽屉；`[data-floating-drawer]` 经 `--drawer-shadow` 引用，三档宽度共用 |

**Z-Index 阶梯**（`@theme`）：按语义选档，不在页面里写数字，也不和相邻元素比大小。

| token | 值 | 归属 |
| --- | --- | --- |
| `--z-sticky-cell` | 10 | 横向滚动固定的表格操作列单元格 |
| `--z-sticky-head` | 20 | 吸顶表头 / 固定操作列表头 |
| `--z-header` | 30 | 应用顶栏 |
| `--z-drawer` | 40 | 抽屉浮层 |
| `--z-modal` | 50 | 模态弹窗与命令面板（全站最高层） |

### 1.6 Primary & Link 主色与链接

| token | 角色 | 限制 |
| --- | --- | --- |
| `--primary` (`bg-primary`, `text-primary`) | 藏青。导航、主操作、链接、市级来源、称号高等级 | **主色只有一个**，不另造「第二主色」 |
| `--sidebar-primary` | 侧栏内的主色（当前项、侧栏主按钮） | 只用于侧栏，与页面主色同源 |
| `--primary-foreground` | 主色实心面上的文字/图标 | 只叠在 `--primary` 上 |

- 链接一律复用 `--primary` + `underline-offset-4`（`link` 按钮变体），不加第三种颜色。
- 一个界面只允许一个实心主色按钮承担主操作。

### 1.7 Status 状态

四态 × 四档完整矩阵（`Base / Bg / Bg-Hover / Border`），亮暗双色板成对定义：

| 状态 | 主色 / 软底 / 悬停底 / 浅描边 | 角色与限制 |
| --- | --- | --- |
| Success | `--success` / `--success-bg` / `--success-bg-hover` / `--success-border` | 成功：已完成、已保存、校验通过；只做反馈，不做装饰色 |
| Info | `--info` / `--info-bg` / `--info-bg-hover` / `--info-border` | 信息与进行中（与政务藏青主色同源） |
| Warning | `--warning` / `--warning-bg` / `--warning-bg-hover` / `--warning-border` | 提醒：需要留意但不阻断；不替代错误 |
| Destructive | `--destructive` / `--destructive-bg` / `--destructive-bg-hover` / `--destructive-border` | 点睛红：**只用于操作失败或异常告警**；深色文字对卡片约 5.3:1 |

- 状态标签与横幅优先直接消费 `--{status}-bg` + `--{status}-border` + `--{status}` 组合，浅色和深色主题中的正文对比度至少为 4.5:1。

### 1.8 Hue & Domain Accents 通用色相与领域色

对齐 LobeUI 的通用色相体系，提供 **12 组通用强调色相**（`--hue-red` / `volcano` / `orange` / `gold` / `yellow` / `lime` / `green` / `cyan` / `blue` / `geekblue` / `purple` / `magenta`），用于标签、头像、图表系列、分类标记与语法高亮，亮暗双色板成对定义。

在此之上，业务称号梯度与来源标记保持语义别名（不硬编码色值，避免破坏现有组件）：

- `tier-1` 小巨人：深邃靛紫实心底（`--tier-1-surface` / `--tier-1-on`）；`tier-2` 专精特新中小企业：清透商务蓝浅底描边；`tier-3` 创新型中小企业：清翠绿浅底描边。
- 梯度只经 `Badge` 的 `tier-1`、`tier-2`、`tier-3` 变体（`layers/core/app/components/ui/badge/index.ts`）落到界面，页面不直接拼 `bg-tier-*`。
- `--mark-national`（靛紫）与 `--mark-municipal`（商务蓝）仅用于 6px 来源/等级图形标记。

### 1.9 Radius 圆角

| token | 值 | 落到界面 |
| --- | --- | --- |
| `--radius` | 0.375rem（6px） | 基准；`rounded-sm/md/lg/xl` 由它派生 |
| `rounded-sm` | 4px | 徽章、标签、小方块 |
| `rounded-md` | 6px | 按钮、输入、选择器 |
| `rounded-lg` | 8px | 小卡片 |
| `rounded-xl` | 12px | 抽屉、大方块 |

徽章用 `rounded-sm` 方标，不用全圆胶囊——全圆胶囊是消费级 App 的语言，政务台账用方标，和侧栏、表格的直角节奏一致。

### 1.10 Typography 排版

五档字号阶梯。档位是固定的，页面不自定义字号，也不劫持表格字号。

| 档位 | 字号 / 行高 | 类 | 用途 |
| --- | --- | --- | --- |
| 页标题 | 20px / tight | `text-xl font-semibold tracking-tight` | `PageHeader` 的 h1 |
| 分区标题 | 16px / tight | `text-base font-semibold` | `SectionCard` / 小标题 |
| 正文 | 14px | `text-sm` | 说明、表单、正文 |
| 表体 | 13px / 20px | `text-table`（`--text-table`） | `.data-table` 与表体 |
| 元信息 | 12px | `text-xs` | 时间、批次、辅助说明 |
| 等宽数字/代码 | 继承字号 | `tabular-nums`、`font-mono` | 信用代码、计数、变量名 |
| OCR 专用 | 15px / 1.65；代码 14px | `--ocr-prose-size` / `--ocr-prose-leading` / `--ocr-code-size` | 只被 `.ocr-workbench` 显式引用，普通页面不得复用（两处均 >=14px，窄屏不落到 12/13px） |

- 表格与 `.tabular` 容器一律 `font-variant-numeric: tabular-nums`。
- 中文标点开 `text-wrap: pretty`。

### 1.11 Motion 动效

对齐 LobeUI 动效体系：3 条贝塞尔缓动 + 3 条归一化到 settle time 的 CSS `linear()` 弹簧曲线 + 3 档时长（`--ease-snap` 作为 `--motion-ease-out` 的兼容别名，经 Tailwind 暴露为 `ease-snap`）。

| token | 值 | 用途 |
| --- | --- | --- |
| `--motion-ease-out` / `--ease-snap` | `cubic-bezier(0.215, 0.61, 0.355, 1)` | 入场、悬停反馈与默认过渡 |
| `--motion-ease-in-out` | `cubic-bezier(0.645, 0.045, 0.355, 1)` | 两个静止态之间的平滑切换 |
| `--motion-ease-in-out-circ` | `cubic-bezier(0.78, 0.14, 0.15, 0.86)` | 长距离或强调型位移 |
| `--motion-spring-smooth` | `linear(...)`（ζ 1.0 · 过冲 0%） | 无过冲自然到位 |
| `--motion-spring-snappy` | `linear(...)`（ζ 0.8 · 过冲 1.5%） | Toast 与浮动面板入场 |
| `--motion-spring-bouncy` | `linear(...)`（ζ 0.7 · 过冲 4.6%） | Tooltip 与轻量 Popover 弹出 |
| `--duration-fast` | 100ms（0.1s） | 悬停、撤掉与微交互 |
| `--duration-mid` | 200ms（0.2s） | 控件状态、浮层、页转场与抽屉默认时长 |
| `--duration-slow` | 300ms（0.3s） | 大面积抽屉展开、模态框与弹簧 settle 动效 |

- **CSS 与 `motion-v` 的边界**：能用 CSS `transition` 表达的状态变化（颜色、背景、透明度、单轴位移）一律用 CSS 缓动/弹簧变量。只有需要在挂载/卸载之间编排、或必须读取 `useReducedMotion()` 的组件内动效（如 `TabsContent` 的面板切换）才用 `motion-v`，其 `ease` 必须写成与 `--motion-ease-out` / `--ease-snap` 相同的 `[0.215, 0.61, 0.355, 1]`。
- **禁动区**：表格行内容、表单输入值、OCR 校对正文不做位移与缩放；这些区域只允许颜色/背景的短过渡，避免阅读时视线被打断。
- **`prefers-reduced-motion`**：所有过渡与动画关闭——新增动效必须带 `motion-reduce:` 回退；纯 CSS 动画在 `@media (prefers-reduced-motion: reduce)` 里置 `none`。

### 1.12 Layout & Density 布局与密度

| token | 值 | 用途 |
| --- | --- | --- |
| `--table-header-h` | 36px | 表头高 |
| `--table-row-min-h` | 44px | 表格正文行最小高（多行自动撑高） |
| `--table-row-compact-h` | 36px | 紧凑表行高（仅弹窗核对表） |
| `--control-toolbar-h` | 32px | 列表工具栏控件高（`h-8` / `size="sm"`） |
| `--control-form-h` | 36px | 表单、弹窗、抽屉内控件高（`h-9`） |
| `--drawer-width-compact` | 360px | `floatingSize="compact"` |
| `--drawer-width-standard` | 448px | `floatingSize="standard"`（默认） |
| `--drawer-width-detail` | 560px | `floatingSize="detail"` |
| `--table-budget` | 17rem | 列表页纵向滚动预算（`calc(100dvh - var(--table-budget))`） |

- 间距刻度沿用 Tailwind 的 4px 基数：卡片内 `p-4`、工具栏 `p-3 sm:px-4`、分区之间 `gap-3`~`gap-4`。
- 组件层的 `.data-table` 规则仍写 36px/44px 字面量（要能被 utilities 覆盖、契约测试按字面量断言），数值必须与上表一致；改一项就同时改两边。

## 2. 布局与页面骨架规范

### 2.1 统一建页骨架

新页面按下面三种骨架组合，不再逐页拼页头、筛选栏、结果卡和分页：

| 骨架 | 用途 | 结构 |
| --- | --- | --- |
| `WorkspacePage` | 列表页 / 详情页外壳 | `mode="viewport"`（默认）占满外壳剩余高度、主体内部滚动；`mode="scroll"` 跟随文档滚动。内置 `PageHeader`，透传 `breadcrumb` / `description` / `actions`。 |
| `DataTableCard` | 列表结果卡 | 工具栏（`.table-toolbar`）+ 正文（`.paginated-table-body`）+ `footer`（放 `TablePagination` 的 `in-card`，始终在滚动区外）。有 `sidebar` 插槽时宽屏为「目录栏 \| 结果卡」双栏。 |
| `SectionCard` | 详情 / 配置 / 任务分组 | 标题 + 说明 + `actions`，正文默认 `p-4`（`padded=false` 可关）。 |

- 详情抽屉统一用 `DetailDrawer`（固定头部、独立滚动主体、可选固定底栏），只选 `floatingSize` 档位，不另写宽度和滚动结构。
- 业务模态弹窗统一用 `ModalDialog`（固定头部 + 标题行垂直居中关闭按钮 + 独立滚动主体 + 可选固定底栏），只选 `size` 档位（`sm`/`md`/`lg`/`xl`），不直接拼裸 `DialogContent`。全屏媒体预览（PDF/文件/OCR 对比）除外。

### 2.2 工作台规则

- 工作台使用 shadcn-vue 与 Tailwind 语义样式。页面由 `PageHeader` 和 `Card` 承载，表格使用 `.data-table`，按需组合分页、抽屉和 `Badge`。默认工作区随侧栏之外的可用宽度伸缩，保留统一页边距。应用外壳固定为视口高度，顶栏与侧栏保持在原位。列表在实际剩余高度内滚动其结果区，页头、筛选和分页留在区外。长表单和详情滚动各自的内容区。高级筛选展开后超出可用高度时，筛选表单在区内滚动，保留结果区和分页。
- 平台首页直接进入「历年优质中小企业」。侧栏展示业务页面和平台管理入口。
- 平台「文件管理」显示通用文件信息，并提供上传、预览和维护。公布信息、内容分段、分类、解析和业务引用归属优质中小企业的「名单文件」页。两个入口使用同一个文件 ID 和原件。
- 「企业基础库」是侧栏业务区的独立入口，与业务模块并列。列表以企业名称为主信息。名称和完整信用代码可快速查询，七个业务字段在列表操作栏内展开筛选和排序，内容超高时在展开区内滚动。排序按优先级逐级比较。点未排序的表头追加为末级，点已排序的表头切换方向；排序面板用上移、下移调整优先级。固定表头和最右侧「查看资料」入口。窄屏在表格内横向查看各列，并将信用代码和区县并入企业名称下方供快速浏览。资料和入库来源共用一个抽屉。区划和行业各使用单个级联选择器，按区县进入乡镇、按行业大类进入明细。筛选可停在上一级，维护资料时行业须选到明细，注册地址和经营地址各录一条。抽屉关闭后回到原行。
- 可持续增多的字典采用可搜索的分组目录，详情支持链接直达。宽屏目录和详情并排，窄屏逐级打开，返回时保留目录搜索并恢复焦点。标准字典按实际页头和分页高度预留表格滚动空间，翻页从新页首行开始。

### 2.3 工具栏与筛选

- 列表工具栏统一使用 `table-toolbar`，放在结果卡顶部。左侧放搜索、筛选和视图选择，右侧放当前列表的刷新、导出或上传。窄屏换行时各操作仍在同一卡内。行操作紧随对应记录，表格横向滚动时可固定行操作列。
- 尺寸：列表工具栏控件统一 **32px（h-8）+ 12px 字号（`text-xs`，对齐 LobeUI `fontSizeSM`）+ 14px 图标（`size-3.5`）**——`Input size="sm"`、`SelectTrigger size="sm"`、`SingleSelectFilter`、`MultiSelectFilter`、`Button size="sm"`。搜索框、单值筛选、多值筛选、刷新/导出在同一行时等高且不压过 13px 表格正文。
- 表单、弹窗、抽屉内常规控件统一 **36px（h-9）+ 13px 字号（`text-table`）**（`Input` / `SelectTrigger` / `Button` / `Textarea` 默认档）；菜单项（`SelectItem` / `DropdownMenuItem`）、标签页（`TabsTrigger`）、表单标签（`Label`）与侧栏导航（`SidebarMenuButton`）同样统一 **13px（`text-table`）**。
- 筛选控件：单值用 `SingleSelectFilter`（内部是共享 `Select`）、多值用 `MultiSelectFilter`，**不写原生 `<select>`**；「不筛选」用哨兵值 `all`，由调用方翻译成「无该条件」。
- 已生效条件统一走 `ActiveFilterBar`：每项一个 `FilterChip`，文案固定「键：值」，每项可单独撤掉；生效条件达到阈值时右侧出现统一的 ghost「清除筛选」，不在各页另写清除按钮。必须包含「没有常驻控件」的静默筛选（如下钻带来的 source/event/rosterState）。

### 2.4 分页与滚动

- 分页紧接表格，放在同一张 Card 的底部，使用共享 `TablePagination` 的 `in-card` 样式。表体独立滚动时，分页在滚动区外。`workspace-list` 使用工作区的实际剩余高度。筛选栏和分页保持可见，`paginated-table-body` 内的列表承担滚动。企业分页统一写「每页 X 家　共 XXX 家」，文件、日志等列表保留其业务单位。接口提供总数时显示可点击页码并标记当前页。数量信息在左，页码和翻页按钮在右，优先同行。按分页栏自身宽度缩减翻页文案和可见页码。数量和导航只有在实际放不下时才换行，导航内部保持单行。
- 取数：换条件留住上一批行（`placeholderData: previous`）；失败用 `TableFailureState`，成功结果保留并给显式重试。

### 2.5 表格

- 表格：统一 `.data-table` 外壳——13px/20px 字距、吸顶表头 `--table-line`、`muted` 底表头；`TableHeader` 统一吸顶，表头背景不透出滚动中的行。横向和纵向滚动共享 `.data-table-scroll`，内层 Table 包装不另起滚动。`workspace-list` 内由布局分配实际剩余高度，独立表格沿用 `--table-budget` 的视口预算。
- 尺寸：表头高 36px、左右内边距 12px；正文行最小高 44px（`tr` 的 `height` 在表格里等同最小行高，多行自动撑高），`td` 默认 `py-2.5 px-3`。紧凑档 `data-density="compact"`（行 36px、`py-1.5`）只给弹窗内的小型核对表显式使用，列表页不用。
- 表格默认值写在 `@layer components` 的 `.data-table` 规则里，`p-0` / `py-*` 工具类可以覆盖（空态、骨架屏、紧凑小表）；基础组件的默认工具类与之一致，两边不打架。
- 横向滚动固定的操作列统一用 `.table-sticky-action-head` / `.table-sticky-action-cell`：表头 `muted` 底，表体 `card` 底，行悬停时固定列同步换成行底色，避免「断开」。层级引用 `--z-sticky-head` / `--z-sticky-cell`；过渡 150ms `--ease-snap`，减少动效时关闭。
- 业务页面不得用 `:deep(.text-xs)` 之类选择器劫持表格字号/行高；需要紧凑就显式用 `data-density` 或覆盖内边距工具类。
- **`min-w` 按列推导，不逐页拍**：`table-fixed` 表的最小宽度由各列内容下限之和决定。
  - 逐列写 `w-*` 像素列的表，`min-w` = 各列像素之和（如 files：12 列求和得 1154px，多写少写都会与列宽脱节）。
  - 百分比/弹性列的表，`min-w` 取「每列刚好放得下其不可再窄内容」的总宽——最长不可断字段、徽章、操作按钮的下限之和（logs 940、current-enterprises 850）。
  - 宽屏再加宽的表用响应式 `min-w`（`lg:min-w-[980px]`、`2xl:min-w-[1080px]`），规则相同；窄屏没有列宽下限时用 `min-w-0` 让内容铺开（EnterpriseListTable）。

### 2.6 抽屉

- 抽屉：业务侧抽屉经 `[data-floating-drawer]` 显式 opt-in（`EnterpriseDrawer` 用 `data-floating-drawer="detail"` + `data-drawer-side="right"`）。宽度档位：`compact` 360px / 默认 448px / `detail` 560px（引用 `--drawer-width-*`），含 8px（sm 以上 16px）视口 gutter 与宽度上限，消费者宽度类不能绕过。三档共用 `--shadow-drawer`。导航与顶/底 sheet 不挂这个属性。

### 2.7 弹窗与表单布局

- 业务模态弹窗统一用 `ModalDialog`（与 `DetailDrawer` 对称：固定头部、标题行右侧垂直居中关闭按钮、独立滚动主体、可选固定底栏，`size` 取 `sm`/`md`/`lg`/`xl`），不得在业务组件里直接拼裸 `DialogContent`。表单用 `FieldGroup` / `Field`，弹窗内控件保持 36px。
- **按钮顺序固定：取消在左、主操作在右**；主操作只在右侧出现一次。不可中断的提交状态用 `preventClose` / 禁用取消，而不是把主操作挪到左边。
- 表单校验信息紧贴对应字段，不出全局横幅；提交失败保留已填写内容并给出显式重试。

### 2.8 窄屏（390px）列表选型

在 390px 宽下按「信息能不能靠首列读完」选形态，不逐页拍脑袋：

- **把辅助字段折进首列**：记录只有一个主标识（企业名称）加少量辅助字段（信用代码、区县）时，表格保持横向可读，辅助字段折到首列下方（`EnterpriseListTable` 的做法）。
- **切卡片**：每行有 3 个以上并列业务字段、且这些字段必须同时看到才能判断时，窄屏改用卡片（`data-testid$="-card"` 模式），宽屏仍用表格。
- **保留表格 + 横向滚动**：列多且需要横向对比数值/状态（名单文件、日志、平台查询）时，保留表格并在 `.data-table-scroll` 内横向滚动，固定最右侧操作列，首列不折叠。

### 2.9 空态 / 加载 / 分页统一原则

- 空态用共享 `Empty`，文案写「这一页为什么空」；有筛选条件时提供「清除筛选」，没有条件时提示下一步。
- 加载中保留骨架/进度（`TableLoadingStatus`）或占位高度，不提前渲染空态；请求失败保留上次成功结果，用 `TableFailureState` 的 `@retry` 给显式重试。
- 分页始终在滚动区外；数量单位跟业务走（家 / 条 / 个文件），不为统一而改单位。

## 3. 可用组件（复用，不另造）

| 组件 | 用途 | 要点 |
| --- | --- | --- |
| `layers/core/app/components/PageHeader.vue` | 页头：标题 + 一行说明 + 右侧 `actions` 插槽 | `description` 只写「这一页回答什么问题」，不写凑数介绍 |
| `WorkspacePage.vue` / `DataTableCard.vue` / `SectionCard.vue` | 列表页与详情页的建页骨架 | 见 §2.1；列表页正文用 `.data-table-scroll`，分页放 `DataTableCard` 的 `footer` |
| `DetailDrawer.vue` | 业务侧详情抽屉 | 固定头部 + 独立滚动主体 + 可选 `footer`；宽度只选 `floatingSize`，`preventClose` 用于不可中断状态 |
| `ModalDialog.vue` | 业务模态弹窗 | 固定头部（关闭按钮居中）+ 独立滚动主体 + 可选 `footer`；宽度只选 `size`（`sm`/`md`/`lg`/`xl`），`preventClose` 用于不可中断状态 |
| `ActiveFilterBar.vue` / `SingleSelectFilter.vue` | 已生效条件条 / 单值筛选 | chip 文案「键：值」；单值筛选与 `MultiSelectFilter` 成对，`all` 哨兵表示不筛选 |
| `layers/sme-roster/app/components/EnterpriseDrawer.vue` + `[data-floating-drawer]` | 企业详情侧抽屉，非模态 | 开抽屉不变暗、不锁表格；`back-query` 保筛选上下文 |
| `layers/core/app/components/FilterChip.vue` | 已生效筛选的可撤 chip | 一个 chip 一个条件，`remove` 即清 |
| `layers/core/app/components/MultiSelectFilter.vue` | 多值筛选 | 与 `Select`（单值）分工，无原生 select |
| `layers/core/app/components/DatePicker.vue` / `layers/core/app/components/DateTimePicker.vue` | 只选日期 / 选日期和时间 | 复用共享 Calendar 与 Popover。点击标题中的年、月，在同一个浮层内切换年份网格、月份网格和日历。浏览年月只定位日历，选择具体日期才更新值。视图切换用 `ease-snap` 的短过渡，并支持减少动态效果。 |
| 领域徽标：`TitleBadge` / `SourceChip` / `EventChip` | 称号梯度、来源级别、事件类型 | 全经 `Badge` 变体渲染；小巨人靛紫实心、专精特新商务蓝浅底、创新型清翠绿浅底 |
| 表格配套：`TablePagination` / `TableLoadingStatus` / `TableFailureState` / `TableHoverCardContent` / `EnterpriseListTable` | 分页、顶部进度、失败重试、悬停详情、台账表 | 失败保留上次成功数据 + 显式 retry |
| `layers/core/app/components/ui/*` | shadcn-vue 基础件（Button/Card/Select/Badge/Sheet/Tabs…） | `components.json` 管理；徽章只有 `Badge` 一种标签语法 |
| 图标：`@lucide/vue` | 全站唯一图标入口 | 具名导入（如 `import { X } from '@lucide/vue'`），尺寸用 `size-*` 类，装饰性图标加 `aria-hidden` |

## 4. 不要做（可逐条检查）

1. **高明度强调色不直接写正文**：`--hue-yellow` / `--hue-gold` / `--hue-lime` 与来源标记 `--mark-*` 只用于图形/标签背景，不得直接用作浅底正文文字色。
2. **不给组件另造颜色变量**：新需求在既有语义 token（表面/primary/tier/mark/chart/feedback）里选；确需新增必须双色板（`:root` + `.dark`）成对定义并登记进 `@theme inline` / `design-tokens.ts`。
3. **预览换肤只准 `.preview-*` 作用域**：预览内容区的主题覆写（如 `.preview-dark`）只能挂在 `.preview-*` 类下改局部 token，不得改全局 `:root`/`.dark` 或泄漏到页面其余部分。
4. **`--background` 不当页面底**：页面底层背景用 `--page`/`bg-page`；`bg-background` 只给抬起表面（见 1.1）。
5. **业务页面复用组件（用户确认）**：按钮、输入、选择、日历、表格、分页、弹窗和开关优先复用 `layers/core/app/components/ui/` 的 shadcn-vue 组件或现有共享组件。业务组件负责组合、布局和数据，不直接写原生可见控件，也不用 `div` / `span` 加交互角色模拟已有控件。单值选项用 `Select`，多值用 `MultiSelectFilter`，日期用共享日期选择器，表单用 `FieldGroup` / `Field`。选择本机文件时，使用共享 `Button` 触发隐藏的 `Input type="file"`；`form`、`section`、`ul`、`dl` 等语义结构用于组织内容。
6. **解释性小字不进页面**：页面上不放口径说明段落；说明进 `description`、tooltip 或页脚既有位置。
7. **动效必须有 `motion-reduce:` 回退**；新过渡用 `--motion-ease-out`（`ease-snap`）与三档时长（100/200/300ms）之一，`motion-v` 的 `ease` 也必须是 `[0.215, 0.61, 0.355, 1]`。
8. **业务详情围绕业务事实**：优先展示事项、结论、日期、批次和可核对的来源。原始字段码、数据库主键、后台采集时间和执行细节放在对应的运维或原始证据入口。
9. **不在页面里写层级/尺寸数字**：`z-index` 选 `--z-*` 档位；行高、控件高、抽屉宽度选 §1.12 的 token，不写 10/20/32/36/44/448 这类裸数字。
10. **不经 token 的阴影不算数**：浮层阴影只用 `--shadow-popover` / `--shadow-drawer`；不得写 `rgb(0 0 0 / .1)` 或自带第二套投影。

## 5. 验证约定

- 改 UI 后桌面与 390px 两处验证受影响交互。
- 交付前在源码核对基础组件出处，在实际浏览器核对业务控件与对应内容位于同一承载面。覆盖有数据、空态，以及本次受影响的弹窗和失败状态。（Agent 推断）
- 业务入口使用用户理解的动作名称。线索名单入口叫「新增名单」，末步叫「保存名单」。平台自动化接口的凭据不进入新增名单表单。（用户确认）
- 线索名单补充可直接切换「关联已有企业」和「新增企业」。保存时明确提交基础库资料，保留原名单行。页面无需手填令牌、核对人或核对依据。企业基础库以业务来源为主标题，系列、日期及可用的原文件放在其下。
- 线索名单默认展示目录。宽屏通过可搜索、独立滚动的侧栏按类型或来源浏览，窄屏用筛选抽屉承载同一目录。顶栏保留系列筛选、已生效的条件和新增入口，目录逐行标明类型和来源，从详情返回时保留筛选和页码。
- 新增名单按原件与资料、名单预览、确认名单组织。长文件名在有界的搜索结果内换行，目录仅用于区分文件。名单可以用工作簿导入或从表格粘贴，确认前显示解析结果，提交失败时保留已填写资料。
- 后续请求失败时保留已成功结果，并给出显式重试（`TableFailureState` 的 `@retry` 模式）。
