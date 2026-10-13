# 02 — 把现有 22 个文件按 tus 规则重传验证

**What to build:** 把 `app/files/` 现有 22 个内化文件,经 tus 端点重新上传,断言落到**规则路径**且内容一致——证明两条写入路径(脚本内化 vs tus 上传)规则相同。

**Blocked by:** 01

**Status:** ✅ done(2026-10-14)

- [ ] 脚本/测试:遍历 `app/files/**`,按 metadata(`source/kind/year/batch/filename` 从路径反推)走 tus 上传
- [ ] 断言每个文件落到 `files/<source>/<kind>/<year>/<batch>/<filename>`,内容逐字节一致
- [ ] 同名冲突:上传到已有同名 → 落到 ` (n)`,原文件不动
- [ ] 打印:22 个文件的上传结果清单
- [ ] 清理测试产物(不污染真实文件库)
