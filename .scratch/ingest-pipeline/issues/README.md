# 入库管线重整 — 工单

来自 [SPEC.md](../SPEC.md)。**三期**;每期独立可验收。

| 期 | # | 标题 | 归属 | Blocked by | 状态 |
|---|---|---|---|---|---|
| 一 | 09 | 文件管理页 + 文件表(统一管理现有 23 + 上传) | app | — | **implemented**(待复核 + oil-ui) |
| 一 | 10 | 上传/元数据:tus 接入页面 + 手动设来源/年份/批次 | app | 09 | ready |
| 一 | 11 | 代理只从「已上传文件」解析(不再扫数据根) | pipeline | 09 | ready |
| 一 | 12 | 分类回写:文件未设分类时由程序/代理补 | app+pipeline | 10,11 | ready |
| 二 | 13 | PDF → PNG(PDFium 渲染 + sharp)并关联页图 | app | 09 | ready |
| 二 | 14 | OCR 三通路(API 优先/上传结果/MCP)+ 结果入库 + markdown | app+pipeline | 13 | ready |
| 三 | 15 | 缺统代联网补齐(带出处) | pipeline | 11 | ready |
| 三 | 16 | 平台两接口:解释差异(外地/注销/外迁) | pipeline+app | 09 | ready |

**前沿**:09 已实现(待复核);复核合入 `main` 后,前沿开 **10 / 11 / 13 / 16**。

## 依赖

```
09 ─▶ 10 ─▶ 12
 │    │
 │    └▶ 11 ─▶ 14 ─▶ 15
 └▶ 13 ─▶ 14
 └▶ 16
```

## 给实现者的硬约束

- **按 `implement-spec` 的流程推进**(用户点名要它,**因为它会触发审核验收**):读规格 → 实现 → 自查 → **独立评审** → 提交;实现完**不要自称「已完成」**,把「已完成 / 未完成 / 已知缺口」分开列。
  > ⚠️ **`implement-spec` 带 `disable-model-invocation: true` —— 代理自己加载不了**(Skill 工具会直接拒绝),**只有用户**在该会话里发 `/implement-spec` 才进得来。票 09 的会话就卡在这里空等过。
  > **所以别空等**:要么用户在会话里发一次 `/implement-spec`;要么**照它的流程做**,独立评审那一步用 `code-review` 技能(票 09 就是这么做的:Standards + Spec 两轴,已采纳并修 9 处)。
- **UI 一律 shadcn-vue 官方组件**;不得手写或原生 `<table>/<input>/<select>`;沿用 `DESIGN.md` 的 token。
- **凭证(token / cookie)不入库**:走页面配置或 `NUXT_*` 环境变量;仓库只留 `.env.example` 占位。
- **身份判定守 [data-integrity 安全阀](../../data-integrity/SPEC.md)**:单一来源不得触发归并;拿不准 → 空值 + 标记。
- app `pnpm typecheck && pnpm test`、pipeline `vp check && vp test` 必须全绿。
- **同仓一次只跑一个会话**;分支从干净 `main` 起;只提交本票文件。
- **凡是涉及页面的票,实现后都要另派 `oil-ui` 会话验收**,直到合格 —— 实现会话别自己判自己过。
  这是**规则,不是名单**:只要这张票动了 `pages/`、组件或任何用户可见的界面,就过 oil-ui;
  只动 pipeline / 脚本、界面零变化的票(如 11、15)不必过。
  > 本批按此规则:**09 · 10 · 12 · 13 · 14 · 16 需 oil-ui 验收**;**11 · 15 不需要**。
  > (上一版我把它写成固定名单,漏了 12 —— 因为 12 也改 `/files` 页。规则比名单可靠。)

## 交付节奏(主代理执行)

```
一张票 → 派一个实现会话(带 implement-spec)→ 主代理独立复核(不采信自述)→ 合入 main → 下一张
                                                                    └─ 涉及页面的票 → 再派 oil-ui 验收
```
派出去的会话**用与主代理同一个模型**(`magpie` / `group/auto-deepseek-v4-1-flash[1m]`)。
