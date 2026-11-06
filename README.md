# 专精特新

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/lockup-white.svg">
  <img src="public/brand/lockup.svg" alt="专精特新" width="252" height="64">
</picture>

面向宁波市专精特新企业名录的可扩展数据平台。当前包含跨称号名录查看、工信部平台导出对比、来源文件与页码证据、PDF 页图和 OCR 工作台；后续模块按业务需要逐步加入。

技术栈：Nuxt 4 SPA（关闭 SSR）、Vue 3、Drizzle ORM、SQLite、shadcn-vue、Pinia Colada、VueUse、pnpm。

## 当前模块

| 路由 | 用途 |
| --- | --- |
| `/` | 浏览企业名录、称号事件和筛选结果 |
| `/comparison` | 对照公布名录与工信部当前导出，查看并维护差异解释 |
| `/files` | 管理来源文件、TUS 上传、预览和 PDF 页图 |
| `/ocr` | 管理页图 OCR、结果校对与导入 |
| `/enterprises/:id` | 查看企业历史事件与出处 |
| `/stats`、`/quality` | 查看名录统计和数据质量 |

## 本地运行

需要 Node.js 24 LTS（24.x）以及 pnpm 12.11.2。容器基础镜像与原生依赖构建、备份及回滚步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

开发服务默认运行在 `http://localhost:3000`。`pnpm typecheck`、`pnpm test` 和 `pnpm build` 分别用于类型检查、测试和生产构建。

### 框架与结构体检

已接入固定版本的 [Vite Doctor](https://vite-doctor.onmax.me/) 开发依赖和 Nuxt 模块。
首次安装后运行 `pnpm exec nuxt prepare`，随后可执行：

```bash
pnpm check:doctor                  # Nuxt / Vue / Nitro / Vite 等框架规则
pnpm --silent check:doctor:json    # 同一检查的纯 JSON 输出，便于重定向
pnpm check:doctor:structure        # 死代码、依赖图、重复代码和复杂度
```

全面体检应分别运行框架和结构检查：`--analyses` 只选择结构分析，不包含默认框架规则。
需要不使用缓存时追加 `--no-cache`。发现错误时命令返回非零，不代表工具启动失败。
诊断是静态线索，需要结合项目的 SPA 配置、Nuxt 自动导入、测试目录和已有校验核实；
不要直接删除被标记为未使用的模块，或批量执行 `--fix`。本次接入不新增 CI 阻断规则。
首次体检的历史记录见 [Vite Doctor 体检报告](docs/reports/vite-doctor-2026-10-22.md)，不代表当前版本验收。

SQLite 数据库默认位于 `data/roster.db`，可用 `NUXT_DB_PATH` 覆盖；来源文件默认位于 `files/`，可用 `NUXT_FILES_DIR` 覆盖。新克隆仓库不含数据库、公布文件、平台导出表或上传件，首次使用时应从本机安全备份恢复，或通过应用文件管理页上传。API/MCP 访问 token 使用本地 `.env` 或运行环境配置（`NUXT_API_TOKEN`、`NUXT_MCP_TOKEN`）；外部 OCR token 和工信部平台 Cookie 可由应用保存到 SQLite，无显式 override 时保存值优先、环境变量回退。显式 override 的优先级及独立 CLI 例外见[外部服务凭据配置](docs/credential-settings.md#生效规则)。完整数据库备份包含已保存的外部凭据，应按敏感数据保护；不要提交凭证。

任务页面不收集或保存 API 密钥。同源页面默认可提交导出、下载、取消及安全局部重试，无需配置 API token；请求须通过浏览器标记、Fetch Metadata 及 Origin/Referer 校验，POST 还须使用 JSON。同源检查不识别用户；外部 REST/MCP 调用仍使用各自的 token。

## 数据与导入边界

公布文件及其名单附件是称号和认定/复核事件的依据；平台导出表只是当前状态的对照快照。企业总表应跨称号去重，同时保留每条称号历史、来源页码、平台关系与差异解释。导出表未匹配的公布名单条目仍须保留。

当前应用已提供文件、页图、OCR、解析结果及统一名录入库的 API/MCP 能力，入库载荷与调用约定见[名录生命周期契约](docs/roster-lifecycle-contract.md) §8（REST）和 §9（MCP）。`POST /api/roster/import/preflight` 与 MCP `preflight_roster_batch` 用于计算影响和报告冲突，不写业务数据，但可记录入库批次及预检结果，并非完全无副作用；确认预检结果后，通过 `POST /api/roster/import/commit` 或 MCP `save_roster_batch` 鉴权提交，以幂等键和单批事务写入企业、称号事件、出处及平台导出快照等数据。数据库直写或临时导入脚本不应替代这一正式流程。

## 交接入口

- 当前契约、操作说明与历史证据：[文档导航](docs/README.md)。修改业务前先读对应契约；旧规格与验收回执用于追溯当时的设计和结果。
- SVG 品牌资源与复现方法：[品牌资源说明](public/brand/README.md)
- 代理清理与入库流程：[仓库自有技能](.agents/skills/roster-ingestion-pipeline/SKILL.md)
- 外部 OCR 凭据配置、持久卷与备份恢复：[docs/credential-settings.md](docs/credential-settings.md)
