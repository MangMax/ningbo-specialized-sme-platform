# 设计规范

本文件把项目的 UI 约定固化成可检查的条目。规则的出处是代码本身：`assets/css/tailwind.css`、`assets/css/statistics.css`、`components/`、`pages/`。改设计先改这里，再改代码。

## 1. 色板来源与语义角色

色板取自仓库自带的「政企汇报风格包」：政务藏青蓝 + 金色点睛 + 点睛红，与线下汇报材料同源。所有颜色都通过 `assets/css/tailwind.css` 里的 CSS 变量引用，页面与组件不写死色值。

### 1.1 表面层级：`--page` 与 `--background` 是两个 token

| token | 角色 | 用法 |
| --- | --- | --- |
| `--page` (`bg-page`) | **页面底**：body 与内容区的下沉面，带一点蓝 | 只用于页面/工作台的最底层背景（`body`、`SidebarInset`、`OcrWorkbench` 根） |
| `--background` (`bg-background`) | **抬起的表面**：与卡片同档的纯白/深色 | shadcn 组件把它当抬起面用：Tabs 选中态、Dialog/Sheet、outline 按钮、Switch 滑块 |

- 不许把 `--background` 设成页面底色：一旦同色，Tabs 选中态、Dialog、Switch 会和页面糊在一起（亮色下尤其明显）。页面底永远用 `--page`。
- 层级靠色相偏移区分，不只靠明暗：页面底带蓝相，卡片纯白。

### 1.2 品牌与告警色

| token | 角色 | 限制 |
| --- | --- | --- |
| `--primary` (`bg-primary`, `text-primary`) | 藏青。导航、主操作、市级来源、称号高等级 | 主色只有一个，不另造「第二主色」 |
| `--mark-national` (`bg-mark-national`) | 金色。只表示「国家级」 | **只做 6px 方形图形标记，一律不写金色文字**（白底对比度仅约 2.6:1，不够正文可读门槛）。见 `TitleBadge.vue` 的 `size-1.5` 方块、`SourceChip.vue` 的圆点 |
| `--mark-municipal` | 藏青。市级来源标记 | 与金标成对出现，仅用于来源/等级标记，不挪作主题色 |
| `--destructive` (`text-destructive` 等) | 点睛红。**只出现在真有问题的数据质量告警** | 不做装饰、不做强调色；深色主题下当文字用对卡片约 5.3:1 |
| `--success` / `--warning` | 操作反馈语义色 | 信息复用 `--primary`，错误复用 `--destructive`，不另立 info/error 变量 |
| `--ring` | 焦点环 | 复用主色，不单独配色 |

### 1.3 称号梯度：`--tier-*`

称号等级由高到低是一条色阶，每级三个 token：`--tier-{n}-surface`（底）、`--tier-{n}-on`（字）、`--tier-{n}-line`（边）。

- `tier-1` 小巨人：实心藏青；`tier-2` 专精特新中小企业：藏青浅底描边；`tier-3` 创新型中小企业：中性描边。
- `tier-3` 的 `--tier-3-line` 不能只剩近白底：边界要能在白卡片上读出来。
- 梯度只经 `Badge` 的 `tier-1/2/3` 变体（`components/ui/badge/index.ts`）落到界面，页面不直接拼 `bg-tier-*`。

### 1.4 图表系列：`--chart-1` … `--chart-6`

仅用于图表/进度条等数据可视化系列色（`.stats-bar-track`、`--vc-*` 图表变量），按序取用。不拿 `--chart-*` 当界面装饰色或文字色。

### 1.5 动效：`--ease-snap`

统一控制件手感的缓动 `cubic-bezier(0.32, 0.72, 0, 1)`，经 Tailwind 暴露为 `ease-snap` 工具类。控制件过渡、页转场、`TableLoadingStatus` 进度条都用它；写新过渡优先 `ease-snap`，时长沿用既有档位（100/150/180/200ms）。`prefers-reduced-motion` 下所有过渡与动画关闭——新增动效必须带 `motion-reduce:` 回退。

### 1.6 其他既有 token（简要）

- `--ocr-prose-size` / `--ocr-prose-leading` / `--ocr-code-size`：OCR 校对工作台专用字号，只被 `.ocr-workbench` 显式引用，普通页面不得复用（两处均 >=14px，窄屏不落到 12/13px）。
- 表格与 `.tabular` 容器一律 `font-variant-numeric: tabular-nums`：标识码与计数纵向对齐。
- h1–h3/p 开 `text-wrap: pretty`，中文标点能撑开行高。

## 2. 两个领域，两套规则

| | 工作台 | 汇报看板 |
| --- | --- | --- |
| 样板页 | `pages/index.vue`（企业列表） | `pages/stats.vue`（称号统计） |
| 技术路线 | shadcn-vue 组件 + Tailwind 工具类 + `.data-table` 表格外壳 | `assets/css/statistics.css` 的 `stats-*` 专用类 |
| 结构 | `PageHeader` + 筛选行 + `Card` 包 `.data-table` + `TablePagination` + 抽屉 | `stats-dashboard` > `stats-page-header` + `stats-metric-grid` + `stats-analysis-grid` + `stats-page-footer` |
| 标签 | `Badge` 变体（tier/quiet/dashed/solid） | `stats-metric--{0,1,2}` 卡片直接消费 `--tier-*` token |

**不交叉**：`.stats-*` 类只在看板域（`stats.vue`、`Statistics*` 组件、`StatsDetailSheet`）使用，工作台页面与组件不得引入；反之工作台的 `.data-table` 外壳不进看板。两边共享的只有 tailwind.css 里的语义 token 与 `TablePagination`/`TableFailureState` 这类跨域配套件。

### 2.1 工作台规则

- 筛选控件：单值用 `Select`、多值用 `MultiSelectFilter`，**不写原生 `<select>`**。已生效条件摊成一行 `FilterChip`，每项可单独撤掉，且必须包含「没有常驻控件」的静默筛选（如下钻带来的 source/event/rosterState）。
- 表格：统一 `.data-table` 外壳——13px/20px 字距、吸顶表头 `--table-line`、`muted` 底表头；滚动预算用 `.data-table-scroll`（`max(320px, 100dvh - var(--table-budget))`）。`--table-budget` 是从视口里给页头/筛选行/分页预留的高度 token，定义在 `@theme`；新列表页套 `.data-table-scroll` 即继承同一预算，不照抄数字。
- **`min-w` 按列推导，不逐页拍**：`table-fixed` 表的最小宽度由各列内容下限之和决定。
  - 逐列写 `w-*` 像素列的表，`min-w` = 各列像素之和（如 files：12 列求和得 1154px，多写少写都会与列宽脱节）。
  - 百分比/弹性列的表，`min-w` 取「每列刚好放得下其不可再窄内容」的总宽——最长不可断字段、徽章、操作按钮的下限之和（logs 940、current-enterprises 850）。
  - 宽屏再加宽的表用响应式 `min-w`（`lg:min-w-[980px]`、`2xl:min-w-[1080px]`），规则相同；窄屏没有列宽下限时用 `min-w-0` 让内容铺开（EnterpriseListTable）。
- 取数：换条件留住上一批行（`placeholderData: previous`）；失败用 `TableFailureState`，成功结果保留并给显式重试。
- 抽屉：业务侧抽屉经 `[data-floating-drawer]` 显式 opt-in（`EnterpriseDrawer` 用 `data-floating-drawer="detail"` + `data-drawer-side="right"`）。宽度档位：`compact` 360px / 默认 448px / `detail` 560px，含 8px（sm 以上 16px）视口 gutter 与宽度上限，消费者宽度类不能绕过。导航与顶/底 sheet 不挂这个属性。

### 2.2 看板规则

- `stats-*` 类由 `assets/css/statistics.css` 集中定义，页面 `import` 该文件即用；不在组件里散落同名样式。
- 数字：`stats-number-button` 大数字 + `tabular-nums`；`stats-tier-mark` 是 7px 方标，第三档用 `--chart-3` 金色呼应「国家级」语义（同样只做标记不做文字）。
- 响应式断点与降级已在 statistics.css 内（1100/767px、1500px 加宽），新增 `stats-*` 样式沿用同一套媒体查询与 `prefers-reduced-motion` 全局关闭规则。

## 3. 可用组件（复用，不另造）

| 组件 | 用途 | 要点 |
| --- | --- | --- |
| `components/PageHeader.vue` | 页头：标题 + 一行说明 + 右侧 `actions` 插槽 | `description` 只写「这一页回答什么问题」，不写凑数介绍 |
| `components/StatTile.vue` | 概览数字砖：标签/大数字/说明 | 工作台与质量页通用；看板大数字走 `stats-number-button`，不用 StatTile |
| `components/EnterpriseDrawer.vue` + `[data-floating-drawer]` | 企业详情侧抽屉，非模态 | 开抽屉不变暗、不锁表格；`back-query` 保筛选上下文 |
| `components/StatsDetailSheet.vue` | 看板下钻明细 sheet | 配 `stats-sheet`/`stats-sheet-body` 类 |
| `components/FilterChip.vue` | 已生效筛选的可撤 chip | 一个 chip 一个条件，`remove` 即清 |
| `components/MultiSelectFilter.vue` | 多值筛选 | 与 `Select`（单值）分工，无原生 select |
| 领域徽标：`TitleBadge` / `SourceChip` / `EventChip` / `DrillChip` | 称号梯度、来源级别、事件类型、下钻入口 | 全经 `Badge` 变体渲染；金标只给国家级 |
| 表格配套：`TablePagination` / `TableLoadingStatus` / `TableFailureState` / `TableHoverCardContent` / `EnterpriseListTable` | 分页、顶部进度、失败重试、悬停详情、台账表 | 失败保留上次成功数据 + 显式 retry |
| `components/ui/*` | shadcn-vue 基础件（Button/Card/Select/Badge/Sheet/Tabs…） | `components.json` 管理；徽章只有 `Badge` 一种标签语法 |
| 图标：`@lucide/vue` | 全站唯一图标入口 | 具名导入（如 `import { X } from '@lucide/vue'`），尺寸用 `size-*` 类，装饰性图标加 `aria-hidden` |

## 4. 不要做（可逐条检查）

1. **金色不写文字**：`--mark-national` / `--chart-3` 只用于 <=7px 的方形/圆形标记与图形填充，任何 `color`/`text-*` 不得引用金色系 token。
2. **`.stats-*` 不进工作台**：非看板页面与组件不得 import `statistics.css` 或使用 `stats-` 前缀类。
3. **不给组件另造颜色变量**：新需求在既有语义 token（表面/primary/tier/mark/chart/feedback）里选；确需新增必须双色板（`:root` + `.dark`）成对定义并登记进 `@theme inline`。
4. **预览换肤只准 `.preview-*` 作用域**：预览内容区的主题覆写（如 `.preview-dark`）只能挂在 `.preview-*` 类下改局部 token，不得改全局 `:root`/`.dark` 或泄漏到页面其余部分。
5. **`--background` 不当页面底**：页面底层背景用 `--page`/`bg-page`；`bg-background` 只给抬起表面（见 1.1）。
6. **不写原生 `<select>`**：单值 `Select`、多值 `MultiSelectFilter`。
7. **解释性小字不进页面**：页面上不放口径说明段落；说明进 `description`、tooltip 或页脚既有位置。
8. **动效必须有 `motion-reduce:` 回退**；新过渡用 `ease-snap`。

## 5. 验证约定

- 改 UI 后桌面与 390px 两处验证受影响交互。
- 后续请求失败时保留已成功结果，并给出显式重试（`TableFailureState` 的 `@retry` 模式）。
