/**
 * 预览要处理的文件类型。
 *
 * 与台账「出处」里出现的文件一致:经信局公布文件是 docx/doc/pdf,
 * 工信部名单是三份导出 Excel,项目自带的汇报材料有 pptx。
 */
export type PreviewKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'image'

export interface PreviewKindInfo {
  kind: PreviewKind
  /** 面向使用者的类型名,用于工具栏与错误提示。 */
  label: string
}

/** 扩展名 → 类型。键一律小写,不含点。 */
const BY_EXTENSION: Record<string, PreviewKindInfo> = {
  docx: { kind: 'docx', label: 'Word 文档' },
  xlsx: { kind: 'xlsx', label: 'Excel 工作簿' },
  xlsm: { kind: 'xlsx', label: 'Excel 工作簿' },
  pptx: { kind: 'pptx', label: 'PowerPoint 演示文稿' },
  pdf: { kind: 'pdf', label: 'PDF 文档' },
  png: { kind: 'image', label: '图片' },
  jpg: { kind: 'image', label: '图片' },
  jpeg: { kind: 'image', label: '图片' },
  webp: { kind: 'image', label: '图片' },
  gif: { kind: 'image', label: '图片' },
  avif: { kind: 'image', label: '图片' },
  bmp: { kind: 'image', label: '图片' },
  svg: { kind: 'image', label: '图片' },
}

/**
 * 已知但**不能**预览的格式。
 *
 * 旧版二进制 Office 文件(`.doc` / `.xls` / `.ppt`)在经信局名单里确实存在
 * (如「关于公布2023年宁波市“专精特新”中小企业名单的通知.doc」),但 OOXML
 * 查看器只认 zip 容器格式,读不了这些老格式。单独列出来,是为了给一句
 * 说得清楚的提示,而不是让它掉进「未知格式」里。
 */
const LEGACY: Record<string, PreviewKindInfo> = {
  doc: { kind: 'docx', label: 'Word 文档(旧版 .doc)' },
  xls: { kind: 'xlsx', label: 'Excel 工作簿(旧版 .xls)' },
  ppt: { kind: 'pptx', label: 'PowerPoint 演示文稿(旧版 .ppt)' },
}

/** 取路径的扩展名(小写,不含点);没有扩展名时返回空串。 */
export function extensionOf(path: string): string {
  // 先剥掉 ?query 和 #hash,再取最后一段,避免把参数当扩展名。
  const clean = path.split(/[?#]/, 1)[0] ?? ''
  const base = clean.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** 路径的文件名(去掉目录),用于标题与下载名。 */
export function fileNameOf(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? ''
  return decodeURIComponent(clean.split('/').pop() ?? '') || '未命名文件'
}

/** 能否预览这个路径。 */
export function isPreviewable(path: string): boolean {
  const ext = extensionOf(path)
  return ext in BY_EXTENSION
}

/** 文件读取接口的前缀(见 `server/api/files/[...path].get.ts`)。 */
export const FILES_API_PREFIX = '/api/files'

/**
 * 把记录里的 `source_file`(相对文件库 `files/`)拼成可请求的地址。
 *
 * **逐段编码,不能整串 `encodeURIComponent`** —— 那样会把 `/` 也编掉,
 * 变成单个路径段。文件名里常带 `〔〕`、中文引号、空格,不编码又会被
 * URL 解析截断,所以按段编、再把 `/` 接回去。
 */
export function fileUrl(sourceFile: string): string {
  const segments = sourceFile.split('/').map(encodeURIComponent)
  return `${FILES_API_PREFIX}/${segments.join('/')}`
}

/** 是不是已知但不受支持的旧版二进制格式。 */
export function isLegacyOffice(path: string): boolean {
  return extensionOf(path) in LEGACY
}

/**
 * 地址能不能安全地加查询参数。
 *
 * 同源路径(`/api/...`)与绝对 `http(s)` 可以;**`blob:` / `data:` 不行** ——
 * blob 地址是精确字符串,`data:` 的正文内联在地址里,加一个 `?retry=` 就取不到东西了。
 * 这两种情况只能靠调用方**重建 `<img>` 元素**再试一次。
 */
export function isQueriableUrl(src: string): boolean {
  return src.startsWith('/') || /^https?:\/\//i.test(src)
}

/**
 * 重试时用的图片地址:**换一个 URL,让这次重试拿到的是新地址**。
 *
 * 先说清楚**原来那个 bug 到底是什么**(独立浏览器实验核实过,别把它写成「浏览器
 * 拒绝重发」):
 *
 *  - 旧实现的重试只把 UI 状态拨回「加载中」,**既没改 `src` 也没换元素** —— Vue 根本
 *    没有触发任何新的加载,`<img>` 还停在失败态,界面就永久卡在「正在读取文件…」。
 *  - 也就是说,缺的是**「发起一次新加载」这个动作**,不是浏览器不肯配合:真的重新赋值
 *    同一个 `src`、或重建 `<img>` 元素,Chrome 都会**照发**新请求。
 *
 * 所以本函数的职责是「把重试做成一次**新的**加载」,换地址是最直接的一种做法
 * (另一种是重建元素,见 `components/preview/ImagePreview.vue` 的 `:key`)。
 *
 * 换地址还有第二个**独立**的好处:文件回吐路由给来源文件发了
 * `cache-control: private, max-age=3600`(见 `server/api/files/[...path].get.ts`),
 * 同一个地址在一小时内会命中浏览器缓存;带上 `retry=N` 才能保证这次重试真的走到服务端
 * —— 上一轮 404 是这样,服务端**后来把文件补回来了**也是这样(否则会一直读缓存里的失败)。
 *
 * `attempt <= 0`(还没重试过)时**原样返回**:首次加载的地址与请求一个字节都不变。
 * 不能加查询串的地址(`blob:` / `data:`)也原样返回 —— 那种情况由调用方重建元素兜底。
 *
 * 查询串插在 **fragment 之前**:`/a.png#page=2` → `/a.png?retry=1#page=2`。
 * 拼在 `#` 之后的话,`#…` 整段不会进请求行,这个参数等于没带。
 */
export function retrySrc(src: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt <= 0) return src
  if (!isQueriableUrl(src)) return src
  const hashAt = src.indexOf('#')
  const base = hashAt === -1 ? src : src.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : src.slice(hashAt)
  // 页图地址本来就带 `?v=<渲染版本>`,所以要接着用 `&`。
  return `${base}${base.includes('?') ? '&' : '?'}retry=${attempt}${hash}`
}

/**
 * 解析路径 → 类型信息。无法预览时返回 null。
 *
 * 只按扩展名判断,不做内容嗅探:台账里的出处路径都带扩展名,而按内容嗅探
 * 需要先把文件读进来,反而会在「明明打不开」的文件上多花一次网络往返。
 */
export function resolvePreviewKind(path: string): PreviewKindInfo | null {
  const ext = extensionOf(path)
  return BY_EXTENSION[ext] ?? null
}

/**
 * 给一个打不开的文件挑一句说得清楚的说明。
 * 旧版格式说明是「格式不支持」,其余按「无法识别」处理。
 */
export function describeUnsupported(path: string): string {
  const ext = extensionOf(path)
  if (ext in LEGACY) {
    return `旧版 ${ext.toUpperCase()} 是二进制格式,浏览器端只能预览新版 .${ext}x。请用桌面版 Office 打开。`
  }
  return ext ? `暂不支持预览 .${ext} 文件。` : '这个文件没有扩展名,无法判断格式。'
}

/**
 * 把底层抛出的错误翻成人话。
 *
 * 各预览库的报错原样透传会露出 `Failed to fetch: 404 Not Found`、
 * `OOXML resource limit exceeded: cells 250001 > 250000` 这种英文技术信息 ——
 * 对查台账的人没有意义。这里按状态码 / 已知错误类型给一句能指导下一步的说明;
 * 认不出来时保留原文,方便排查。
 */
export function describeLoadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)

  // Excel 工作簿超过查看器的单元格上限(见 describeCellLimit)。这条要单独认,
  // 因为它不是「坏文件」,而是「文件太大」,处置方式完全不同。
  const limit = cellLimitOf(raw)
  if (limit) return limit

  if (/\b404\b/.test(raw)) return '文件不存在。出处路径可能已变更,或文件已被移走。'
  if (/\b403\b/.test(raw)) return '没有读取这个文件的权限。'
  if (/\b415\b/.test(raw)) return '这个格式不在预览范围内。'
  if (/\b500\b/.test(raw)) return '文件服务出错了,稍后再试。'
  if (/password|encrypt|加密/i.test(raw)) return '文件已加密,需要密码才能打开。'
  if (/failed to fetch|networkerror|load failed|econnrefused/i.test(raw)) {
    return '取不到文件。检查网络连接,或确认文件服务在运行。'
  }
  return raw
}

/**
 * 识别「超出预览器资源上限」这类报错,给一句说清**为什么**和**怎么办**的话。
 *
 * 背景:OOXML 查看器对每个工作表有 **250,000 个单元格**的硬上限,且这个值
 * **不可配置**(库里标了 `configurable: false`)。工信部的三份导出里有两份超了:
 *   专精特新中小企业 100.0 万格(4.0 倍)、创新型 59.6 万格(2.4 倍)
 *   —— 这两份是超宽表(60~90 列),行数不多但列多。
 * 小巨人那份 13.2 万格,在上限内,能正常打开。
 *
 * 注意措辞:这不是「文件坏了」,是「这份表比预览器能吃下的大」。
 * 用户看到后该做的是下载下来用 Excel 打开,或按需导出子集 —— 所以要明说。
 */
function cellLimitOf(raw: string): string | null {
  if (!/resource limit exceeded/i.test(raw)) return null
  const cells = /cells\s+(\d+)\s*>\s*(\d+)/i.exec(raw)
  if (cells?.[2]) {
    const limit = Number(cells[2]).toLocaleString('zh-CN')
    return `这份工作簿超过了预览器的上限(每张表 ${limit} 个单元格,且无法调高)。请下载后用 Excel 打开。`
  }
  if (/rows\s+(\d+)\s*>\s*(\d+)/i.test(raw)) {
    return '这份工作表行数超过了预览器的上限。请下载后用 Excel 打开。'
  }
  return '这份文件超过了预览器的处理上限。请下载后用 Excel 或 Word 打开。'
}

/** 图片缩放的**绝对**上限与下限 —— 只是防止算出 0 / 无穷这类没意义的值,不是给人看的档位。 */
export const ZOOM_ABS_MAX = 8
export const ZOOM_ABS_MIN = 0.01

/**
 * **自动「适应」**的目标缩放:受**绝对**上下限约束,**不受手动下限**。
 *
 * 手动下限(默认 25%)是给**人**选的档,而「适应」是把整页装进容器 —— 超大图 + 窄容器
 * (如 2400×3200 的图放进 390px 弹窗)需要的比例会低到 ~13.5%。若把 fit 也按手动下限夹住,
 * 「适应」就装不下,反而**横纵溢出**,而窄屏下缩放的按钮/滑块是隐藏的(见 `PreviewToolbar`
 * 的 `sm:` / `lg:` 断点),用户**没有手段缩回来** —— 那是真正的可见性回归。
 */
export function fitZoom(
  scale: number,
  max: number = ZOOM_ABS_MAX,
  min: number = ZOOM_ABS_MIN,
): number {
  return Math.min(max, Math.max(min, scale))
}

/**
 * **手动**缩放的下一步(滚轮 / 按钮 / 工具栏滑块):
 *
 * 下限取 `minZoom`,但**不把已经比它更小的当前值往回拉**。自动「适应」可能已经落在手动下限
 * 之下(超大图 + 窄容器);这时如果无脑 `max(minZoom, next)`:
 *
 *  - 往外缩(滚轮向外 / 点「缩小」)会被**夹回下限 → 反而放大**,是明显的错觉;
 *  - 往里缩则会**跳**过一截。
 *
 * 所以下限取 `min(minZoom, current)`:比下限更小时**停在原地**(往外不再缩小),
 * 往里则从当前值平滑长回去,越过下限后按正常的手动下限走。
 */
export function nextZoom(
  requested: number,
  current: number,
  minZoom: number,
  max: number = ZOOM_ABS_MAX,
): number {
  return Math.min(max, Math.max(Math.min(minZoom, current), requested))
}
