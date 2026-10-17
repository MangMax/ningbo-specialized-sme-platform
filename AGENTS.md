# Agent handoff

- For roster-file cleanup or import, follow [the repository ingestion skill](.agents/skills/roster-ingestion-pipeline/SKILL.md), including its per-file handoff and page-level evidence rules.
- Before writing to the app, inspect the current OpenAPI/MCP contract. The unified roster write API is tracked in [RL-11](.scratch/roster-lifecycle/issues/RL-11-api-ingestion.md).
- Treat published announcement attachments as designation evidence and platform exports as current-state comparison snapshots. Keep all official roster rows, including rows unmatched to exports.
- Keep business databases, source documents, uploaded files, and credentials outside Git commits.
- For Vue UI changes, follow [the UI conventions](docs/ui-conventions.md) and verify affected interactions on desktop and at 390px.
