# 候选来源重新核验

#570 授权扩展既有对应 preflight/commit（含同源浏览器适配器及共享 MCP dispatcher）。无需迁移，不改变资格或年度最终结果规则。

新增 operation：`{ action: 'revalidate', correspondenceId, expectedRevision }`。仅当前 candidate 且来源指纹变化可执行；保持 candidate，revision 加一。不同于 confirmed 的同边 correct，也不借用 rejected 重提或 unlinked 状态。未变化来源返回 ambiguous_candidate，非候选返回 invalid_endpoint_type，旧修订返回 stale_revision。

预检绑定旧修订、旧指纹、当前指纹与目标身份；提交事务重新构造计划，预检后再变来源拒绝。现有鉴权、来源身份约束、proof 确认门禁、planHash 和幂等账本不变。重核只绑定来源，不赋予 proof 授权；后续确认仍须满足原确认约束。

事务更新当前 provenance/fingerprint，追加 candidate→candidate 审计（新 provenance）。原 candidate 登记及后续所有审计不改，保留旧来源；不修改平台原行、正式事件或历史决定。重试同键同载荷返回原回执，同键异载荷拒绝。

公共 detail/list/summary 的 requiresRevalidation 现在也检查 candidate。分页仍不加载候选历史 provenance，仅按本页所需当前来源计算；轻量 reverse refs 的既有 confirmed 有效性语义保留，候选页面通过 detail GET 读取重核状态。

UI 明确提供“重新核验候选”，409 后保留草稿进入该动作。重核读回后仍须另选确认对应或不对应。冻结请求、未知提交恢复、公开审计读回与草稿锁沿用原机制。
