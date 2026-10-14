# 13 — PDF → PNG(PDFium 渲染 + sharp)并关联页图

**What to build:** 把扫描 PDF 的每一页渲染成 PNG,存进文件库,**并建立「页图 ↔ 源 PDF」的关联**(供票 14 的 OCR 用)。

**Blocked by:** 09

**Status:** ✅ **done**(后端 `feat/pdf-to-png` 已合入;页面在 `feat/pdf-page-gallery-closeout`)。
见文末「实现记录」。**未做且明确不做**:`stored_page_image` 表 —— 页图**只落盘**,
页号由文件名 `pNNN.png` 与 `.pages.json` 承载(理由见 ADR),要建表的是票 14 自己。

## 做什么

1. **渲染**:用户点一下(或批量)把 PDF 逐页渲染成像素。**PDFium 负责渲染像素**(app 已依赖 `@embedpdf/vue-pdf-viewer`,其引擎即 pdfium;也可用 `@embedpdf/pdfium` 直接调)、**sharp 输出 PNG**(需新增依赖 `sharp`)。
   > 注:`sharp` 是**原生模块**,要进 `pnpm-workspace.yaml` 的 `allowBuilds`(见本机 pnpm 约束)。
2. **落盘**:`files/<...>/<文件名>.pages/p001.png` 之类(具体规则见本票实现时定,写进 `files/README.md`)。
3. **关联**:`stored_file` 增加页图关系(新表 `stored_page_image`:`file_id` / `page_no` / `rel_path` / `w` / `h`)—— **页号是权威**,票 14 的 OCR 结果按 `page_no` 回填。
4. **分辨率**:给个够 OCR 的默认(如 200–300 DPI),页面可调。

## 为什么单独一票

渲染是**纯本地、无凭证**的一步,和 OCR(要走外网/需要 token)分开:渲染失败不该连带 OCR 的复杂度,OCR 换通路也不该动渲染。

## 测试

- [x] 对一个多页 PDF 渲染 → 页图数 == PDF 页数;`page_no` 从 1 连续。
      (**表**改为后续票 —— 本次页图只落盘,没有 `stored_page_image`;见下「未完成」)
- [x] 重复渲染**幂等**(同内容不重复写)。
- [x] 大页数(**97 页**实测)不 OOM:3.3 s、峰值 RSS 275 MB(渲染前 83 MB)。

## 验收

- [x] 页面上能看到某份 PDF 的页图缩略(`/files` → 预览 → 页图);12 张 / 97 张实测见文末第 8 节。
- [x] app 测试全绿:`pnpm typecheck` 通过;`pnpm test` → **22 files / 383 passed**
      (后端那次基线 169 + 26;本轮前端再加 19,见第 8 节)。

**分支**:`feat/pdf-to-png`。

---

# 实现记录(2026-10-14,后端半边)

## 1. 选型:PDFium(wasm)`@hyzyla/pdfium` + `sharp`

**结论**:渲染用 `@hyzyla/pdfium@3.0.0`(PDFium 的 wasm 构建,Node 侧封装),PNG 编码用
`sharp@0.35.5`。

**为什么是 PDFium**:app 已依赖 `@embedpdf/vue-pdf-viewer`,它的引擎**就是 PDFium** ——
用同一个引擎,页面上看到的和落到页图上的像素才会一致(字形、字距、取整都同源)。
本票**没有**引入第二种渲染引擎。

**Node 侧怎么调 PDFium —— 三个候选的取舍**:

| 候选 | 结论 |
| --- | --- |
| `@embedpdf/pdfium`(app 那条依赖链上的同一个包) | **弃**。**面向前端**:导出的是 `FPDF_*` **原始 FFI 绑定** —— 自己 `malloc`、自己拿指针、自己管 `FPDFBitmap` 生命周期,`init()` 之前还得自己 fetch wasm。用它等于在本仓库重写一遍「开文档 → 载页 → 建位图 → 取像素」,多出几百行指针代码;而 PDFium 的 C API 用错是**段错误/内存泄漏**,不是测试能兜住的错。同组织的 `@embedpdf/engines` 是**浏览器引擎层**(worker / fetch / 流),不是给 Node 批处理用的。 |
| **`@hyzyla/pdfium`** | **选**。同一个 PDFium 的 wasm 构建,但**面向 Node 的封装**:`PDFiumLibrary.init()` → `loadDocument(buffer)` → `document.pages()` → `page.render({ width, height, colorSpace })`,TS 类型齐、**零依赖**、wasm 随包发布(不走 CDN、不联网)。它的 README 示例就是「位图交给 sharp 出 PNG」,与票 13 的路线逐字吻合。 |
| Node 原生绑定的 pdfium(napi 类) | **弃**。要引原生二进制 + 平台预编译,与 `sharp` 已经要引的原生依赖叠加,本机 pnpm 的构建白名单更长、部署面更宽;wasm 版本项目这个量级(A4、≤300 DPI、≤100 页)实测 **34–37 ms/页**,没有换绑定的理由。 |

> `@hyzyla/pdfium@3.0.0` 是 2026-10-10 发的,过了本机 pnpm 的 24 h release-age 线。
> `sharp`:本机靠 `@img/sharp-{platform}` 预编译包装上,**没有** `install/postinstall` 脚本 ——
> 不放行 `allowBuilds` 也能装。仍按要求加了 `sharp: true`(异平台/源码装时不被静默跳过);
> 这一点与派单时的预期不同,如实记在这里。

**分辨率怎么定**:渲染时**直接给 PDFium 目标像素宽高**(`round(pt / 72 × dpi)`),而不是给
`scale` —— 像素尺寸由我们算定,清单里的数字就是确定值,不受引擎内部取整影响。
默认 **200 DPI**,可传参覆盖,上限 600。

## 2. 落盘规则

```
files/<source>/<kind>/<year>/<batch>/.<文件名>.pages/pNNN.png
files/<…>/.<文件名>.pages/.pages.json
```

规则写在 [`files/README.md`](../../../files/README.md) 的「页图(PDF → PNG,票 13)」。

- **目录名带前导点**是**必须的**,不是审美:文件库扫描器(`server/utils/stored-files.ts` 的
  `scanFileStore`)按「名字以 `.` 开头即跳过」滤掉系统/临时文件。页图是**派生数据**,
  不隐藏的话回填会把上千张 `pNNN.png` 当成独立源文件塞进 `stored_file`,
  **票 09 的文件管理页立刻被页图淹掉**。用前导点让既有规则挡住 —— 比改扫描器安全:
  `server/utils/stored-files.ts` 正是**票 17(`feat/file-parts`)在改的文件**,动它必撞车。
  实测有效:渲染 109 张页图后 `/api/files?rescan=1` 仍是 `total = 23`。
- 目录名取 `.` + **源文件名(含 `.pdf`)** + `.pages`(不是笼统的 `.pages`):同目录多份 PDF
  各归各的,也不会与同名的 `.doc` 撞。
- 页图目录已在 `.gitignore`(97 页那份出 42 MB)。

## 3. 服务端接口

`/api/pdf-pages`(查询参数式;**没有**占用 `server/api/files/**` —— 那是文件回吐路由):

| 方法 | 形状 | 作用 |
| --- | --- | --- |
| `GET` | `?file=<相对路径>[&dpi=200]` | 现状:源页数、已渲染页数、是否与当前源一致、每页尺寸 + 预览 URL |
| `GET` | `?file=…&page=3` | 该页的 PNG 字节(未渲染 → 404 并提示先 POST) |
| `POST` | `{"file":…,"dpi":200,"force":false}` | 渲染整份(幂等),同步返回同形结果 + `written/skipped/removed/elapsedMs` |

用查询参数而非路径段,是因为文件名里全是中文、书名号与空格,塞进路径段要三层编码。
页图的**字节**仍由既有的 `/api/files/[...path]` 回吐(清单里的 `url` 就是它),不另造文件服务器。

## 4. 幂等

判据 = `.pages.json` 里的**源内容 sha256 + 分辨率 + 每页文件尺寸**,外加「目录里没有多余页图」。
四者俱全时**一个字节都不写**(清单/页图的 mtime 都不变,测试钉住)。内容变了或换 DPI 才重渲染,
**原地覆盖**同一批 `pNNN.png`;源页数变少时多余的页图会被清掉。清单**最后**写,
崩在中途不会留下「清单说有、磁盘没有」的假一致;每张 PNG 先写 `.tmp` 再 rename。

内存:**一页一页来**(渲染 → 编码 → 落盘 → `page.close()`),任何时候手上只有一页位图。
同一份 PDF 的并发渲染在进程内**串行化**,免得两个请求抢同一个 `.tmp`。

## 5. 证据

- **12 页的 72 号**(`jxj/announcement/2024/1/甬经信中小〔2024〕72号….pdf`)经真实接口渲染:
  **12 张 PNG**,`p001…p012` 连续,尺寸 **1653×2339**(A4 @200 DPI),共 5.9 MB;
  第一次 **0.45 s**,再 POST 一次 `written: 0 / skipped: 12`(**2 ms**)。
- 抽 **`page=3`** 打开(**`p003.png`,526 655 B**):**确实是第 3 页** —— 页脚「— 3 —」,
  正文是「2024 年第一批宁波市"专精特新"中小企业名单」序号 1–24,文字清晰不糊。
  证据图:`/tmp/pr13-evidence/p72-3.png`(另外 p1 / p12 也存了)。
- **97 页的 `jxj/announcement/2022/公布.pdf`**:`pageCount 97 / written 97`,**3.34 s**
  (接口实测;逐页 34 ms),页图共 **42 MB**;`p001…p097` 连续。
  **峰值 RSS 275 MB**(渲染前 83 MB);对照 12 页那份峰值 217 MB —— 内存**不随页数线性涨**,
  是按页释放的,不会 OOM。
- 页图落位后 `/api/files?rescan=1` 的 `total` 仍是 **23**(109 张页图一张没混进去)。
- 页图经既有预览路由可读:`GET /api/files/…/.…pdf.pages/p003.png` → `200 image/png`。
- `pnpm typecheck` 通过;`pnpm test` → 13 files / **196 passed**(基线 169 + 27)。

## 6. 已完成 / 未完成 / 已知缺口

**已完成**

- PDFium(wasm)+ sharp 的渲染管线;逐页 PNG 落盘;确定性路径 + 清单;
- `/api/pdf-pages` 的 `GET`(查现状 / 取某页字节)与 `POST`(渲染);
- 分辨率默认 200 DPI、可传参、可校验;幂等(含「不产生多余文件」);
- 97 页不 OOM(实测);`files/README.md` 的落盘规则;`pnpm typecheck && pnpm test` 全绿。

**未完成(明确留给后续票)**

- ~~**页面部分**~~ → **已完成**(见第 8 节,分支 `feat/pdf-page-gallery-closeout`)。
  界面对用户可见,按仓库规则**须过 `oil-ui` 验收**(本轮由实现会话做真实 UI 走查,
  但**不由实现会话自己判过**)。
- **「或批量」(原票 做什么 第 1 条)**:接口只收**单个** `file`,没有数组/批量形态。
  批量的自然落点是页面上的循环(UI 不在本票范围);若以后要在服务端批,再加一个入口。
- **`stored_page_image` 表与迁移**:按要求**本票不建表、不建迁移**。页图现在**只落盘**,
  由**确定性路径**索引;`page_no` 的权威来源是 `pNNN.png` 的文件名与 `.pages.json`。
  OCR(票 14)要按 `page_no` 回填时,需要一张表(或直接用清单)——
  **这是票 14 的输入契约,得先定下来**。
- 没有「按内容去重」:换内容走同一批路径(原地覆盖),旧内容的页图不保留。
  若要留痕(如比对「上次渲染对上了什么」),需要另立机制。

**已知缺口 / 风险**

- **渲染是同步的**(POST 阻塞到跑完)。97 页 3.3 s 尚可;若以后有几百页的件,
  该改成后台任务 + 轮询。票 14 的 PaddleOCR 才是真正需要异步的地方。
- **并发只在进程内串行化**(`Map` 级)。多实例部署时会各渲染各的(路径相同 → 互相覆盖,
  但都写完整文件 + 原子 rename,不会读出半张图)。单实例 app 不受影响。
- **清单里的源哈希只在渲染时算**(10 MB PDF ≈ 30 ms)。`GET` 的 `upToDate` 走
  「字节数 + 清单自洽」的**廉价判据** —— 内容变了但**字节数恰好不变**时,
  `GET` 会误报 `upToDate: true`;`POST` 不受影响(它按 sha256 判)。这是有意的取舍。
- **`@hyzyla/pdfium` 的 wasm 靠包内 `import.meta.url` 解析**。当前 Nitro(node-server preset)
  把 node_modules 外部化,dev 与 build 都实测可用(`.output/server/node_modules/@hyzyla/pdfium/dist/pdfium.wasm`
  被 trace 进产物,没有被 inline);若将来换成会 inline 依赖的 preset,需要显式给
  `init({ wasmBinary })`。
- **没测加密 PDF**。无密码的加密件应当报 422(路由把异常翻成 `渲染失败:…`),
  但没有夹具,未验证。

## 7. 独立评审(code-review 技能)与处置

派了两个子代理分别按「标准」与「规格」两轴审改动。**收到 6 条,全部处置如下**:

| # | 轴 | 意见 | 处置 |
| --- | --- | --- | --- |
| 1 | 规格 | **`force` 绕过了串行化** —— `renderPdfPages` 在 `force` 时**先返回**才查 in-flight 表,两个 force 请求(或 force 撞普通请求)照样并行写同一批 `.tmp` 与同一个 `.pages.json`;原并发测试只覆盖了两个普通请求,所以「串行」的说法比实现宽。 | **已修**。改成**按源文件路径排队**:参数完全相同 → 搭车;参数不同 → 排在后面(`force` 也进队列)。补了一条测试「并发**不同参数**的渲染 → 排队,后者在磁盘上说了算」(断言无 `.tmp` 残留、清单与像素一致)。 |
| 2 | 标准 | **HARD:新增写路径没有 ADR** —— `readonly-board-first` 明写「凡新增写路径,都单独记 ADR 说明其边界」(tus 那票就有)。 | **已补** [`docs/adr/2026-10-14-page-images-as-derived-cache.md`](../../../docs/adr/2026-10-14-page-images-as-derived-cache.md)。 |
| 3 | 标准 | `now?: () => Date` 是**没人用的测试缝**(投机抽象)。 | **已删**,直接用 `Date.now()` / `new Date()`。 |
| 4 | 标准 | `sha256Of` 与 `server/utils/stored-files.ts` 的**重复**;`resolveWithinRoot` 与 `[...path].get.ts` 内联的把关**重复**。 | **有意保留**,已把理由写进两处注释:抽公共件要改**别人正在动的文件**。同仓已有先例(`lib/stored-file.ts` 照抄 pipeline 的 `parseBatch`)。合流留给后续清理。 |
| 5 | 标准 | 两个文件同叫 `pdf-pages`,**名字撞车**(本仓靠 `stored-file` / `stored-files` 区分规则与服务)。 | **已改**:纯规则那份改名 **`lib/pdf-page.ts`**,与既有 `lib/stored-file.ts`(单数=规则)/ `server/utils/stored-files.ts`(复数=服务)的分法一致。 |
| 6 | 标准 | 文档数字**对不上实测**:`pdf-pages.post.ts` 写「约十秒级」(实测 3.3 s)、`.gitignore` 写 39 MB(实测 42 MB)、`lib/pdf-page.ts` 写 A4@200 = 1654×2339(实际 1653)。 | **已改**为实测值。 |

评审同时**复核了证据**:`pnpm test` 13 files / 196 passed、`nuxt typecheck` 退出 0、
「页图不进 `stored_file`」(核对了 `isSystemFile` 在目录分支**之前**判 `.` 前缀)、
`.gitignore` 模式确实命中(`git check-ignore`)、以及页面身份是**数方块数**验的不是「文件存在」。

---

# 8. 页面半边(2026-10-14,`feat/pdf-page-gallery-closeout`)

## 8.1 入口为什么是「预览」弹窗里的一个视图,而不是第四颗行操作按钮

`/files` 这张表在 1440 视口下总宽 **1118px**、容器 **1124px** —— 只剩 6px(上一轮 UI 验收
逐列量过宽度,见 `UI-ACCEPTANCE-files.md` 的列宽表)。「编辑 / 预览 / 移出」三颗字按钮正好占满
138px 的操作列;第四颗(即便换成 32px 的图标按钮)会把整张表推回横向滚动 ——
**拿一项已经验收过的性质去换一颗按钮,不划算**。

而 PDF 的内容本来就有两种看法:**原文**(排版本身是信息)与**页图**(逐页像素,给 OCR 用)。
两者放进「正在看这份文件」的那个弹窗,**零宽度代价**,且出现在用户真正需要它的地方:

| 文件 | 落在哪 |
| --- | --- |
| `components/files/PdfViewDialog.vue`(新) | PDF 的查看弹窗:顶部一条视图切换(原文 / 页图)+ 面板。PDF 行的「预览」开它 |
| `components/preview/PageImageGallery.vue`(新) | 页图那一格:取现状 → 空态/网格/单页 → 渲染。自己带卡片外壳(与 `ImagePreview` 同形) |
| `lib/page-gallery.ts`(新) | **判断与措辞**全在这里(什么状态说什么、主按钮叫什么、要不要 `force`、`<img src>` 带不带版本号),纯函数,19 个用例钉住 |
| `pages/files.vue` | 只多一句:`relPath` 是 PDF 就走 `PdfViewDialog`,否则仍是原来的 `FilePreviewDialog` |

**非 PDF 行、台账页的预览**行为一字未改(`FilePreviewDialog` 没动,`components/preview/*` 也没动)。
停在「页图」时 PDF 查看器**根本不挂载**(`Tabs` 默认不 `forceMount`)—— 只看缩略图的人不必付
一个 EmbedPDF 实例的开销。

## 8.2 实测(真实库、真实接口、真实 DOM)

| 场景 | 结果 |
| --- | --- |
| 未渲染 → 点「渲染页图」 | `jxj/announcement/2024/1/甬经信中小〔2024〕72号….pdf`(12 页)从空态变成 12 张缩略图;小结「**写入 12 页 · 579 ms**」(200 DPI) |
| 缩略图与页码 | 12 张,标注「第 1 页」…「第 12 页」;缩略图**整页显示**(`object-contain`),第 1 页的文头与红色公章、第 3–11 页的名单表格一眼分得清 |
| 点缩略图看单页 | 第 3 页放大后**确实是第 3 页**:标题「2024 年第一批宁波市"专精特新"中小企业名单」、表格 1–24 行、页脚「— 3 —」;缩放/适宽/旋转/下载复用 `ImagePreview` |
| 已有页图直接可看 | 关掉再开(同一份)直接落在「页图」视图,12 张图**全部已加载** —— 不用再点任何东西 |
| 分辨率可调 | 选 300 DPI → 状态「待更新」,文案写清「磁盘上是 200 DPI 的页图 · 按 300 DPI 重渲染会原地覆盖这 12 张」,主按钮变「按 300 DPI 重渲染」;点完 12 张全部 **2479×3508**(A4@300),`<img src>` 带新的 `?v=<renderedAt>`;切回 200 DPI 同样成立 |
| 大页数(97 页) | `jxj/announcement/2022/公布.pdf` → **97 张**,「第 1 页」…「第 97 页」,「**写入 97 页 · 3.3 s**」;`<img>` 走 `loading="lazy"`,网格无横向溢出 |
| 失败反馈 | 放一份假 PDF(25 字节文本)→ 接口 422 → 界面出红框「渲染失败:File not in PDF format or corrupted」,空态同时写着「这份 PDF 读不出页数 —— 文件可能已损坏或被移走」,「渲染页图」留着可重试 |
| 亮 / 暗 | 两套都截;暗色下缩略图仍在 `bg-muted` 框里读得出是白页,页码可读 |
| 窄屏(390px) | 工具栏折两行(状态一行、分辨率 + 按钮一行),网格 2 列,缩略图仍可辨认 |
| 控制台 | 挂了 `console.error`/`warn` + `uncaught`/`unhandledrejection` 监听,全程 **0 条**(含两次重渲染与深浅切换) |
| 表格 | 1440 下 `scrollWidth == clientWidth`(1134)→ **没有引入横向滚动**;页图网格自身也无横向溢出 |
| `stored_file` 不受污染 | 渲染出 12 + 97 张页图之后,`/api/files` 仍是 **23** 个文件 |

盘上:72号 → `files/jxj/announcement/2024/1/.…72号….pdf.pages/`(12 张,1653×2339,5.5 MB);
公布.pdf → `files/jxj/announcement/2022/.公布.pdf.pages/`(97 张,1653×2339,42 MB);
两处都**没有 `.tmp` 残留**。

## 8.3 顺带修掉的一处文档回退

上一轮票 13 的实现记录被后来一个 docs 提交(`735884b`)覆盖回了「Status: ready」的原文
(同一次也抹掉了 `issues/README.md` 里 13 那一行的说明)。本轮把它**恢复**(内容即 647989f 的版本)
并接上页面半边。

## 8.4 页面半边的未完成 / 已知缺口

- **未过 `oil-ui` 验收**:本节上表是**实现会话自己的**真实走查。按仓库规则,动了界面的票要
  **另派 `oil-ui` 会话验收**,实现会话不自己判过 —— 这一条仍然开着。
- **`?v=<renderedAt>` 只覆盖「渲染版本」这一维**:它能挡住换 DPI 之后拿到浏览器缓存里的旧图
  (`/api/files/**` 是 `max-age=3600`,而页图路径不随 DPI 变);页图被人手工改过而清单没变时,
  版本号不变,得点一次重渲染 —— 这本来就是那种场景的解法。
- **97 页那份会把 42 MB 的图拉进浏览器**:靠 `loading="lazy"` 只加载看得见的,但翻到后面时
  前面已加载的图会攒在内存里。没做后端缩略图(那要动票 13 的渲染管线,超出本轮范围)。
- **只测了两个真件与 200/300 DPI**;**加密 PDF 仍未测**(与后端那次的缺口一致)。
- **`viewing`(正在看第几页)在换文件时清空,视图(原文/页图)保留** —— 有意的:连着看几份
  PDF 的页图时,不必每开一次都点回「页图」。
- **一处工具层面的坑(与本票无关,记录以免复踩)**:用 `curl` 时把中文直接写进 URL(未百分号编码)
  会被 Node 的 HTTP 解析器挡下 —— 返回 `400 Bad Request` + `Connection: close` + **零长度响应体**
  (没有 Nitro 的 JSON 错误体,说明请求没进到应用层)。同一条查询用 `--data-urlencode` 或手工编码
  就是 200。已知正常路径的基线:`curl -i "…/api/files?rescan=1&q=%E5%9D%8F%E4%BB%B6"` → `200 OK`
  + `content-type: application/json`。
