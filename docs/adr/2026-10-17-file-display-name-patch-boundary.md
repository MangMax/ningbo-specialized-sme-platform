# 文件显示名 PATCH 的边界

**状态：** 已采纳（RL-10）

## 背景

文件管理需要修正用户看到的名称。[只读看板 ADR](./2026-10-13-readonly-board-first.md) 约定每条新增写路径单独记录边界；本决策覆盖文件 API 的 `displayName` PATCH。

## 决策

- PATCH 只更新 `stored_file.display_name`，不改 `stored_file.id` 或 `stored_file.rel_path`。
- 原磁盘文件名、源文件字节、页图、OCR 结果和出处引用保持不变；本操作不移动或重命名磁盘文件。
- 每次实际显示名变更追加一条审计记录。新显示名与当前显示名相同时是 no-op，不追加审计记录。
- TUS 只负责文件传输，不作为文件的持久身份；持久身份由 `stored_file.id` 标识。

## 后果

界面和文件 API 可以同时展示用户可读的 `displayName` 与原始磁盘 `filename`。页图、OCR、出处和下载仍通过稳定文件身份/路径指向原内容。
