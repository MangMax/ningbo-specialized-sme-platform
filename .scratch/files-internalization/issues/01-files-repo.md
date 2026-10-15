# 01 — 建文件库目录与规则(app 内)

**What to build:** 在 **app 仓库**内建 `app/files/` 目录,确立规则 `files/<source>/<kind>/<year>/<batch>/<filename>`,写入 `files/README.md`(规则、命名、来源映射)与 `app/.gitattributes`(二进制标注)。**不新建仓库**(app 已有)。

**Blocked by:** None — can start immediately.

**Status:** ✅ done(2026-10-14)

- [x] `app/files/` 目录 + `files/README.md` 说明规则
- [x] 规则文档:`jxj|miit` / `announcement|export` / `year` / `batch` 的取值与来源
- [x] `.gitattributes` 标注二进制文件（仓库根 `.gitattributes` 把 `files/**` 的 pdf/doc/docx/xlsx/xls 标 `-text -diff`）
- [ ] 不内化 `*.docx`(人工 OCR,排除)。— **已被用户后续口径取代**：DOCX 现为**权威源之一**，不排除、且作为 Office 直读对象（现终库活跃含两份 `.docx`，见票 17 / 票 07 结论）。原「排除」写法保留于此作历史依据，不勾为「已实现」。

> **收口（2026-10-15，docs-only）**：前三项按仓库实物已满足；末项是**范围被取代**而非实现，故不勾。
