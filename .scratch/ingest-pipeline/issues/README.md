# 入库管线重整 — 工单

来自 [SPEC.md](../SPEC.md)。**三期**;每期独立可验收。

| 期 | # | 标题 | 归属 | Blocked by |
|---|---|---|---|---|
| 一 | 09 | 文件管理页 + 文件表(统一管理现有 23 + 上传) | app | — |
| 一 | 10 | 上传/元数据:tus 接入页面 + 手动设来源/年份/批次 | app | 09 |
| 一 | 11 | 代理只从「已上传文件」解析(不再扫数据根) | pipeline | 09 |
| 一 | 12 | 分类回写:文件未设分类时由程序/代理补 | app+pipeline | 10,11 |
| 二 | 13 | PDF → PNG(PDFium 渲染 + sharp)并关联页图 | app | 09 |
| 二 | 14 | OCR 三通路(API 优先/上传结果/MCP)+ 结果入库 + markdown | app+pipeline | 13 |
| 三 | 15 | 缺统代联网补齐(带出处) | pipeline | 11 |
| 三 | 16 | 平台两接口:解释差异(外地/注销/外迁) | pipeline+app | 09 |

**前沿**:09(一期起点,其余多依赖于它)。

## 依赖

```
09 ─▶ 10 ─▶ 12
 │    │
 │    └▶ 11 ─▶ 14 ─▶ 15
 └▶ 13 ─▶ 14
 └▶ 16
```

## 给实现者的硬约束

- **UI 一律 shadcn-vue 官方组件**;不得手写或原生 `<table>/<input>/<select>`;沿用 `DESIGN.md` 的 token。
- **凭证(token / cookie)不入库**:走页面配置或 `NUXT_*` 环境变量;仓库只留 `.env.example` 占位。
- **身份判定守 [data-integrity 安全阀](../../data-integrity/SPEC.md)**:单一来源不得触发归并;拿不准 → 空值 + 标记。
- app `pnpm typecheck && pnpm test`、pipeline `vp check && vp test` 必须全绿。
- **同仓一次只跑一个会话**;分支从干净 `main` 起;只提交本票文件。
