# 05 — tus 断点续传接入调研(仅调研,不改实现)

**What to build:** 出一份调研结论:在 Nuxt 4(SPA + Nitro)里接入 **tus** 上传的可行方案、推荐库与最小验证。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 主流方案对比(`tus/server` + `@tus/file-store`、`uppy`、`tus-js-client`;Nitro 兼容性)
- [ ] 最小 PoC:在本地起 tus 端点,用 curl/tus-js-client 完成一次分片续传
- [ ] 结论:可行性、集成点、对文件库目录规则的影响、注意事项
- [ ] 产出 `reports/tus-research.md`(不合并任何 tus 代码到主线)
