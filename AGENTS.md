# Agent handoff

- For roster-file cleanup or import, follow [the repository ingestion skill](.agents/skills/roster-ingestion-pipeline/SKILL.md), including its per-file handoff and page-level evidence rules.
- Before writing to the app, inspect the running app's `/_openapi.json` or MCP `tools/list` contract.
- Treat published announcement attachments as designation evidence and platform exports as current-state comparison snapshots. Keep all official roster rows, including rows unmatched to exports.
- Keep business databases, source documents, uploaded files, and credentials outside Git commits.
- For Vue UI changes, reuse the existing shared components and verify affected interactions on desktop and at 390px. Retain successful results when a later request fails, and provide an explicit retry.
- Keep architectural decisions in `docs/adr/` and agent instructions in `AGENTS.md`, `docs/agents/`, or `.agents/`. Track specifications, plans, progress, reviews and follow-up work in GitHub Issues; keep generated reports, screenshots and logs outside Git.
- For test changes, follow [test ownership and execution conventions](docs/agents/testing.md).

## Agent skills

### Issue tracker

For specs and tickets, use GitHub Issues in `MangMax/ningbo-specialized-sme-platform`. Read [the tracker conventions](docs/agents/issue-tracker.md) before tracker operations.

### Triage labels

For issue triage and readiness labels, use the five canonical role names. Read [the label mapping](docs/agents/triage-labels.md).

### Domain docs

Before codebase exploration for engineering skills, read the relevant decisions under `docs/adr/` as described in [the domain rules](docs/agents/domain.md).
