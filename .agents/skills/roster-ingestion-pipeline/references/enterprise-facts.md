# 主体事实与差异解释的公开协议

在查证迁入、迁出、注销或登记状态，确认/更正/撤回来源事实，或在差异解释中引用这些事实时读取本节。事实与差异原因分开保存；正式认定、身份与平台关系仍按各自流程维护。

## 发现与输入绑定

1. 在目标应用取当前 OpenAPI，或带应用 MCP 授权执行 `tools/list`。核对下表工具、`inputSchema`、写能力可用性；HTTP 与 MCP 令牌由服务端分别配置，平台 Cookie 不参与此协议。缺少写工具时先报告能力缺口。
2. 用精确企业 ID 读事实；每个企业的事实 `factId` 仅在该企业内唯一，跨企业不能复用。先核实来源、主体与迁移方向，再保存来源断言。查询完成只说明 collected，不代表已确认事实或已完成业务迁移。
3. 每条命令保存完整请求、幂等键、预检计划和回执到 Git 外。事实 `expectedVersion` 来自同一次事实读取，不可使用企业资料版本、差异决定 ID、文件 inputRef 或其他企业版本代替。`planHash` 绑定企业 ID 与完整命令；预检后变更任一字段，先重新读取和预检。

| 操作 | HTTP | MCP 与参数 |
| --- | --- | --- |
| 读事实与审计 | `GET /api/roster/enterprises/{id}/facts` | `get_enterprise_facts({enterpriseId})` |
| 事实预检 | `POST /api/roster/enterprises/{id}/facts/preflight`，body 为命令 | `preflight_enterprise_fact({enterpriseId,request:命令})` |
| 事实提交 | `POST /api/roster/enterprises/{id}/facts/commit`，body 为 `{request:命令,planHash}` | `commit_enterprise_fact({enterpriseId,request:{request:命令,planHash}})` |
| 差异当前决定 | `GET /api/roster/decision-lifecycle/current?enterpriseId=…&titleCode=…&direction=…` | `get_current_difference_decision({enterpriseId,titleCode,direction})` |
| 差异决定提交 | `POST /api/roster/decision-lifecycle/commands`，body 为完整决定 | `save_difference_decision(完整决定)` |
| 精确决定版本 | `GET /api/roster/decision-lifecycle/{id}` | `get_difference_decision({id})` |

事实读取返回 `{enterpriseId,version,facts,history}`。`facts` 为每条断言的最新状态，含 `factId/revision/status/fact/replaces`；`history` 保留原始操作、actor、basis 与时间。差异提交目前没有独立 preflight/planHash 接口，其 CAS 与事实引用检查在提交事务内执行；不要为它编造预检工具。

## 保存、确认、更正、撤回

命令公共字段为 `expectedVersion/idempotencyKey/actor/basis/action`。`actor` 是真实操作者 `{type:'agent'|'user',id}`；`basis` 写本次操作依据。

- 新断言：`action:'assert', fact`，得到 **pending**，单独审查来源后才确认。
- 确认：重新读取版本，`action:'confirm', factId`，仅 pending 可变 confirmed。
- 更正：重新读取版本，`action:'replace', factId, fact`，旧断言变 replaced，回执给出新的 `factId`，新断言从 pending 开始；独立确认新断言。
- 撤回：重新读取版本，`action:'withdraw', factId`，保留历史。withdrawn/replaced 为终态，不能重新确认旧 ID。

`fact` 必填形状示例（仅合成，实际使用真实出处与精度）：

```json
{
  "kind": "moved_out",
  "source": {"reference": "synthetic:notice:307", "statement": "通知明确迁出宁波，目的地未载明"},
  "observed": {"precision": "day", "value": "2026-11-05"},
  "effective": {"precision": "year", "value": "2024"},
  "city": null
}
```

`kind` 仅 `moved_in/moved_out/cancelled/registration_status`。`precision` 为 unknown/year/month/day/instant；unknown 的 value 必须 null，其余使用相应日期格式。观察时间不冒充生效时间，未知目的地保留 null。更名使用现有 `get_enterprise_profile` → `patch_enterprise_profile`（确认 `previousName:{name:精确旧名,sameSubject:true}`）；不造 `renamed` 事实类型，也不从地址或别名推断迁移。

每次提交后精确读取该企业 facts，核对回执 `factId/version`、完整 source、时间精度、状态、替换关系与审计 actor/basis。当前 version 若因后来命令或历史重放已变化，查看完整历史，不能将 receipt.version 当当前 head。更正和撤回不删除旧审计，差异解释替换也不撤销独立事实。

## 一个解释引用多个已确认事实

先读当前差异决定的 `versionId`（首次为 null；撤回后的 current 为 null，versionId 仍为撤回版本）。再读同一企业的事实，从 **当前 confirmed** 行中选择多条，逐条固定：

```json
[
  {"enterpriseId": 17, "factId": 1, "revision": 2, "kind": "moved_out"},
  {"enterpriseId": 17, "factId": 2, "revision": 2, "kind": "cancelled"}
]
```

将数组放在 `decision.factReferences`（最多100条），不是命令顶层。完整外部命令示例：

```js
const scope = { enterpriseId, titleCode: 'specialized_sme', direction: 'missing_in_miit' }
const head = await call('get_current_difference_decision', scope)
const readback = await call('get_enterprise_facts', { enterpriseId })
const refs = confirmedFactReferences(readback, selectedFactIds)
const command = {
  ...scope, action: 'replace', expectedCurrentId: head.versionId,
  idempotencyKey, actor: { type: 'agent', id: agentId },
  basis: reviewedBasis, ruleVersion: reviewedRuleVersion, effectiveAt,
  decision: {
    status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'none',
    verificationStatus: 'confirmed', factReferences: refs,
  },
}
const { receipt, version } = await saveReferencedDecision(call, command)
```

原因、措施与生效时间由代理根据本案证据明确选择，示例的 platform_stale 不作为默认答案。没有支持确定原因的证据时保持待核，使用既有状态/原因规则。首次解释和追加更正使用同一协议；factReferences 可省略以兼容旧决定，旧空引用不自动补成事实。

提交前选中的事实如有变化，服务端拒绝 stale/pending/withdrawn/replaced、错 kind 或跨企业引用。读回 `get_difference_decision({id:receipt.versionId})`，逐项比较 pins；然后用差异列表/企业详情核对同一坐标的引用。后续事实更正或撤回，历史决定中的 pins 仍指向当时版本，不随事实最新 head 漂移。需要新解释时由代理重新审查并追加决定，不能重写旧 pins。

## 失败与重试

- 响应丢失或网络结果未知：先读回，保存第一次失败；只重放原 `enterpriseId/request/planHash` 与原幂等键。历史重放返回原回执，不重复插入。差异决定重放也保留完整原命令。
- CAS/plan 冲突：重新读取，交操作者重新判断新状态；明确的新意图使用新幂等键并重新预检。不能在后台刷新 expectedVersion、换新键后自动继续旧动作。
- 同一幂等键换载荷会冲突；不要改 basis、source、pins 或 actor 后仍称原请求重试。
- MCP 同时检查协议异常与 `isError`，错误不是业务数据。鉴权失败不降级成匿名写入，查询失败不写成零记录。

可复用函数见[实际 MCP 载荷示例](../examples/enterprise-facts.mjs)。这些函数只做命令冻结、显式提交与读回，不自动确认、不自动重试、不替代理决定原因。调用者负责在提交前持久保存 prepared/command，在读回后独立核查来源和业务含义。完成报告分开列 collected、断言 pending/confirmed、更正/撤回、决定版本与 pins、有效查询/导出是否另行验证；不能用采集或保存回执代替后者。
