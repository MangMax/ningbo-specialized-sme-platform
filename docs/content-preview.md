# 共享只读正文预览

`components/preview/ContentPreview.vue` 接收原始 `source`，用于 Markdown、OCR 已加载正文及代码/纯文本。OCR 编辑器应继续直接绑定原始正文；显示错误不代表 OCR 状态变化。组件不保存、上传或请求 OCR。

## 公开接口

| Prop | 默认值 / 含义 |
| --- | --- |
| `source: string` | 必填；唯一原文，空字符串有效 |
| `format?: 'markdown' \| 'text'` | `markdown` |
| `language?: string` | Markdown 默认 `markdown`，其他默认 `text`；未知语言显示纯文本 |
| `name?: string` | `正文.md`；工具栏与下载文件名 |
| `theme?: 'light' \| 'dark'` | `light`；响应外部变化，也可在工具栏切换 |
| `mode?: 'rendered' \| 'source'` | `rendered`；支持 `v-model:mode` |
| `readonly?: boolean` | `true`；组件始终只读，传 false 也不会启用编辑 |
| `resources?: Readonly<Record<string, string>>` | 调用者明确提供的当前来源资源映射；相对名称映射到同源 `/api/files/` 或 `/api/page-images/` 路径，不推断文件系统位置 |

事件：`update:mode(mode)`；剪贴板成功后 `copy(source)`；显示/高亮/复制失败 `error(message)`。复制和下载使用完整原字符串，代码块复制使用解析器的原始 code 字符串。

`TextFilePreview` 负责 URL 加载、同源/blob 校验、禁止重定向、旧请求取消和晚响应隔离，失败保留上次成功结果及其文件名。`FilePreview` 按明确扩展名分派；原 PDF、图片和 Office 分支保留。blob 使用调用者提供的文件名判型。文件回吐复用原文件库锁根规则，不改变登记/导入范围；文本统一返回 text/plain、nosniff 和 CSP sandbox。单段文件 GET 使用同一处理器，避免被现有文件 ID 路由遮蔽。

## 安全与大内容

- 使用 Markstream 的公开 `custom-id` + `setCustomComponents(id, mapping)` / `removeCustomComponents(id)`；每个实例独立 ID，覆写 `code_block`、HTML、图片和链接节点，不注册全局默认映射。
- HTML 在原生 inert template 中处理，先移除请求能力，再经 DOMPurify 明确标签/属性白名单。保留 table、rowspan、colspan 和必要文本结构；不保留脚本、事件、style、嵌入文档或自定义 Vue 组件。展示处理不回写源字符串。
- 图片始终为占位，不自动请求；HTTP(S) 外链显式标识并使用 noopener/noreferrer/nofollow。相对资源只有显式映射后可点击；不自动加载，即使已映射。危险协议和越界映射不可点击。
- 静态 final 文档，无逐字、淡入或平滑流式播放。公式、Mermaid、D2、信息图及自定义节点不启用；未知节点显示惰性原文。
- Markdown 超过 200000 UTF-16 字符直接显示源码；高亮超过 100000 字符使用纯文本。URL 文本限制 5 MB，NUL 二进制内容报错。原文复制/下载不截断，内容区承担横向/纵向滚动。
- 渲染/高亮失败显示源码。异步高亮隔离 source/language/theme 变化，旧结果不覆盖新内容。

## 依赖与官方 API 核对（2026-10-17）

精确锁定 `markstream-vue@2.0.19`、`shiki@4.5.0`、`dompurify@3.4.17`，同时提交 pnpm lockfile。发布包的 Vue peer 为 `>=3.0.0`，本项目为 Vue 3.5 / Nuxt 4，typecheck 与生产构建验证兼容。不安装 Markstream 的 KaTeX、Mermaid、stream-diffs、D2、infographic 等可选 peers。

依据：

- [Markstream 官方 README](https://github.com/Simon-He95/markstream-vue)：`nodes`、`final`、`custom-id` 和 scoped `setCustomComponents`；本机发布包 `dist/index.d.ts` 中 `NodeRendererProps`、`CustomComponents` 和注册/移除函数声明逐项核对；真实组件测试覆盖作用域、嵌套代码、GFM 和 OCR HTML。
- [Shiki 4.5 官方性能指南](https://shiki.style/guide/best-performance)：`createHighlighterCore`、JavaScript regex engine、细粒度动态语言/主题导入及实例复用。实现从 `shiki/core`、`shiki/engine/javascript` 和明确 `shiki/langs/*.mjs` / `shiki/themes/*.mjs` 导入；语言和主题加载 Promise 缓存，失败可重试。未使用 full/web bundle、运行时 CDN 或 WASM 下载。
- [DOMPurify 官方文档](https://github.com/cure53/DOMPurify)：`ALLOWED_TAGS`、`ALLOWED_ATTR`、`ALLOW_DATA_ATTR`、`RETURN_DOM_FRAGMENT` 和片段净化接口。使用浏览器 DOM，不在服务器以不完整 DOM 实现执行清理。

## 视觉与验证

沿用当前 oil-ui 路线的中性色、细边框、共享 shadcn Button 与现有 Dialog；工具栏换行、内容内部滚动。只添加按钮自身的既有状态反馈，不引入额外内容动画。桌面和 390px 用临时合成文件及隔离只读 SQLite 验证。详细命令、日志与浏览器证据放在 `/tmp/ningbo-46-49-context/`，不提交数据或凭据。未做独立视觉评审（用户明确禁止派子代理）。

初始客户端挂载前只输出惰性 pre 原文，不为了短暂的源码占位初始化 Shiki；阅读模式只有遇到围栏代码才加载对应高亮语言。

安全 DOM 集成用例使用精确锁定的 `jsdom@30.1.3`（仅 devDependency）。DOMPurify 官方明确不支持以 happy-dom 作为安全 DOM 实现；升级净化器后最小 table 夹具在 happy-dom 中出现错误移除，因此这些用例使用其支持的 jsdom，并保留真实 Chromium 验收，不模拟净化器或放宽断言。

Markstream 的语言专用渲染器优先于 `code_block` 覆写。因此解析后通过公开 `nodes` 边界将围栏节点规范为局部 `preview_code` 节点，将原始 HTML 规范为局部 `preview_html` 节点；源 code/content 字符串保留。这样 Mermaid/D2 或名为 image/link 的未知代码语言也只进入 Shiki/纯文本，不会进入图表或其他节点组件。
