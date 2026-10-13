# 02 — 迁移脚本:把来源文件按规则拷入文件库

**What to build:** pipeline 内新增脚本 `build:files`,读 `--root` 下的源文件,按规则复制/改名到文件库,幂等可重跑。

**Blocked by:** 01

**Status:** ✅ done(2026-10-14)

- [ ] 经信局:扫 `经信局名单/**` 的 **PDF 与 .doc**(排除 `*.docx`),按 `jxj/announcement/<year>/<batch>/<原文件名>` 落库
- [ ] 工信部:三份 Excel 按 `miit/export/<原文件名>` 落库
- [ ] year/batch 取自公布文件(文件名/段标题),非目录名
- [ ] 幂等:重复运行不产生重复文件
- [ ] 打印清单:各来源落库文件数、跳过(含 .docx)数
- [ ] 测试:小型 fixture 目录 → 断言目录结构与文件名符合规则
