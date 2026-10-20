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

需要 Node.js 22 或更新版本，以及 pnpm 12.11.2。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

开发服务默认运行在 `http://localhost:3000`。`pnpm typecheck`、`pnpm test` 和 `pnpm build` 分别用于类型检查、测试和生产构建。

SQLite 数据库默认位于 `data/roster.db`，可用 `NUXT_DB_PATH` 覆盖；来源文件默认位于 `files/`，可用 `NUXT_FILES_DIR` 覆盖。新克隆仓库不含数据库、公布文件、平台导出表或上传件，首次使用时应从本机安全备份恢复，或通过应用文件管理页上传。真实 OCR、HTTP 写入和 MCP 写入凭证只放在本地 `.env` 或运行环境密钥中；不要提交凭证。

任务页面不收集或保存 API 密钥。需要开放页面提交导出、下载、取消及局部重试时，在服务端同时配置 `NUXT_API_TOKEN` 与 `NUXT_BROWSER_TASKS_ENABLED=true`。默认关闭时只读；同源检查只用于这一显式部署能力，不识别用户，后续权限体系见 #127。REST/MCP 调用仍使用各自的 token。

## 数据与导入边界

公布文件及其名单附件是称号和认定/复核事件的依据；平台导出表只是当前状态的对照快照。企业总表应跨称号去重，同时保留每条称号历史、来源页码、平台关系与差异解释。导出表未匹配的公布名单条目仍须保留。

当前应用已提供文件、页图、OCR 和部分解析结果的 API/MCP 能力。统一的企业、称号事件与年度平台快照写入 API 仍在路线图 RL-11 中；完成该接口前，不应把数据库直写或临时导入脚本当作正式流程。

## 交接入口

- SVG 品牌资源与复现方法：[品牌资源说明](public/brand/README.md)
- 代理清理与入库流程：[仓库自有技能](.agents/skills/roster-ingestion-pipeline/SKILL.md)
- 名录生命周期、对比及用户功能路线图：[路线图与票据](.scratch/roster-lifecycle/SPEC.md)
- 文件/OCR 工作台已交付范围与验收记录：[入库管线规格](.scratch/ingest-pipeline/SPEC.md)
- 外部 OCR 凭据配置、持久卷与备份恢复：[docs/credential-settings.md](docs/credential-settings.md)
- 业务词汇、数据模型与决策记录：[GLOSSARY.md](GLOSSARY.md)、[docs/data-model.md](docs/data-model.md)、[docs/adr/](docs/adr/)
