# 13 — PDF → PNG(PDFium 渲染 + sharp)并关联页图

**What to build:** 把扫描 PDF 的每一页渲染成 PNG,存进文件库,**并建立「页图 ↔ 源 PDF」的关联**(供票 14 的 OCR 用)。

**Blocked by:** 09

**Status:** ready

## 做什么

1. **渲染**:用户点一下(或批量)把 PDF 逐页渲染成像素。**PDFium 负责渲染像素**(app 已依赖 `@embedpdf/vue-pdf-viewer`,其引擎即 pdfium;也可用 `@embedpdf/pdfium` 直接调)、**sharp 输出 PNG**(需新增依赖 `sharp`)。
   > 注:`sharp` 是**原生模块**,要进 `pnpm-workspace.yaml` 的 `allowBuilds`(见本机 pnpm 约束)。
2. **落盘**:`files/<...>/<文件名>.pages/p001.png` 之类(具体规则见本票实现时定,写进 `files/README.md`)。
3. **关联**:`stored_file` 增加页图关系(新表 `stored_page_image`:`file_id` / `page_no` / `rel_path` / `w` / `h`)—— **页号是权威**,票 14 的 OCR 结果按 `page_no` 回填。
4. **分辨率**:给个够 OCR 的默认(如 200–300 DPI),页面可调。

## 为什么单独一票

渲染是**纯本地、无凭证**的一步,和 OCR(要走外网/需要 token)分开:渲染失败不该连带 OCR 的复杂度,OCR 换通路也不该动渲染。

## 测试

- [ ] 对一个多页 PDF 渲染 → 页图数 == PDF 页数;`stored_page_image` 行数一致、`page_no` 从 1 连续。
- [ ] 重复渲染**幂等**(同内容不重复写)。
- [ ] 大页数(如 97 页)不 OOM。

## 验收

- [ ] 页面上能看到某份 PDF 的页图缩略。
- [ ] app 测试全绿。

**分支**:`feat/pdf-to-png`。
