# 应用接入验收

## 范围

资源进入 `public/brand/`；侧栏用 32px 图形标加 168px 文字标；favicon 用 16px 专用版，并随系统明暗模式适配；README 用带深色模式备选的图文组合。保留品牌返回首页链接、折叠行为和页面内主题切换。

设计生成器加 `--publish` 同步资源，字体子集和 OFL 许可入仓。SVG 及展示页为生成产物。PNG 截图、下载 ZIP 是本地证据，不入 Git；设计评审原文中的截图引用也属于本地证据。

## 验证

- `pnpm install --frozen-lockfile` 完成，没有修改 lockfile。
- `pnpm typecheck` 通过。
- `uv run design/brand/2026-10-18-logo/generate.py --publish` 后检查 12 个 SVG 的公共副本与源输出一致、重复生成哈希一致；favicon 是 compact 派生。
- 13 个公共 SVG 通过实际 HTTP 读取，状态 200、`image/svg+xml`，XML 可解析，无文字元素、位图、脚本和外链。
- 在 1280×800 实际展开/收起侧栏，切换浅色/深色主题，图形和文字均成功载入。
- 在 390×844 打开移动菜单，浅色/深色均无品牌裁切；从文件管理点击品牌链接回到 `/`。
- `favicon.svg` 已进入页面 `link[rel=icon]`。未做跨浏览器 favicon 缓存/标签栏原生图标的人工检查。
- 项目未配置 lint 脚本；没有运行生产构建或全量业务测试，本次没有业务逻辑变更。

## 环境与证据

使用独立本地开发服务 `127.0.0.1:3497`、`/tmp/ningbo-brand-acceptance-20261018` 下的空库与文件目录，由应用自动初始化；不使用生产数据库或真实来源文件。初次 Vite 优化有短暂的 `504 (Outdated Optimize Dep)` 并自动重载，之后品牌资源正常载入。

本地截图位于 `.scratch/brand/integration/evidence/`：`desktop-light.png`、`desktop-dark.png`、`desktop-dark-collapsed.png`、`mobile-light.png`、`mobile-dark.png`。页面业务内容为空库状态，仅作为品牌与导航验收，不作为真实名录业务验收。

独立视觉评审：原始设计完成一轮 Magpie + DeepSeek OpenDesign 评审，初版 7/10，修订与处理见 `review.md`。本轮是已确认设计的资源接入，由主 Agent 进行实际界面验证，未另开独立代码/视觉复审。
