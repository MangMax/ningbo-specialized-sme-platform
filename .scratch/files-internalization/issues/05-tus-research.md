# 05 — tus 断点续传接入调研(仅调研,不改实现)

**What to build:** 出一份调研结论:在 Nuxt 4(SPA + Nitro)里接入 **tus** 上传的可行方案、推荐库与最小验证。

**Blocked by:** None — can start immediately.

**Status:** ✅ done(2026-10-14)

- [x] 主流方案对比(`tus/server` + `@tus/file-store`、`uppy`、`tus-js-client`;Nitro 兼容性)
- [x] 最小 PoC:在本地起 tus 端点,用 curl/tus-js-client 完成一次分片续传
- [x] 结论:可行性、集成点、对文件库目录规则的影响、注意事项
- [x] 产出 `reports/tus-research.md`(不合并任何 tus 代码到主线)。— **位置与措辞按事实更正**：调研产物实际落在**项目根** `20261013/.research/tus-research.md`（在 app 仓库**之外**，故不在 app main 的树里；`server/middleware/tus.ts` 注释亦引其 §2.5）。「不合并任何 tus 代码到主线」是**本调研票自身的范围约束**（不改实现）；tus 实现此后由**独立三票 `.scratch/tus-uploads/`（01/02/03）**合入主线，两者不矛盾。

> **收口（2026-10-15，docs-only）**：4 项已满足；位置与「不合并」两句已按实物与后续独立票更正。
