# 文件预览组件

四个预览器,一套外壳。给台账详情页的「出处」用:点一条出处,直接看那份公布文件,
不用先下载再找桌面版 Office 打开。

**当前状态:组件已完成并逐项验证,尚未接入任何页面。**

## 用什么

| 格式 | 实现 | 依赖 |
| --- | --- | --- |
| `.docx` `.xlsx` `.pptx` | 画布渲染,连续滚动 | [`@silurus/ooxml`](https://github.com/yukiyokotani/office-open-xml-viewer) |
| `.pdf` | 自带完整界面,主题映射到项目 token | [`@embedpdf/vue-pdf-viewer`](https://github.com/embedpdf/embed-pdf-viewer) |
| `.png` `.jpg` `.webp` `.gif` `.avif` `.bmp` `.svg` | 自研,无第三方 | — |
| `.doc` `.xls` `.ppt`(旧版二进制) | 不预览,给一句说明 | — |
| `.pptx` `.png` `.jpg` … | 组件支持;但当前文件库只内化 PDF/DOC/XLSX,暂无实例 | — |

## 怎么用

```vue
<!-- 父级要给一个确定的高度:组件撑满容器,自己不定高 -->
<div class="h-[80vh] flex min-h-0 flex-col">
  <FilePreview :src="`/api/files/${evidence.sourceFile}`" :name="文件名" />
</div>
```

`src` 是地址、`name` 是工具栏标题。类型按扩展名判断,调用方不用管背后是哪个库。

## 组件

| 文件 | 作用 |
| --- | --- |
| `FilePreview.vue` | 入口。按扩展名分派,不支持时给出说得清原因的说明 |
| `PreviewToolbar.vue` | 共用工具栏:文件名、页码、缩放、旋转、全屏、下载 |
| `PreviewStates.vue` | 加载态与错误态 |
| `OfficePreview.vue` | Word / Excel / PPT |
| `PdfPreview.vue` | PDF |
| `ImagePreview.vue` | 图片 |
| `UnsupportedPreview.vue` | 打不开的文件(仍保留工具栏,便于下载) |
| `lib/preview.ts` | 类型解析、文件名处理、错误翻译 |
| `server/api/files/[...path].get.ts` | 按出处路径读来源文件(带越界防护) |

## 几个定下来的做法

**工具栏是自己搭的,不是库自带的。** Word / Excel / PPT 那三个库只画到画布,没有外壳;
PDF 那个自带完整界面。所以共用外壳里:Office 和图片用我们的工具栏,PDF 保留它自己的
工具栏(它带缩略图、搜索、文字选择,重做一遍不值得),只在上面补文件名和下载。

**PDF 的主题映射到项目 token。** EmbedPDF 的 `ThemeConfig` 接受语义色覆盖
(`accent.primary`、`surface`、`border`…)。`PdfPreview` 把项目的 CSS 变量读出来喂给它,
并跟着深浅主题重建,所以它不会在藏青界面上糊一块灰色控件。

**PDF 关掉批注与密文。** 这是查阅工具,只读。开着会让人以为改动能存回原文件。

**页码会变,不锁死第一次的值。** 渐进布局先按估算高度给一个总页数,真实页面测量完再收敛
(实测同一份 docx 会从 61 收到 32)。`syncCount` 每次回调都覆盖,并把当前页夹在范围内。

**总页数与容器宽度有关。** 这是分页查看器的固有行为,不是 bug。

**缩放在图片上围绕指针、在按钮上围绕中心。** 都围绕左上角的话,一放大内容就跑出画面。

**只有内容真超出容器时才允许拖。** 没超出就居中、光标是默认箭头,不做成「能拖但拖不动」。

**旧版 Office 格式单独给说明。** `.doc` / `.xls` / `.ppt` 在经信局名单里确实存在
(如「关于公布2023年宁波市“专精特新”中小企业名单的通知.doc」),但 OOXML 查看器只认
zip 容器格式。与其让它掉进「未知格式」,不如直说「旧版 DOC 是二进制格式……请用桌面版 Office 打开」。

## 文件接口

`GET /api/files/<路径>` —— 路径与记录里 `record_evidence.source_file` 同形,即**相对文件库
`app/files/`** 的路径(约定见 `files/README.md`),如
`jxj/announcement/2024/1/甬经信中小〔2024〕72号….pdf`。

文件库是 app 内的既有设施(由 pipeline 的 `build:files` 生成),预览只是它的一个消费方:

- **锁根**:相对 `FILES_ROOT`(默认 `<cwd>/files`,与 `db/client.ts` 用 `process.cwd()` 同一口径;
  `FILES_ROOT` 可覆盖)解析,解析结果必须仍在根内。用 `resolve` 后比前缀,不是字符串过滤 `..`。
- **白名单扩展名**:只放预览支持的那几种,不做通用文件服务器。
- **只读**:只实现 GET,与 tus 上传的写入面分开。
- 支持 range 请求(PDF 查看器会发),带长缓存。

验证结果:越界 → 403,不在白名单(如 `README.md`)→ 415,不存在 → 404,
可预览格式 → 200 且 MIME 正确、range 返回 206。

**没动 `nuxt.config.ts`。** 最初为「文件在 app 之外」加过一个 `runtimeConfig.filesRoot`,
文件库落到 app 内之后不再需要,已撤掉。

## 动效

- 工具栏按钮按下 `active:scale-[0.97]`(全站一致)
- 内容就绪时一次 200ms 淡入(`.preview-ready`)—— 文件是异步读的,直接「啪」地出现太突兀;
  只做透明度不做位移,免得干扰阅读
- 图片拖拽时关掉过渡(跟手),松开恢复
- `prefers-reduced-motion` 下全部直接到位

## 自检台

`preview-harness/preview.vue` —— 用真实文件跑四个预览器,看状态与交互对不对。
是 scratch,没有放进 `pages/`。要用时复制过去:

```bash
cp .scratch/ui-redesign/preview-harness/preview.vue pages/__preview.vue
# 访问 http://localhost:3000/__preview,用完删掉
```

里面的用例覆盖:四种格式、加载中、404、旧版 .doc、路径越界,以及容器高度切换。

## 已知取舍:PDF 是两行头部

EmbedPDF 自带完整工具条(缩略图/搜索/批注/文字选择),而它**没有**文件名、下载、全屏,
所以我们的工具栏补的是这几样,不是重复它的缩放与翻页。结果是 PDF 头部比其他三个多一行。

合并成一行需要替换它的整套 UI schema,而 `viewerUISchema` **没有导出**(只导出类型),
只能从零写一份完整 schema;或者放弃它的界面走 headless 自己搭。两条路都比「预览组件」
这件事本身重,所以先让它读上去是**一个两行头部**(同色底、去掉中间的分隔线)而不是两条工具栏。

已顺手关掉只读定位下不该出现的入口:`annotation` / `redaction` / `insert` / `form` /
`signature` / `stamp` —— 工具栏上的「插入 / 表单」两个模式页因此不再出现。

## 未做

- **没接入任何页面。** 详情页「出处」目前还是一个折叠面板,列文件名与序号。接进去是下一步。
  文件库与接口已就绪,接入只需把 `evidence.source_file` 拼成 `/api/files/<path>`。
- **`.doc` / `.xls` / `.ppt` 不支持。** 需要服务端转成 OOXML 或 PDF 才行,属另一件事。
- **PDF 界面是英文为主。** EmbedPDF 的 i18n 需要传入完整的 `locales` 字典(没有内置 zh-CN),
  这是「接入页面」时该一起做的事。
- **字体回退关掉了**(`fontFallback: null`)。默认走 jsDelivr CDN,内网环境不该挂在这种跨域请求上。
  代价是 PDF 里少数生僻字形可能用替代字体。

## 与另一会话的协作(2026-10-14)

同一个 app 仓库里有另一个会话在做 **tus 上传**(同分支 `feat/tus-uploads`)。两件事的重叠点已经收敛:

- 它建了 **File Store**(`app/files/`,`files/README.md` 有约定,由 pipeline 的 `build:files` 生成)。
  预览是它的消费方:**路由根目录直接用它**,原本为「文件在 app 之外」写的
  `runtimeConfig.filesRoot` 已撤回,`nuxt.config.ts` 保持干净。
- 它的 `files/README.md` 写「app 据此解析并预览/打开」—— 预览那半就是这个路由,
  它不再另写文件读取端点(已确认)。
- `package.json` / `pnpm-lock.yaml` 里同时有预览依赖与 tus 依赖(后者是它票 01 的代理误跑落到父工作树的)。
  这两个文件由它合并时统一收口,预览这边不再动。
- 记录里的 `source_file` 目前还是旧路径形态;它负责重导成相对 `files/` 的新形态(票 03)。
  重导前,旧记录点开会 404 —— 预览器对这种情形有明确错误态,属预期。
- **未提交。** 预览与 tus 的改动都还在工作树里,等用户决定由谁提交。
