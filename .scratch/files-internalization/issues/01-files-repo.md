# 01 — 建文件库目录与规则(app 内)

**What to build:** 在 **app 仓库**内建 `app/files/` 目录,确立规则 `files/<source>/<kind>/<year>/<batch>/<filename>`,写入 `files/README.md`(规则、命名、来源映射)与 `app/.gitattributes`(二进制标注)。**不新建仓库**(app 已有)。

**Blocked by:** None — can start immediately.

**Status:** ✅ done(2026-10-14)

- [ ] `app/files/` 目录 + `files/README.md` 说明规则
- [ ] 规则文档:`jxj|miit` / `announcement|export` / `year` / `batch` 的取值与来源
- [ ] `.gitattributes` 标注二进制文件
- [ ] 不内化 `*.docx`(人工 OCR,排除)
