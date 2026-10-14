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
 * 读页图现状后,若磁盘清单使用非默认分辨率,再用该分辨率确认 `upToDate`。
 *
 * `GET /api/pdf-pages` 的 `upToDate` 是相对请求 DPI 计算的;省略参数会按默认 200 DPI
 * 比较。首次响应会同时告诉我们清单实际 DPI,所以非默认档需按清单 DPI 再读一次,避免
 * 把「请求 200、磁盘 300」造成的 false 标成源文件或页图损坏。
 */
export async function loadPageGalleryState(
  file: string,
  fetchState: (query: { file: string; dpi?: number }) => Promise<PdfPagesState>,
): Promise<PdfPagesState> {
  const initial = await fetchState({ file })
  if (!initial.manifest || initial.dpi === DEFAULT_DPI) return initial
  return fetchState({ file, dpi: initial.dpi })
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
  /** 主按钮文案。四个语气都有主按钮 —— 页图这件事永远可以「再渲染一次」。 */
  actionLabel: string
  /** 主按钮是否带 `force`(即:磁盘上已是最新也照做)。 */
  force: boolean
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
export function galleryStatus(state: PdfPagesState, selectedDpi: number): GalleryStatus {
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
          : `这份 PDF 有 ${total} 页;渲染成 PNG 之后可以逐页查看,并供 OCR 取图。`,
      actionLabel: '渲染页图',
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
      force: false,
    }
  }

  // 有、但对不上张数:上次渲染中途断了,或者源文件换了页数。
  if (state.rendered !== total) {
    return {
      tone: 'partial',
      word: '不完整',
      headline: `页图不完整(已渲染 ${state.rendered} / ${total} 页)`,
      detail: '补齐一次,每一页都有图。',
      actionLabel: '补齐页图',
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
      force: false,
    }
  }

  return {
    tone: 'ready',
    word: '最新',
    headline: `${state.rendered} 页已渲染`,
    detail: '',
    actionLabel: '重新渲染',
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
