# 设计规范

本文件把项目的 UI 约定固化成可检查的条目。规则的出处是共享组件、业务页面和样式文件 `layers/core/app/assets/css/tailwind.css`。改设计先改这里，再改代码。

## 1. 色板来源与语义角色

色板取自仓库自带的「政企汇报风格包」：政务藏青蓝 + 金色点睛 + 点睛红，与线下汇报材料同源。所有颜色都通过 `layers/core/app/assets/css/tailwind.css` 里的 CSS 变量引用，页面与组件不写死色值。

### 1.1 表面层级：`--page` 与 `--background` 是两个 token

| token | 角色 | 用法 |
| --- | --- | --- |
| `--page` (`bg-page`) | **页面底**：body 与内容区的下沉面，带一点蓝 | 只用于页面/工作台的最底层背景（`body`、`SidebarInset`、`OcrWorkbench` 根） |
| `--background` (`bg-background`) | **抬起的表面**：与卡片同档的纯白/深色 | shadcn 组件把它当抬起面用：Tabs 选中态、Dialog/Sheet、outline 按钮、Switch 滑块 |

- 不许把 `--background` 设成页面底色：一旦同色，Tabs 选中态、Dialog、Switch 会和页面糊在一起（亮色下尤其明显）。页面底永远用 `--page`。
- 层级靠色相偏移区分，不只靠明暗：页面底带蓝相，卡片纯白。

### 1.1.1 业务区域与页面底

- **业务控件须有承载面（用户确认）**：从属于同一任务的筛选、业务按钮、结果和状态提示放进同一个承载区域。页面内用 `Card`，浮层用 `DialogContent`、`SheetContent` 或 `PopoverContent`。布局外壳、导航和页面标题沿用各自的共享组件。
- 筛选、列表或表格、空态和失败重试属于同一流程时，放在同一个承载面里，按内容和操作分区。一组控件共用边界。（Agent 推断）

### 1.2 品牌与告警色

| token | 角色 | 限制 |
| --- | --- | --- |
| `--primary` (`bg-primary`, `text-primary`) | 藏青。导航、主操作、市级来源、称号高等级 | 主色只有一个，不另造「第二主色」 |
| `--mark-national` (`bg-mark-national`) | 金色。只表示「国家级」 | **只做 6px 方形图形标记，一律不写金色文字**（白底对比度仅约 2.6:1，不够正文可读门槛）。见 `layers/sme-roster/app/components/TitleBadge.vue` 的方块、`layers/sme-roster/app/components/SourceChip.vue` 的圆点 |
| `--mark-municipal` | 藏青。市级来源标记 | 与金标成对出现，仅用于来源/等级标记，不挪作主题色 |
| `--destructive` (`text-destructive` 等) | 点睛红。**只用于操作失败或异常告警** | 不做装饰、不做强调色；深色主题下当文字用对卡片约 5.3:1 |
| `--success` / `--warning` | 操作反馈语义色 | 信息复用 `--primary`，错误复用 `--destructive`，不另立 info/error 变量 |

- 状态标签用共享 `Badge` 的语义变体。成功用 `success`，需要留意的结果用 `warning`，进行中或信息提示用 `info`，失败和错误用 `error`，中性结果用 `quiet`。标签始终写明状态，浅色和深色主题中的正文对比度至少为 4.5:1。
| `--ring` | 焦点环 | 复用主色，不单独配色 |

### 1.3 称号梯度：`--tier-*`

称号等级由高到低是一条色阶，每级三个 token：`--tier-{n}-surface`（底）、`--tier-{n}-on`（字）、`--tier-{n}-line`（边）。

- `tier-1` 小巨人：实心藏青；`tier-2` 专精特新中小企业：藏青浅底描边；`tier-3` 创新型中小企业：中性描边。
- `tier-3` 的 `--tier-3-line` 不能只剩近白底：边界要能在白卡片上读出来。
- 梯度只经 `Badge` 的 `tier-1`、`tier-2`、`tier-3` 变体（`layers/core/app/components/ui/badge/index.ts`）落到界面，页面不直接拼 `bg-tier-*`。

### 1.4 动效：`--ease-snap`

统一控制件手感的缓动 `cubic-bezier(0.32, 0.72, 0, 1)`，经 Tailwind 暴露为 `ease-snap` 工具类。控制件过渡、页转场、`TableLoadingStatus` 进度条都用它；写新过渡优先 `ease-snap`，时长沿用既有档位（100/150/180/200ms）。`prefers-reduced-motion` 下所有过渡与动画关闭——新增动效必须带 `motion-reduce:` 回退。

### 1.5 其他既有 token（简要）

- `--ocr-prose-size` / `--ocr-prose-leading` / `--ocr-code-size`：OCR 校对工作台专用字号，只被 `.ocr-workbench` 显式引用，普通页面不得复用（两处均 >=14px，窄屏不落到 12/13px）。
- 表格与 `.tabular` 容器一律 `font-variant-numeric: tabular-nums`：标识码与计数纵向对齐。
- h1–h3/p 开 `text-wrap: pretty`，中文标点能撑开行高。

## 2. 工作台规则

- 工作台使用 shadcn-vue 与 Tailwind 语义样式。页面由 `PageHeader` 和 `Card` 承载，表格使用 `.data-table`，按需组合分页、抽屉和 `Badge`。默认工作区随侧栏之外的可用宽度伸缩，保留统一页边距。应用外壳固定为视口高度，顶栏与侧栏保持在原位。列表在实际剩余高度内滚动其结果区，页头、筛选和分页留在区外。长表单和详情滚动各自的内容区。高级筛选展开后超出可用高度时，筛选表单在区内滚动，保留结果区和分页。
- 平台首页直接进入「历年优质中小企业」。侧栏展示业务页面和平台管理入口。
- 平台「文件管理」显示通用文件信息，并提供上传、预览和维护。公布信息、内容分段、分类、解析和业务引用归属优质中小企业的「名单文件」页。两个入口使用同一个文件 ID 和原件。
- 「企业基础库」是侧栏业务区的独立入口，与业务模块并列。列表以企业名称为主信息。名称和完整信用代码可快速查询，七个业务字段在列表操作栏内展开筛选和排序，内容超高时在展开区内滚动。排序按优先级逐级比较。点未排序的表头追加为末级，点已排序的表头切换方向；排序面板用上移、下移调整优先级。固定表头和最右侧「查看资料」入口。窄屏在表格内横向查看各列，并将信用代码和区县并入企业名称下方供快速浏览。资料和入库来源共用一个抽屉。区划和行业各使用单个级联选择器，按区县进入乡镇、按行业大类进入明细。筛选可停在上一级，维护资料时行业须选到明细，注册地址和经营地址各录一条。抽屉关闭后回到原行。
- 可持续增多的字典采用可搜索的分组目录，详情支持链接直达。宽屏目录和详情并排，窄屏逐级打开，返回时保留目录搜索并恢复焦点。标准字典按实际页头和分页高度预留表格滚动空间，翻页从新页首行开始。
- 列表工具栏统一使用 `table-toolbar`，放在结果卡顶部。左侧放搜索、筛选和视图选择，右侧放当前列表的刷新、导出或上传。窄屏换行时各操作仍在同一卡内。行操作紧随对应记录，表格横向滚动时可固定行操作列。
- 筛选控件：单值用 `Select`、多值用 `MultiSelectFilter`，**不写原生 `<select>`**。已生效条件摊成一行 `FilterChip`，每项可单独撤掉，且必须包含「没有常驻控件」的静默筛选（如下钻带来的 source/event/rosterState）。
- 分页紧接表格，放在同一张 Card 的底部，使用共享 `TablePagination` 的 `in-card` 样式。表体独立滚动时，分页在滚动区外。`workspace-list` 使用工作区的实际剩余高度。筛选栏和分页保持可见，`paginated-table-body` 内的列表承担滚动。企业分页统一写「每页 X 家　共 XXX 家」，文件、日志等列表保留其业务单位。接口提供总数时显示可点击页码并标记当前页。数量信息在左，页码和翻页按钮在右，优先同行。按分页栏自身宽度缩减翻页文案和可见页码。数量和导航只有在实际放不下时才换行，导航内部保持单行。
- 表格：统一 `.data-table` 外壳——13px/20px 字距、吸顶表头 `--table-line`、`muted` 底表头；`TableHeader` 统一吸顶，表头背景不透出滚动中的行。横向和纵向滚动共享 `.data-table-scroll`，内层 Table 包装不另起滚动。`workspace-list` 内由布局分配实际剩余高度，独立表格沿用 `--table-budget` 的视口预算。
- **`min-w` 按列推导，不逐页拍**：`table-fixed` 表的最小宽度由各列内容下限之和决定。
  - 逐列写 `w-*` 像素列的表，`min-w` = 各列像素之和（如 files：12 列求和得 1154px，多写少写都会与列宽脱节）。
  - 百分比/弹性列的表，`min-w` 取「每列刚好放得下其不可再窄内容」的总宽——最长不可断字段、徽章、操作按钮的下限之和（logs 940、current-enterprises 850）。
  - 宽屏再加宽的表用响应式 `min-w`（`lg:min-w-[980px]`、`2xl:min-w-[1080px]`），规则相同；窄屏没有列宽下限时用 `min-w-0` 让内容铺开（EnterpriseListTable）。
- 取数：换条件留住上一批行（`placeholderData: previous`）；失败用 `TableFailureState`，成功结果保留并给显式重试。
- 抽屉：业务侧抽屉经 `[data-floating-drawer]` 显式 opt-in（`EnterpriseDrawer` 用 `data-floating-drawer="detail"` + `data-drawer-side="right"`）。宽度档位：`compact` 360px / 默认 448px / `detail` 560px，含 8px（sm 以上 16px）视口 gutter 与宽度上限，消费者宽度类不能绕过。导航与顶/底 sheet 不挂这个属性。

## 3. 可用组件（复用，不另造）

| 组件 | 用途 | 要点 |
| --- | --- | --- |
| `layers/core/app/components/PageHeader.vue` | 页头：标题 + 一行说明 + 右侧 `actions` 插槽 | `description` 只写「这一页回答什么问题」，不写凑数介绍 |
| `layers/sme-roster/app/components/EnterpriseDrawer.vue` + `[data-floating-drawer]` | 企业详情侧抽屉，非模态 | 开抽屉不变暗、不锁表格；`back-query` 保筛选上下文 |
| `layers/core/app/components/FilterChip.vue` | 已生效筛选的可撤 chip | 一个 chip 一个条件，`remove` 即清 |
| `layers/core/app/components/MultiSelectFilter.vue` | 多值筛选 | 与 `Select`（单值）分工，无原生 select |
| `layers/core/app/components/DatePicker.vue` / `layers/core/app/components/DateTimePicker.vue` | 只选日期 / 选日期和时间 | 复用共享 Calendar 与 Popover。点击标题中的年、月，在同一个浮层内切换年份网格、月份网格和日历。浏览年月只定位日历，选择具体日期才更新值。视图切换用 `ease-snap` 的短过渡，并支持减少动态效果。 |
| 领域徽标：`TitleBadge` / `SourceChip` / `EventChip` | 称号梯度、来源级别、事件类型 | 全经 `Badge` 变体渲染；金标只给国家级 |
| 表格配套：`TablePagination` / `TableLoadingStatus` / `TableFailureState` / `TableHoverCardContent` / `EnterpriseListTable` | 分页、顶部进度、失败重试、悬停详情、台账表 | 失败保留上次成功数据 + 显式 retry |
| `layers/core/app/components/ui/*` | shadcn-vue 基础件（Button/Card/Select/Badge/Sheet/Tabs…） | `components.json` 管理；徽章只有 `Badge` 一种标签语法 |
| 图标：`@lucide/vue` | 全站唯一图标入口 | 具名导入（如 `import { X } from '@lucide/vue'`），尺寸用 `size-*` 类，装饰性图标加 `aria-hidden` |

## 4. 不要做（可逐条检查）

1. **金色不写文字**：`--mark-national` 只用于 <=7px 的方形/圆形标记与图形填充，任何 `color`/`text-*` 不得引用金色系 token。
2. **不给组件另造颜色变量**：新需求在既有语义 token（表面/primary/tier/mark/chart/feedback）里选；确需新增必须双色板（`:root` + `.dark`）成对定义并登记进 `@theme inline`。
3. **预览换肤只准 `.preview-*` 作用域**：预览内容区的主题覆写（如 `.preview-dark`）只能挂在 `.preview-*` 类下改局部 token，不得改全局 `:root`/`.dark` 或泄漏到页面其余部分。
4. **`--background` 不当页面底**：页面底层背景用 `--page`/`bg-page`；`bg-background` 只给抬起表面（见 1.1）。
5. **业务页面复用组件（用户确认）**：按钮、输入、选择、日历、表格、分页、弹窗和开关优先复用 `layers/core/app/components/ui/` 的 shadcn-vue 组件或现有共享组件。业务组件负责组合、布局和数据，不直接写原生可见控件，也不用 `div` / `span` 加交互角色模拟已有控件。单值选项用 `Select`，多值用 `MultiSelectFilter`，日期用共享日期选择器，表单用 `FieldGroup` / `Field`。选择本机文件时，使用共享 `Button` 触发隐藏的 `Input type="file"`；`form`、`section`、`ul`、`dl` 等语义结构用于组织内容。
6. **解释性小字不进页面**：页面上不放口径说明段落；说明进 `description`、tooltip 或页脚既有位置。
7. **动效必须有 `motion-reduce:` 回退**；新过渡用 `ease-snap`。
8. **业务详情围绕业务事实**：优先展示事项、结论、日期、批次和可核对的来源。原始字段码、数据库主键、后台采集时间和执行细节放在对应的运维或原始证据入口。

## 5. 验证约定

- 改 UI 后桌面与 390px 两处验证受影响交互。
- 交付前在源码核对基础组件出处，在实际浏览器核对业务控件与对应内容位于同一承载面。覆盖有数据、空态，以及本次受影响的弹窗和失败状态。（Agent 推断）
- 业务入口使用用户理解的动作名称。线索名单入口叫「新增名单」，末步叫「保存名单」。平台自动化接口的凭据不进入新增名单表单。（用户确认）
- 线索名单补充可直接切换「关联已有企业」和「新增企业」。保存时明确提交基础库资料，保留原名单行。页面无需手填令牌、核对人或核对依据。企业基础库以业务来源为主标题，系列、日期及可用的原文件放在其下。
- 线索名单默认展示目录。宽屏通过可搜索、独立滚动的侧栏按类型或来源浏览，窄屏用筛选抽屉承载同一目录。顶栏保留系列筛选、已生效的条件和新增入口，目录逐行标明类型和来源，从详情返回时保留筛选和页码。
- 新增名单按原件与资料、名单预览、确认名单组织。长文件名在有界的搜索结果内换行，目录仅用于区分文件。名单可以用工作簿导入或从表格粘贴，确认前显示解析结果，提交失败时保留已填写资料。
- 后续请求失败时保留已成功结果，并给出显式重试（`TableFailureState` 的 `@retry` 模式）。
