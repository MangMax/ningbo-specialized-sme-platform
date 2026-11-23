---
name: lead-list-ingestion
description: '用于本应用的名单分流、线索名单版本登记、名单行导入、向企业基础库手动单向补充与异步 CSV 导出。'
---

# 名单分流与线索名单入库

适用于接收外部或内部清单文件后的业务分流、线索名单登记与行导入、向平台企业基础库（共享内核）手动单向补充，以及线索版本 CSV 导出。

## 一、名单分流规则

| 文件特征 | 归属模块 | 使用技能 |
| --- | --- | --- |
| 经信局/工信部正式公布名单（认定、复核、取消）及工信部平台导出快照 | `sme-roster`（优质中小企业） | [roster-ingestion-pipeline](../roster-ingestion-pipeline/SKILL.md) |
| 纯企业清单（调研走访、外部推送、专项排查等无独立年度称号/指标字段的名单） | `lead-lists`（线索名单） | 本技能 |
| 逐年累积且具有独立业务字段的新业务名单 | 对应业务模块 | 对应模块流程（不塞入线索或名录） |

## 二、线索版本登记与行导入

写入前查看运行中应用的 `/_openapi.json` 核对当前字段与写鉴权（`NUXT_API_TOKEN`）；只读模式（`NUXT_DB_READONLY=1`）下停止写入。

1. **上传原件**：通过平台通用文件上传（tus `/api/uploads`）将原件登记入文件库，取得稳定的 `fileId`。线索版本通过 `fileId` 贡献文件引用数，防止原件被误隔离。
2. **核对字典**：通过 `GET /api/lead-lists/versions` 或 `GET /api/core/dictionaries/{kind}` 读取合法的来源渠道（`channel`）与名单类型（`listType`）；如需新增字典项，先通过 `POST /api/core/dictionaries/{kind}` 维护。
3. **提交版本与原始行**：调用 `POST /api/lead-lists/versions`，必填字段：
   - `series`：所属系列（非空，≤120 字符）
   - `channel`：来源渠道代码
   - `listType`：名单类型代码
   - `acquiredOn`：获取日期（ISO `YYYY-MM-DD`）
   - `fileId`：文件库原件 ID
   - `rows`：原始行数组（1–2000 行），每行含唯一 `rowNumber`、`name`，可选 `uscc`、`district`、`note`
4. **读回核验**：调用 `GET /api/lead-lists/versions/{id}` 核对版本摘要、原件链接（`GET /api/lead-lists/versions/{id}/source`）与全部原始行。原始行先留存原值，此时 `enterpriseId` 允许为 `null`。

## 三、手动单向补充至企业基础库

企业主体身份与通用档案由 `core` 共享内核持有；数据**仅从业务模块单向流向企业基础库**，须经人工或代理核对后显式触发：

1. **身份核对**：调用 `GET /api/core/enterprises` 按归一化统一社会信用代码（优先）或归一化企业名称（缺统代时精确匹配）查询候选主体；存在多候选时交人工确认，不按名称相似自动合并。
2. **提交补充**：调用 `POST /api/lead-lists/versions/{id}/supplement`，逐行提交核对后的企业映射与显式指定的资料字段：
   - 已有企业提供目标 `enterpriseId` 与预期版本；新建企业提供现用名称；未显式指定的字段保留基础库现值。
   - 行政区划（区县/乡镇）与行业（2017 版四位码）须使用 `core` 字典代码；**注册地址（`registered`）与经营场所（`operating`）严格区分**，不把注册地址默认填成经营场所。
   - 平台在同一事务内写入企业资料与来源关联（`enterprise_source` / `enterprise_source_link`），并回填 `lead_list_row.enterprise_id`。
3. **直接新增与移出语义**：不经线索版本直接新增企业时调用 `POST /api/core/enterprises`（自动登记 `direct` 来源）；从基础库移出或恢复通过 `PATCH /api/core/enterprises/{id}/membership` 执行，历史出处记录保留可查。

## 四、异步 CSV 导出

1. 调用 `POST /api/lead-lists/exports`，传入 `{ versionId, clientRequestId }`（UUID，重试同一操作沿用同一 `clientRequestId` 去重）。
2. 通过任务中心（`GET /api/task-center/{jobId}`）确认任务进入 `done` 终态后，调用 `GET /api/lead-lists/exports/{jobId}/download` 下载 CSV。

## 约束

- 原文件、业务数据库、凭据与导出产物一律保存在 Git 外。
- 排查运行故障时，按 `GET /api/logs` 过滤 `module=lead-lists` 或 `module=core` 与 `requestId` / `taskId`。
