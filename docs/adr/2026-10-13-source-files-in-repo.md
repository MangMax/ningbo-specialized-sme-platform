# 来源文件内化为仓库内的文件库(File Store)

> 状态（2026-10-25）：部分替代。来源文件、上传件、业务数据库与凭据在 Git 外，下文“文件随 app 仓库版本控制”不再适用；配置文件库根及出处相对路径的口径仍保留。路径不是文件内容身份，后续内容版本/出处保护见[待审分域 ADR](0001-source-domain-boundaries.md)，已实现能力见[总览](../data-model.md)。下文保留历史原文。

经信局公布文件与工信部导出不再散在数据目录顶层,而是**内化进 app 仓库**(`20261013/app/files/`);`record_evidence.source_file` 指向**文件库内相对路径**;app 用一个 Nitro 路由把它读出来预览/下载。

**为什么:** 文件系统**属于 app** —— 看板要预览它、以后要往里上传;而 pipeline 只是**后续往它里面导入**(见 [ADR-数据入库是项目外的前期工作](./2026-10-13-ingestion-is-outside-the-app.md))。现状下源文件不在任何仓库里,出处路径解析不到文件,看板点不开、换机器就丢。

**为什么不放 `public/`:** `public/` 会被 `nuxt build` 烘进 `.output/public`,**只读**,以后接 tus 上传写不进去。故放 app 顶层 `files/`(与 `public/`、`server/` 平级的数据目录),由 `server/routes/files/[...path].get.ts` 读取回吐;路径走 `runtimeConfig.filesDir`(`NUXT_FILES_DIR`),不写死。

**目录规则(服务后续导入导出)**:`files/<source>/<kind>/<year>/<batch>/<filename>`

- `source`:`jxj`(经信局)/ `miit`(工信部);`kind`:`announcement`(公布文件)/ `export`(导出表)。
- `year`/`batch` 取自公布文件本身(非目录日期);导出表无批次则省略。
- 文件名保留原样(含文号),便于人读与回溯。

**内化范围**:经信局的 **PDF 与 `.doc`**、工信部的 **Excel**。**不内化**与 PDF 同名的 `.docx` —— 那是人工 OCR 的产物,后续由「从 PDF 自动提取」替代。

> ⚠️ **2026-10-16 修正**:上面这条「内化范围」判定自 [ADR-文件库入库范围](./2026-10-16-file-store-scope.md)(RL-16)起以那份为准 ——
> 重复的 `.doc`(同目录已有可预览的 `.docx`)与入库培育文件**一律不入库**。
> **上文的目录规则与 `source_file` 口径不变。**

**后果:** 出处引用从「相对数据根」改为「相对文件库根」(`app/files/`),由 Nitro 路由解析为 URL;`.doc`/`.xlsx` 浏览器只能下载,PDF 可内联预览;文件随 app 仓库版本控制(≈114M)。pipeline 后续的导入把文件写进同一目录。
