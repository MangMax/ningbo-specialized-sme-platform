import type { PageImageRef, PdfPagesState, RenderOutcome } from '~~/server/utils/pdf-pages'
import { DEFAULT_DPI } from './pdf-page'

/**
 * 页图库的**展示规则**:把 `GET /api/pdf-pages` 返回的「现状」翻成界面要说的话、要做的事。
 *
 * 放在 `lib/` 而不是组件里,因为这些判断(页图全不全、按钮叫什么、为什么说「对不上」)
 * 是这一块的**内容**,不是样式;**样式在组件里,事实在服务端,这里是两者之间的翻译**。
 * 放到 lib 之后能被单测钉住(见 `tests/page-gallery.test.ts`)。
 *
 * 一条自我约束:**只翻译,不推断**。接口说 `upToDate: false`,这里就照实说「对不上」,
 * 不去猜是源文件被换了、页图被删了还是尺寸不对 —— 猜错了会把用户引到错的动作上
 * (`server/utils/pdf-pages.ts` 里 `upToDate` 是四个条件的合取,本来就分不出是哪一条)。
 */

/** 页面能选的分辨率。给 OCR 用的区间是 200–300;150 是「先看个大概」的那一档。 */
export const DPI_PRESETS = [150, 200, 300] as const

/**
 * 读页图现状,并在清单用的是非默认分辨率时,再用该分辨率核对一次 `upToDate`。
 *
 * `GET /api/pdf-pages` 的 `upToDate` 是**相对请求 DPI** 算的;省略参数会按默认 200 DPI
 * 比较。首次响应会同时告诉我们清单实际 DPI,所以非默认档需按清单 DPI 再读一次,避免把
 * 「请求 200、磁盘 300」造成的 false 标成源文件或页图损坏。
 *
 * **第二次失败不丢掉第一次的结果**(`dpiConfirmed: false`):第一次响应里已经有完整的
 * 清单(页数、每页尺寸、预览地址),据此就能把网格铺出来 —— 为了第二次核对失败而把整个
 * 界面清空,是拿一个小故障换掉用户本该看到的内容。没核对上的只是 `upToDate` 这一项
 * (它仍按默认 DPI 的口径算),所以照实标成「未确认」,由界面去说。
 */
export interface LoadedGalleryState {
  state: PdfPagesState
  /** 是否按清单 DPI 核对过最新状态。`false` = `state.upToDate` 不可信。 */
  dpiConfirmed: boolean
}

export async function loadPageGalleryState(
  file: string,
  fetchState: (query: { file: string; dpi?: number }) => Promise<PdfPagesState>,
): Promise<LoadedGalleryState> {
  const initial = await fetchState({ file })
  if (!initial.manifest || initial.dpi === DEFAULT_DPI) {
    // 没有清单(还没渲染)或清单就是默认档 —— 第一次请求已经是「按清单 DPI」问的。
    return { state: initial, dpiConfirmed: true }
  }
  try {
    return { state: await fetchState({ file, dpi: initial.dpi }), dpiConfirmed: true }
  } catch {
    return { state: initial, dpiConfirmed: false }
  }
}

/** 页图现状的四种「语气」。组件的徽章样式按它选,文案由下面给出。 */
export type GalleryTone = 'empty' | 'partial' | 'stale' | 'ready'

export interface GalleryStatus {
  tone: GalleryTone
  /** 状态徽章上的两个字。一行结论太长,徽章放不下;四个语气各一个短词。 */
  word: string
  /** 一行结论。 */
  headline: string
  /** 需要解释时的一句补充;没有就是空串。 */
  detail: string
  /** 主按钮文案。 */
  actionLabel: string
  /**
   * 主按钮**点了做什么**。绝大多数时候是「渲染」,只有「页图状态未确认」那档是
   * 「重新核对」(再读一次现状)—— 那种情况磁盘上一切正常,缺的只是一次成功的核对,
   * 让用户白跑一次几秒的重渲染是错的。
   */
  action: 'render' | 'reload'
  /**
   * 主按钮的**权重**。实心(`default`)只留给「确实有活要干」的档(还没渲染 / 不完整 /
   * 待更新);「已是最新」与「渲染失败」都是**描边**(`outline`)—— 前者是可选的重做,
   * 后者更不该用高优先级按钮去诱导一次大概率无效的重试(文件损坏时重试不会变好)。
   */
  variant: 'default' | 'outline'
  /** 主按钮是否带 `force`(即:磁盘上已是最新也照做)。 */
  force: boolean
}

/** 页数的写法。**全站一个口径** —— 「N 页已渲染」「共 N 页」混着写会让人以为说的不是一回事。 */
export function pageCountLabel(count: number): string {
  return `共 ${count} 页`
}

/**
 * 现状 → 该说什么、该做什么。
 *
 * 判断次序是有讲究的:**先看「有没有」,再看「全不全」,最后看「对不对」**。
 * 反过来的话,「一张都没有」会先命中「与源对不上」,给出一句「源文件变过」——
 * 那对第一次打开的人是彻底的误导(他从没渲染过,谈何「变过」)。
 *
 * `selectedDpi` 是界面上下拉框当前选的值:与磁盘上的不同时,「对不对」那一档要说清
 * **是按现在选的 DPI 对不上**,而不是含糊地说「不一致」。
 */
export interface GalleryStatusOptions {
  /**
   * 按清单 DPI 的二次核对没成功(见 `loadPageGalleryState`)。此时 `upToDate` 是默认档
   * 口径算的,**不能拿它说「最新」**,只能照实说「没核对上」。
   */
  dpiUnconfirmed?: boolean
}

export function galleryStatus(
  state: PdfPagesState,
  selectedDpi: number,
  options: GalleryStatusOptions = {},
): GalleryStatus {
  const total = state.pageCount

  // 一张都没有:这是「还没做」,不是「有问题」。
  if (state.rendered === 0) {
    return {
      tone: 'empty',
      word: '未渲染',
      headline: '还没有页图',
      detail:
        total === null
          ? '这份 PDF 读不出页数 —— 文件可能已损坏或被移走。'
          : `这份 PDF ${pageCountLabel(total)};渲染成 PNG 之后可以逐页查看,并供 OCR 取图。`,
      actionLabel: '渲染页图',
      action: 'render',
      variant: 'default',
      force: false,
    }
  }

  // 有页图,但最新状态没核对上。**不能报「最新」**,也不能让用户去重渲染
  // —— 磁盘上什么都没坏,缺的只是一次成功的核对。
  if (options.dpiUnconfirmed) {
    return {
      tone: 'stale',
      word: '待确认',
      headline: `页图状态未核对(${pageCountLabel(state.rendered)})`,
      detail: '按清单分辨率复核最新状态时出错;看到的可能不是最新的。',
      actionLabel: '重新核对',
      action: 'reload',
      variant: 'outline',
      force: false,
    }
  }

  // 有页图但读不出源页数:源文件多半已损坏或被移走,说明事实,别编页数。
  if (total === null) {
    return {
      tone: 'stale',
      word: '待更新',
      headline: `已有 ${state.rendered} 页页图`,
      detail: '读不出源 PDF 的页数(文件可能已损坏或被移走);重渲染可以核对。',
      actionLabel: '重新渲染',
      action: 'render',
      variant: 'default',
      force: false,
    }
  }

  // 有、但对不上张数:上次渲染中途断了,或者源文件换了页数。
  if (state.rendered !== total) {
    return {
      tone: 'partial',
      word: '不完整',
      headline: `页图不完整(已有 ${state.rendered} 张,共需 ${total} 张)`,
      detail: '补齐一次,每一页都有图。',
      actionLabel: '补齐页图',
      action: 'render',
      variant: 'default',
      force: false,
    }
  }

  // 张数对、DPI 不对:磁盘上是另一档 DPI 的。这种「对不上」不是错误,是用户刚换了档。
  if (state.dpi !== selectedDpi) {
    return {
      tone: 'stale',
      word: '待更新',
      headline: `磁盘上是 ${state.dpi} DPI 的页图`,
      detail: `按 ${selectedDpi} DPI 重渲染会原地覆盖这 ${state.rendered} 张(路径不变,尺寸与内容换掉)。`,
      actionLabel: `按 ${selectedDpi} DPI 重渲染`,
      action: 'render',
      variant: 'default',
      force: false,
    }
  }

  // 张数、DPI 都对,但清单与磁盘/源文件对不上(源内容换过,或页图被改动过)。
  if (!state.upToDate) {
    return {
      tone: 'stale',
      word: '待更新',
      headline: '页图与当前源文件对不上',
      detail: '源文件被换过,或者页图被改动过;重渲染即可对齐。',
      actionLabel: '重新渲染',
      action: 'render',
      variant: 'default',
      force: false,
    }
  }

  // 一切对齐。**「最新」不单挂一个徽章**:它旁边就是分辨率下拉与按钮,一个孤零零的
  // 词读起来像个控件标签;并进这句话里就只有一个意思了。
  return {
    tone: 'ready',
    word: '已是最新',
    headline: `页图已是最新(${pageCountLabel(state.rendered)})`,
    detail: '',
    actionLabel: '重新渲染',
    action: 'render',
    variant: 'outline',
    force: true,
  }
}

/**
 * 页图的 `<img src>`:带上「这一版是哪一次渲染出来的」。
 *
 * **不能直接用接口给的 `url`**:页图路径**不随 DPI 变**(原地覆盖,见 files/README.md),
 * 而 `/api/files/**` 给的是 `max-age=3600`。刚按 300 DPI 重渲染完,浏览器还能拿一小时前
 * 那张 200 DPI 的缓存图 —— 页面上「尺寸」写着 1653×2339,图却是老的,而且看起来一切正常。
 * 用清单里的 `renderedAt` 当版本号:一次渲染一个值,重渲染必然换新。
 */
export function pageImageSrc(state: PdfPagesState, page: PageImageRef): string {
  const version = state.manifest?.renderedAt
  return version ? `${page.url}?v=${encodeURIComponent(version)}` : page.url
}

/** 页码的写法。页号是这套东西的**权威**(票 13),所以哪儿都按同一个样子写。 */
export function pageLabel(pageNo: number): string {
  return `第 ${pageNo} 页`
}

/** 渲染失败时状态徽章上的词。 */
export const RENDER_FAILED_WORD = '渲染失败'

/**
 * 认得出的失败原因 → 一句**可执行**的中文。
 *
 * 措辞与**主按钮的动词对齐**:失败后按钮是「重新渲染」(= 重试),所以这里**先**说重试、
 * **再**说换文件 —— 原来的顺序反着(先劝换文件),读起来像在否定旁边那颗按钮。
 *
 * 服务端把原因写成 `渲染失败:<引擎原句>`,而引擎原句是英文的
 * (`File not in PDF format or corrupted`)—— 原样摆给用户等于没说:他既不知道
 * 发生了什么,也不知道下一步做什么。
 */
const RENDER_FAILURE_HINTS: ReadonlyArray<{ test: RegExp; message: string }> = [
  {
    test: /not in PDF format|corrupted|损坏/i,
    message:
      '这个文件不是有效的 PDF,或者内容已损坏。先重试一次;仍失败就换一份文件,或用能打开它的程序另存一次。',
  },
  {
    test: /password|encrypted|加密/i,
    message: '这份 PDF 有密码保护。请先去掉密码,再渲染页图。',
  },
  {
    test: /文件不存在|not found/i,
    message: '这份文件已经不在文件库里了。刷新文件列表看看,或确认它没有被移走。',
  },
]

/**
 * 把服务端给的失败说明翻成**可执行的中文**。
 *
 * **这一层是唯一产出最终句子的一层**。调用方拿不到服务端说明时必须传空串
 * (`describeFetchError(error, '')`),不能先垫一句「渲染失败,请重试。」再送进来 ——
 * 那样会被再包装一次,变成「渲染没有成功:渲染失败,请重试。。可以重试;…」这种
 * 重复标点 + 重复劝重试的句子(独立审查 F1 报的就是这个)。
 *
 * 认不出的原因**不吞**:保留原句(排查要靠它)并去掉句末标点,再补一句下一步做什么。
 */
export function describeRenderFailure(raw: string): string {
  // 前缀允许中间夹空格(`渲染失败 :`),全角 / 半角冒号都收;句末标点先剥掉,
  // 免得拼出「…。。」。
  const reason = raw
    .replace(/^渲染失败\s*[:：]\s*/, '')
    .replace(/[。.]+$/, '')
    .trim()
  if (!reason) {
    return '渲染没有成功,也没拿到具体原因(可能是网络或服务中断)。可以重试。'
  }
  const hit = RENDER_FAILURE_HINTS.find((h) => h.test.test(reason))
  if (hit) return hit.message
  return `渲染没有成功:${reason}。可以重试;反复失败就换一份文件,或检查文件是否损坏。`
}

/** 耗时:小于 1 秒按毫秒(渲染几页就是几十毫秒,写成「0.0 s」等于没写)。 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`
}

/**
 * 渲染完的一句话交代:**写了几页、清了几张、花了多久**。
 *
 * 说明「跳过」是重点:幂等命中时 `written` 是 0,只说「完成」会让人以为又写了一遍
 * (97 页那份重渲染要好几秒,用户完全有理由怀疑它真的重做了)。
 */
export function renderSummary(outcome: RenderOutcome): string {
  const duration = formatDuration(outcome.elapsedMs)
  if (outcome.written === 0) {
    return `页图已是最新,未写入(跳过 ${outcome.skipped} 页)· ${duration}`
  }
  const parts = [`写入 ${outcome.written} 页`]
  if (outcome.removed > 0) parts.push(`清掉 ${outcome.removed} 张多余的页图`)
  return `${parts.join('、')} · ${duration}`
}
