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
