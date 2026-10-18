# 应用接入验收

## 范围

资源进入 `public/brand/`；侧栏用 24px 图形配 14px 界面文字；favicon 用 16px 专用版，并随系统明暗模式适配；README 用带深色模式备选的图文组合。保留品牌返回首页链接、折叠行为和页面内主题切换。

设计生成器加 `--publish` 同步资源，字体子集和 OFL 许可入仓。SVG 及展示页为生成产物。PNG 截图、下载 ZIP 是本地证据，不入 Git；设计评审原文中的截图引用也属于本地证据。

## 验证

- `pnpm install --frozen-lockfile` 完成，没有修改 lockfile。
- `pnpm typecheck` 通过。
- `uv run design/brand/2026-10-18-logo/generate.py --publish` 后检查 15 个 SVG 的公共副本与源输出一致、重复生成哈希一致；favicon 是 compact 派生。
- 16 个公共 SVG 通过实际 HTTP 读取，状态 200、`image/svg+xml`，XML 可解析，无文字元素、位图、脚本和外链。
- 在 1280×800 实际展开/收起侧栏，切换浅色/深色主题，图形和文字均成功载入。
- 在 390×844 打开移动菜单，浅色/深色均无品牌裁切；从文件管理点击品牌链接回到 `/`。
- `favicon.svg` 已进入页面 `link[rel=icon]`。未做跨浏览器 favicon 缓存/标签栏原生图标的人工检查。
- 项目未配置 lint 脚本；没有运行生产构建或全量业务测试，本次没有业务逻辑变更。

## 环境与证据

使用独立本地开发服务 `127.0.0.1:3497`、`/tmp/ningbo-brand-acceptance-20261018` 下的空库与文件目录，由应用自动初始化；不使用生产数据库或真实来源文件。初次 Vite 优化有短暂的 `504 (Outdated Optimize Dep)` 并自动重载，之后品牌资源正常载入。

本地截图位于 `.scratch/brand/integration/evidence/`：`desktop-light.png`、`desktop-dark.png`、`desktop-dark-collapsed.png`、`mobile-light.png`、`mobile-dark.png`。页面业务内容为空库状态，仅作为品牌与导航验收，不作为真实名录业务验收。

旧方向的独立视觉评审：原始 N 设计完成一轮 Magpie + DeepSeek OpenDesign 评审，初版 7/10，修订与处理见 `review.md`。本轮是已确认设计的资源接入，由主 Agent 进行实际界面验证，未另开独立代码/视觉复审。

## 抽象方向修订

用户要求名称简化为“专精特新”，图形需要抽象表达专精特新。已替换 N 为四块切面向心围合、右上块为独立菱形的形态，文字标缩为四字，侧栏宽度 112px；README 标题、品牌链接无障碍名称、SVG aria-label 与 favicon 同步更新。业务地域仍是宁波，未改动业务文案和数据范围。新一轮设计评审由同一指定 provider/model 完成，初稿 7/10；响应见 review.md。

抽象方向复验：`pnpm typecheck` 通过；16 个公共 SVG HTTP 200/MIME/XML 及重复生成、源/公共副本一致性检查通过。实际查看 1280×800 浅/深主题与 390×844 深色菜单，文字标实际宽度 112px、四字完整。新截图为本地证据目录的 `abstract-desktop-light.png`、`abstract-desktop-dark.png`、`abstract-mobile-dark.png`。

抽象评审后修订：增加原生 24px 光学版，16px 保留独立菱形；“新”字末端斜切。SVG 总数为 15 个品牌资源加 1 个 favicon。修订稿的实际渲染截图为本地 `abstract-revised-728.png`、`abstract-revised-390.png`。

最终修订复验：15 个品牌 SVG 加 favicon 的 HTTP/XML/哈希一致性检查、定制“新”字斜切路径检查均通过；`pnpm typecheck` 通过。桌面 1280px、移动 390px 实际重新载入资源并查看，无品牌裁切；移动截图另存为 `.scratch/brand/integration/evidence/abstract-revised-mobile-dark.png`。


## 侧栏使用方式修订

用户认可标识后指出侧栏过大、过满，要求使用技能评审实际布局。按 Oil UI 存量界面润色流程处理：图形从 32px 色块底座改为 24px 无底板 small 版；112px 展示字标改为与导航同档的 14px / medium 界面文字；48px 品牌点击行与现有留白保留。桌面折叠时隐藏文字、图形居中。

实际测得展开图形为 24×24、名称 14px 字号/20px 行高，组合可见宽度约 88px；原版为 32px 底座加约 26px 字高的展示字标。1280px 明暗主题、折叠状态和 390px 移动菜单均查看；品牌链接从文件管理返回首页通过；pnpm typecheck 通过。

本轮独立评审已交给 Magpie / DeepSeek OpenDesign，按 Oil UI【存量已有界面润色评审】执行，不打分。范围是尺寸、布局、对齐与主题使用，不重新设计已认可的标识；记录见 `sidebar-layout-review.md`。

本地证据：`.scratch/brand/integration/evidence/sidebar-before-desktop-dark.png`，以及 `sidebar-after-desktop-light.png`、`sidebar-after-desktop-dark.png`、`sidebar-after-collapsed-dark.png`、`sidebar-after-mobile-light.png`。本轮未添加动效，未删产品文案，去掉展示底板及重复排版容器；保留导航和可访问名称。
