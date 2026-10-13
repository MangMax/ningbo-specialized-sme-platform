# 06 — `.doc` 转为可预览格式(`.docx` / PDF)

**What to build:** 文件库里那 2 份旧版 `.doc`(2023 年两份名单)在浏览器**预览不了**(二进制格式,读取路由返回 415),只能下载。用 LibreOffice headless 转成 **`.docx` 或 PDF** 落回文件库,并把引用它们的 `record_evidence.source_file` 指向新产物。

**Blocked by:** 03(出处路径);依赖事实见下。

**Status:** ready-for-agent

## 事实(已核实)

```
record_evidence 里 .doc 引用:962 行 / 2 个文件
  jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.doc          (676 行)
  jxj/announcement/2023/1/关于公布2023年第一批宁波市创新型中小企业名单的通知.doc          (286 行)
```
- 这 2 份**源目录里没有同名 PDF**(只有 `.doc`),所以「解析成 PDF 指向」不适用。
- 浏览器端 OOXML 查看器无法渲染 `.doc`(非 zip 容器);预览器对 415 有**有意的说明态**(「旧版 DOC……请用桌面版 Office 打开」),**不要**为它们特判。

## 可行性(已实测)

- **LibreOffice 已装**:`/opt/homebrew/bin/soffice`(26.8.1)。两份 `.doc` 实测转换成功、<1 秒/份,产物是合法 OOXML(magic `504b0304`)。
- **备选:macOS 自带 `textutil`**(零依赖):`textutil -convert docx -output out.docx in.doc`;跨平台仍以 LibreOffice 为准。
- 两份都是**真文本、无图片**(`word/media/` 空),转换后能正常渲染。

## 两条必须写明的坑

1. **这两份 `.doc` 是 OCR 产物,不是原始公文**(元数据 `Subject = OCR_RT`)。其中 78 号那份**末尾有 OCR 残留串号**(如 `-819157429504490085750570抄送:…-127635476885`)。转换只解决「能不能预览」,不解决 OCR 质量 —— 验收写「**可预览、内容可读、残留串号另行清理**」,不要写「渲染正确」。
2. **文件名不含文号**,正文里才是 `甬经信中小〔2023〕78号` / `〔2023〕77号`。按「文件名原样保留」约定落地即可;改 evidence 路径时**别按文号去找文件**。

## 做法(二选一)

1. **转 `.docx`(推荐,体积小)**:`soffice --headless --convert-to docx`(pipeline 已在 `.doc` 解析时用过这个),产物落 `files/jxj/announcement/2023/1/*.docx`;把 evidence 路径改指 `.docx`,重导。
2. **转 PDF**:同上转 `pdf`,指向 PDF(可内联预览)。

## 验收

- [ ] 2 份 `.doc` 转出可预览格式,落在文件库同目录
- [ ] `record_evidence` 中这 962 行的 `source_file` 指向新产物,且**能在文件库解析到**
- [ ] 预览路由对这 2 份返回 200(而非 415)
- [ ] 原 `.doc` 保留(不删),作为归档
- [ ] 转换在 pipeline 里可重跑、幂等

> 注:凡是「浏览器能内联预览的格式」都优先;`.doc/.xls/.ppt` 一律需要转换或下载。
