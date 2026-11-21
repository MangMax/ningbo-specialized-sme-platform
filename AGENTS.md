# Agent handoff

- For roster-file cleanup or import, follow [the repository ingestion skill](.agents/skills/roster-ingestion-pipeline/SKILL.md), including its per-file handoff and page-level evidence rules.
- Before writing to the app, inspect the running app's `/_openapi.json` or MCP `tools/list` contract.
- Treat published announcement attachments as designation evidence and platform exports as current-state comparison snapshots. Keep all official roster rows, including rows unmatched to exports.
- Keep business databases, source documents, uploaded files, and credentials outside Git commits.
- For Vue UI changes, follow [DESIGN.md](DESIGN.md): reuse the shared components there and verify affected interactions on desktop and at 390px. Retain successful results when a later request fails, and provide an explicit retry.
- Keep architectural decisions in `docs/adr/` and agent instructions in `AGENTS.md`, `docs/agents/`, or `.agents/`. Track specifications, plans, progress, reviews and follow-up work in GitHub Issues; keep generated reports, screenshots and logs outside Git.
- For new background jobs or job notifications, follow [the job integration contract](docs/agents/background-jobs.md).
- For test changes, follow [test ownership and execution conventions](docs/agents/testing.md).

## 数据库访问

本仓库的数据库读写一律使用 Drizzle 的类型化表定义、查询构造器和事务 API。手写 SQL 包括 `sql` 标签模板、`sql.raw()`、传给 `execute()` 的 SQL，以及通过底层驱动或独立 SQL 文件执行的自编语句。把 SQL 移进辅助函数或换一个执行入口，同样适用这条规则。

唯一例外是项目所用 Drizzle 版本确实无法表达所需的数据库特性。先核对该版本的 API 和可保持业务语义的构造器写法；确需例外时，只保留实现该特性的最小 SQL，在对应实现旁说明具体特性和限制，所有外部值使用绑定参数。查询复杂、已有旧实现或少写代码均不构成例外。

## Agent skills

### Issue tracker

For specs and tickets, use GitHub Issues in `MangMax/ningbo-specialized-sme-platform`. Read [the tracker conventions](docs/agents/issue-tracker.md) before tracker operations.

### Triage labels

For issue triage and readiness labels, use the five canonical role names. Read [the label mapping](docs/agents/triage-labels.md).

### Domain docs

Before codebase exploration for engineering skills, read the relevant decisions under `docs/adr/` as described in [the domain rules](docs/agents/domain.md).
