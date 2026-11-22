\set ON_ERROR_STOP on
-- 为现有 PostgreSQL 库补齐 business 与 runtime_logs 的表、字段中文目录注释。
-- 只写 COMMENT 元数据，可重复执行；注释正文与新建库共用 db/postgresql 下的同一份文件。
\ir ../../../db/postgresql/business-catalog-comments.sql
\ir ../../../db/postgresql/runtime-log-catalog-comments.sql
