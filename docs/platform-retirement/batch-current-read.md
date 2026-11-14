# 当前名单与导出批量读取

2026-11-14。沿用现有资格规则，优化终态模型的执行方式。

## 读取路径

- 128 家企业为一块，批取企业、三称号事件与出处、别名、文件元数据和主体事实；归并保留祖先事实命名空间。事件逐次复制后补充解析字段，块结束即释放输入。
- 先用原资格评估器判断状态，只为全局有效选项和实际请求状态读取对应关系与认定见证。完整三称号列表响应仅在选中页生成。
- 对应关系源有效性仍在当前快照重新检查；认定见证只预取原行，身份、来源和错误顺序仍由原 owner 判定。
- 查询覆盖按企业、称号分别取最新 51 条，再保留 50 条及 truncated；合并一次读取所需元数据。使用原 coverageOf，不增加资格或覆盖规则。
- 已退役终态检查完成标记，候选请求不重演全库捕获审计。完整审计仍由离线迁移/退役拥有，正常写入受现有捕获和不可变约束保护；未退役过渡阶段继续原检查。

不存在跨请求行缓存或资格结果缓存。计数、选项、分页、完整展示和导出排水均使用调用者同一事务及时点。资格仍须对完整候选集合求值，批量化减少数据库往返，没有把规则复制成第二套 SQL。

## 导出摘要范围

终态正常导出用 `readWorkbookRowsBatch` 只生成该行称号的完整评估，小巨人依赖仍由共享评估器读取并绑定版本。完整三称号公共 T2 和 `readWorkbook` 诊断接口保持原范围。

新导出摘要首帧为 `[current-export-assessment-title-v3, assessmentVersion, ruleVersion, qualificationYear, title]`。后续仍为 `[group,id,scope,snapshotId,values]` 加换行的 JSON 帧；snapshotId 绑定所选称号 assessment，包含实际小巨人依赖的版本，values 是实际输出的全部列。资格评价年按上海资格日确定。历史产物和原 v2 摘要不改写；dataVersion 仍是 opaque SHA256，并非要求跨版本相等的业务结果。

## 验证

| Requirement | Evidence |
|---|---|
| 完整评估、导出字段及提交后刷新 | `keeps full three-title snapshots and workbook cells exact with bounded input reads and fresh commits` |
| 列表条件、全局计数/选项、分页及实际 XLSX | `preserves filters counts options pagination and export cells while batching the native consumer` |
| 每称号独立排序、50 条上限及截断 | `preserves per-title query limits ordering and fresh metadata through batched coverage` |
| 块级 SQL、归并祖先事实、终态免全表审计 | `bounds foundation SQL by block and retains merged ancestor exclusions without auditing every observation` |

以上四项及相邻资格、工作簿、覆盖回归共 38 PASS。服务器类型诊断与优化前 26 条精确相同；不是全仓类型通过。

真实历史目标库复用上一轮已逐成员验证的归档，只恢复一份权威副本。基线是 `f604f282`，同库、同机、固定时点核心查询交替 3 轮；18 次完整响应字节一致，三份工作簿全部 20 张表逐格一致。终态正常导出的摘要范围按上述 v3 显式变化，行内容不变。最终构建及真实打包 HTTP/MCP/导出 worker 另有运行记录。

完整性能、首次失败和清理记录位于仓外：`/Users/mang/.t3/acceptance/platform-complete-migration/batch-current-optimization/`。不把核心计时当成 HTTP 等待，不把这份 11 月 10 日历史备份当作当前生产数据。全套测试、CI 和生产操作未执行。
