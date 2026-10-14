# `public/` — 静态资源

## `pdfium.wasm`

PDF 预览用的 pdfium 引擎,由 EmbedPDF 加载。

**为什么要手动放在这儿**:库的默认 wasm 地址是公网 CDN
(`https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@<版本>/dist/pdfium.wasm`)。
这是个政务内网工具,不该在运行时依赖公网,所以复制一份到本地,
由 `components/preview/PdfPreview.vue` 通过 `wasmUrl` 指过来。

**升级 `@embedpdf/*` 时必须同步换掉这个文件**,否则 JS 与 wasm 版本会不一致:

```bash
cp node_modules/.pnpm/@embedpdf+pdfium@<版本>/node_modules/@embedpdf/pdfium/dist/pdfium.wasm public/pdfium.wasm
```

当前版本:`@embedpdf/pdfium@2.15.1`(4,646,932 字节)。

> 注意:`wasmUrl` 必须是**绝对地址**。相对路径会让查看器卡在「Initializing plugins…」——
> 引擎在 blob URL 的 worker 里取 wasm,worker 的 origin 不透明,相对路径解析不到。
