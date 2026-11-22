-- runtime_logs schema 目录注释：表与字段的中文说明。
-- 仅元数据，不改变列、约束、索引或数据；COMMENT ON 可重复执行。
-- 新建库由 bootstrap.sql 引用，已有库由 upgrade/pg/2026-11-catalog-comments/apply.sql 引用。

COMMENT ON TABLE runtime_logs.log_policy IS '运行日志保留策略，固定单行。';
COMMENT ON COLUMN runtime_logs.log_policy.id IS '固定为 1 的单行标记。';
COMMENT ON COLUMN runtime_logs.log_policy."retentionDays" IS '日志保留天数，取值 1 至 365。';
COMMENT ON COLUMN runtime_logs.log_policy."maxBytes" IS '日志容量上限（字节），取值 1048576 至 4294967296。';
COMMENT ON COLUMN runtime_logs.log_policy.pruned IS '累计因保留期清理的事件数。';
COMMENT ON COLUMN runtime_logs.log_policy.cleared IS '累计因手动清理的事件数。';
COMMENT ON COLUMN runtime_logs.log_policy.logical_bytes IS '当前已存事件的 JSON UTF-8 字节总量。';

COMMENT ON TABLE runtime_logs.log_collection IS '日志集合版本，用于让客户端感知清理与集合变化。';
COMMENT ON COLUMN runtime_logs.log_collection.id IS '固定为 1 的单行标记。';
COMMENT ON COLUMN runtime_logs.log_collection.collection IS '日志集合标识 JSON。';
COMMENT ON COLUMN runtime_logs.log_collection.revision IS '集合修订号，清理或策略变更时递增。';

COMMENT ON TABLE runtime_logs.log_events IS '运行日志事件：每条事件只存一份 JSON 内容。';
COMMENT ON COLUMN runtime_logs.log_events.seq IS '自增序号，用于稳定分页与排序。';
COMMENT ON COLUMN runtime_logs.log_events.id IS '事件 ID，唯一。';
COMMENT ON COLUMN runtime_logs.log_events.timestamp IS '事件发生时间原值。';
COMMENT ON COLUMN runtime_logs.log_events.level IS '日志级别，默认最低为 info。';
COMMENT ON COLUMN runtime_logs.log_events.source IS '技术来源，如 http、mcp 或 task。';
COMMENT ON COLUMN runtime_logs.log_events.module IS '业务模块 id；未归属模块的行为空。';
COMMENT ON COLUMN runtime_logs.log_events.operation IS '操作名称。';
COMMENT ON COLUMN runtime_logs.log_events.outcome IS '操作结果。';
COMMENT ON COLUMN runtime_logs.log_events."requestId" IS '请求 ID。';
COMMENT ON COLUMN runtime_logs.log_events."traceId" IS '链路追踪 ID。';
COMMENT ON COLUMN runtime_logs.log_events."taskId" IS '关联任务 ID。';
COMMENT ON COLUMN runtime_logs.log_events."fileId" IS '关联文件 ID。';
COMMENT ON COLUMN runtime_logs.log_events."batchId" IS '关联批次 ID。';
COMMENT ON COLUMN runtime_logs.log_events."resourceId" IS '关联资源 ID。';
COMMENT ON COLUMN runtime_logs.log_events.detail IS '事件内容 JSON，不重复内嵌上游原始响应。';
