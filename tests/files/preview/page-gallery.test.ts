import { describe, expect, it } from 'vitest'
import {
  DPI_PRESETS,
  RENDER_FAILED_WORD,
  describeRenderFailure,
  formatDuration,
  galleryStatus,
  loadPageGalleryState,
  pageCountLabel,
  pageImageSrc,
  pageLabel,
  renderSummary,
  singlePageCountLabel,
} from '../../../lib/page-gallery'
import type { PdfPagesState, RenderOutcome } from '../../../server/utils/pdf-pages'

/**
 * 页图库的展示规则(票 13 的页面半边)。
 *
 * 测的是**判断与措辞**:什么状态说什么、主按钮叫什么、要不要 `force`、`<img src>` 带不带
 * 版本号。这些是这一块的"内容",换成组件里写就没法钉住了 —— 而它们恰恰是最容易改坏的
 * (比如把「一张都没有」和「与源对不上」的次序写反,新用户第一次打开就会看到一句
 * 「源文件变过」,而他从没渲染过)。
 *
 * 夹具走**结构最小化**:只给被测判断会读到的字段,其余留空 —— 这样断言里看不出
 * "其实测的是别的东西"。夹具形状就是接口返回的形状(`GET /api/pdf-pages`)。
 */

function state(over: Partial<PdfPagesState> = {}): PdfPagesState {
  const base: PdfPagesState = {
    file: 'jxj/announcement/2024/1/甬经信中小〔2024〕72号.pdf',
    pageCount: 12,
    dpi: 200,
    rendered: 12,
    upToDate: true,
    pages: [],
    manifest: {
      dpi: 200,
      renderedAt: '2026-10-14T08:00:00.000Z',
      enhancement: 'white-flatten-grayscale-normalize-sharpen-v1',
    },
  }
  return { ...base, ...over }
}

/** 一页页图(接口给的形状)。 */
function page(no: number) {
  return {
    page: no,
    relPath: `jxj/announcement/2024/1/.72号.pdf.pages/p${String(no).padStart(3, '0')}.png`,
    url: `/api/files/jxj/announcement/2024/1/.72%E5%8F%B7.pdf.pages/p${String(no).padStart(3, '0')}.png`,
    width: 1653,
    height: 2339,
    bytes: 414576,
  }
}

describe('galleryStatus(现状 → 该说什么、该做什么)', () => {
  it('一张都没有 → 「还没做」,不是「有问题」', () => {
    const s = galleryStatus(state({ rendered: 0, upToDate: false, pages: [], manifest: null }), 200)
    expect(s.tone).toBe('empty')
    expect(s.word).toBe('未渲染')
    expect(s.headline).toBe('还没有页图')
    expect(s.detail).toContain('12 页')
    expect(s.actionLabel).toBe('渲染页图')
    expect(s.force).toBe(false)
  })

  it('**判断次序**:一张都没有时,即便 upToDate 是 false 也不说「源文件变过」', () => {
    // 这是最容易写反的一处:反过来写,第一次打开的人会看到一句「源文件被换过」——
    // 他从来没渲染过,谈何换过。
    const s = galleryStatus(
      state({ rendered: 0, upToDate: false, pageCount: 12, manifest: null }),
      200,
    )
    expect(s.tone).toBe('empty')
    expect(s.detail).not.toContain('源文件')
  })

  it('读不出页数(源损坏 / 被移走)→ 照实说读不出,不编页数', () => {
    const s = galleryStatus(state({ pageCount: null, rendered: 4, upToDate: false }), 200)
    expect(s.tone).toBe('stale')
    expect(s.headline).toBe('已有 4 页页图')
    expect(s.detail).toContain('读不出源 PDF 的页数')
    expect(s.actionLabel).toBe('重新渲染')
  })

  it('有页图但张数不够 → 「不完整」,并报出已渲染多少 / 共多少', () => {
    const s = galleryStatus(state({ rendered: 3, upToDate: false, pageCount: 12 }), 200)
    expect(s.tone).toBe('partial')
    expect(s.word).toBe('不完整')
    expect(s.headline).toBe('页图不完整(已有 3 张,共需 12 张)')
    expect(s.actionLabel).toBe('补齐页图')
    expect(s.action).toBe('render')
  })

  it('张数对、DPI 不对 → 说清是按**现在选的**这一档对不上,而不是含糊的「不一致」', () => {
    const s = galleryStatus(state({ dpi: 200, rendered: 12, upToDate: false }), 300)
    expect(s.tone).toBe('stale')
    expect(s.headline).toBe('磁盘上是 200 DPI 的页图')
    expect(s.detail).toContain('按 300 DPI')
    expect(s.actionLabel).toBe('按 300 DPI 重渲染')
    expect(s.force).toBe(false)
  })

  it('张数、DPI 都对但清单对不上 → 只说「对不上」,不替用户猜原因', () => {
    const s = galleryStatus(state({ rendered: 12, dpi: 200, upToDate: false }), 200)
    expect(s.tone).toBe('stale')
    expect(s.headline).toBe('页图与当前源文件对不上')
    // 「源文件被换过**或者**页图被改动过」—— 两个可能都列出来,因为服务端的 upToDate
    // 是四个条件的合取,本来就分不出是哪一条。
    expect(s.detail).toContain('或者')
  })

  it('一切对齐 → 一句「已是最新」的结论,主按钮「重新渲染」且带 force', () => {
    const s = galleryStatus(state(), 200)
    expect(s.tone).toBe('ready')
    // 「最新」不再是一个孤立的徽章词(独立审查 S2):并进这句自足的结论里。
    expect(s.headline).toBe('页图已是最新(共 12 页)')
    expect(s.detail).toBe('')
    expect(s.actionLabel).toBe('重新渲染')
    expect(s.action).toBe('render')
    expect(s.force).toBe(true)
  })

  it('页数口径全站一致:每一档都说「共 N 页」或「N 张」(S9)', () => {
    const seen = [
      galleryStatus(state({ rendered: 0, pages: [], manifest: null }), 200).detail,
      galleryStatus(state({ rendered: 3, upToDate: false }), 200).headline,
      galleryStatus(state(), 200).headline,
      galleryStatus(state(), 200, { dpiUnconfirmed: true }).headline,
    ]
    // 没有哪一档写「N 页已渲染」这种另一套说法。
    for (const text of seen) expect(text).not.toContain('页已渲染')
    expect(pageCountLabel(12)).toBe('共 12 页')
  })

  it('单页视图总数未知时只报已有张数,已知时才报总页数', () => {
    expect(singlePageCountLabel(null, 4)).toBe('已有 4 张页图')
    expect(singlePageCountLabel(9, 4)).toBe('共 9 页')
  })

  it('四个语气各有自己的状态词,没有两个语气共用一句话', () => {
    const tones = [
      galleryStatus(state({ rendered: 0, manifest: null, upToDate: false }), 200),
      galleryStatus(state({ rendered: 3, upToDate: false }), 200),
      galleryStatus(state({ upToDate: false }), 200),
      galleryStatus(state(), 200),
    ]
    expect(new Set(tones.map((t) => t.tone)).size).toBe(4)
    // 词可以重复(partial 与 stale 都算「待办」语义),但结论句不能一样。
    expect(new Set(tones.map((t) => t.headline)).size).toBe(4)
  })

  it('每个语气都给得出主按钮文案 —— 页图永远可以再渲染一次', () => {
    for (const s of [
      galleryStatus(state({ rendered: 0, manifest: null, upToDate: false }), 200),
      galleryStatus(state({ rendered: 3, upToDate: false }), 200),
      galleryStatus(state({ upToDate: false }), 200),
      galleryStatus(state(), 200),
    ]) {
      expect(s.actionLabel.length).toBeGreaterThan(0)
      expect(s.word.length).toBeGreaterThan(0)
    }
  })
})

describe('loadPageGalleryState(按清单分辨率核对现状)', () => {
  it('磁盘是 400 DPI 时按清单 DPI 重查,不会把默认 300 DPI 的差异误报成源文件变化', async () => {
    const file = state().file
    const defaultDpiResponse = state({
      dpi: 400,
      upToDate: false,
      manifest: {
        dpi: 400,
        renderedAt: '2026-10-14T08:00:00.000Z',
        enhancement: 'white-flatten-grayscale-normalize-sharpen-v1',
      },
    })
    const manifestDpiResponse = state({
      dpi: 400,
      upToDate: true,
      manifest: {
        dpi: 400,
        renderedAt: '2026-10-14T08:00:00.000Z',
        enhancement: 'white-flatten-grayscale-normalize-sharpen-v1',
      },
    })
    const requests: Array<{ file: string; dpi?: number }> = []

    const loaded = await loadPageGalleryState(file, async (query) => {
      requests.push(query)
      return query.dpi === 400 ? manifestDpiResponse : defaultDpiResponse
    })

    expect(requests).toEqual([{ file }, { file, dpi: 400 }])
    expect(loaded.dpiConfirmed).toBe(true)
    expect(loaded.state.upToDate).toBe(true)
    expect(galleryStatus(loaded.state, loaded.state.dpi).tone).toBe('ready')
  })

  it('按清单 DPI 重查后仍不新鲜时,保留真实异常状态(且确实发了第二次请求)', async () => {
    const file = state().file
    const stale = state({
      dpi: 400,
      upToDate: false,
      manifest: {
        dpi: 400,
        renderedAt: '2026-10-14T08:00:00.000Z',
        enhancement: 'white-flatten-grayscale-normalize-sharpen-v1',
      },
    })
    const requests: Array<{ file: string; dpi?: number }> = []

    const loaded = await loadPageGalleryState(file, async (query) => {
      requests.push(query)
      return stale
    })

    // 关键断言:即便两次结果一样「不新鲜」,第二次**仍必须按清单 DPI 发出**。
    // 只断言 tone 是拦不住的 —— 删掉二次请求后首个响应就是 stale,断言照样通过。
    expect(requests).toEqual([{ file }, { file, dpi: 400 }])
    expect(galleryStatus(loaded.state, loaded.state.dpi).tone).toBe('stale')
  })

  it('清单就是默认 DPI 时**不**发第二次请求(省一次往返)', async () => {
    const file = state().file
    const requests: Array<{ file: string; dpi?: number }> = []
    const loaded = await loadPageGalleryState(file, async (query) => {
      requests.push(query)
      return state({
        dpi: 300,
        manifest: {
          dpi: 300,
          renderedAt: '2026-10-15T00:00:00.000Z',
          enhancement: 'white-flatten-grayscale-normalize-sharpen-v1',
        },
      })
    })

    expect(requests).toEqual([{ file }])
    expect(loaded.dpiConfirmed).toBe(true)
    expect(loaded.state.upToDate).toBe(true)
  })

  it('没有清单(未渲染)时不发第二次请求 —— 没有清单 DPI 可依', async () => {
    const file = state().file
    const requests: Array<{ file: string; dpi?: number }> = []
    const loaded = await loadPageGalleryState(file, async (query) => {
      requests.push(query)
      return state({ rendered: 0, pages: [], manifest: null, upToDate: false })
    })

    expect(requests).toEqual([{ file }])
    expect(loaded.dpiConfirmed).toBe(true)
    expect(loaded.state.manifest).toBeNull()
  })

  it('**二次核对失败时保留首次响应**(F3):有清单就不该白屏,只标记未确认', async () => {
    const file = state().file
    const withManifest = state({
      dpi: 400,
      upToDate: false,
      manifest: {
        dpi: 400,
        renderedAt: '2026-10-14T08:00:00.000Z',
        enhancement: 'white-flatten-grayscale-normalize-sharpen-v1',
      },
      pages: [page(1), page(2)],
      rendered: 2,
      pageCount: 2,
    })
    const requests: Array<{ file: string; dpi?: number }> = []

    const loaded = await loadPageGalleryState(file, async (query) => {
      requests.push(query)
      if (query.dpi === 400) throw new Error('boom')
      return withManifest
    })

    // 第二次确实发了(且失败了),但**结果不能丢**:清单还在,网格照铺。
    expect(requests).toEqual([{ file }, { file, dpi: 400 }])
    expect(loaded.dpiConfirmed).toBe(false)
    expect(loaded.state).toEqual(withManifest)
    expect(loaded.state.pages).toHaveLength(2)
  })

  it('未确认时不把已渲染张数说成总页数,并保留待确认动作', () => {
    const partial = galleryStatus(
      state({ rendered: 2, pages: [page(1), page(2)] }),
      200,
      { dpiUnconfirmed: true },
    )
    expect(partial.word).toBe('待确认')
    expect(partial.tone).toBe('stale')
    expect(partial.headline).toBe('页图状态未核对(已有 2 张,共需 12 张)')
    expect(partial.headline).not.toContain('共 2 页')
    // 磁盘上什么都没坏,缺的只是一次成功的核对 —— 所以是重新核对,不是重渲染。
    expect(partial.action).toBe('reload')
    expect(partial.actionLabel).toBe('重新核对')

    const unknownTotal = galleryStatus(
      state({ pageCount: null, rendered: 2, pages: [page(1), page(2)] }),
      200,
      { dpiUnconfirmed: true },
    )
    expect(unknownTotal.headline).toBe('页图状态未核对(已有 2 张)')
  })

  it('一张都没有时「未确认」不改变结论:那还是「未渲染」', () => {
    const s = galleryStatus(
      state({ rendered: 0, pages: [], manifest: null, upToDate: false }),
      200,
      { dpiUnconfirmed: true },
    )
    expect(s.tone).toBe('empty')
    expect(s.actionLabel).toBe('渲染页图')
  })
})

describe('pageImageSrc(页图地址带渲染版本号)', () => {
  it('带上清单里的 renderedAt —— 否则换了 DPI 还显示浏览器缓存里的旧图', () => {
    // 页图路径**不随 DPI 变**(原地覆盖),而 `/api/files/**` 是 max-age=3600:
    // 不带上「这一版是哪一次渲染的」,用户看到的尺寸说明是新的、图却是旧的。
    expect(pageImageSrc(state(), page(3))).toBe(`${page(3).url}?v=2026-10-14T08%3A00%3A00.000Z`)
  })

  it('没有清单(理论上不会走到)就退回裸地址,而不是拼出一个 undefined', () => {
    const s = state({ manifest: null })
    expect(pageImageSrc(s, page(1))).toBe(page(1).url)
    expect(pageImageSrc(s, page(1))).not.toContain('undefined')
  })

  it('不同次渲染给出不同的版本号 —— 重渲染必然换新', () => {
    const a = pageImageSrc(state(), page(1))
    const b = pageImageSrc(
      state({
        manifest: {
          dpi: 200,
          renderedAt: '2026-10-14T09:30:00.000Z',
          enhancement: 'white-flatten-grayscale-normalize-sharpen-v1',
        },
      }),
      page(1),
    )
    expect(a).not.toBe(b)
  })
})

describe('renderSummary(渲染完的一句话交代)', () => {
  function outcome(over: Partial<RenderOutcome> = {}): RenderOutcome {
    return {
      ...state({ pages: [page(1), page(2)] }),
      pageCount: 2,
      rendered: 2,
      written: 2,
      skipped: 0,
      removed: 0,
      elapsedMs: 439,
      ...over,
    }
  }

  it('写了页:报写入页数与耗时', () => {
    expect(renderSummary(outcome())).toBe('写入 2 页 · 439 ms')
  })

  it('**幂等命中**要说清「未写入」—— 只说「完成」会让人以为又写了一遍', () => {
    const text = renderSummary(outcome({ written: 0, skipped: 12, pageCount: 12, rendered: 12 }))
    expect(text).toContain('未写入')
    expect(text).toContain('跳过 12 页')
  })

  it('清掉多余页图时说清张数', () => {
    const text = renderSummary(outcome({ written: 2, removed: 3 }))
    expect(text).toBe('写入 2 页、清掉 3 张多余的页图 · 439 ms')
  })

  it('耗时:不足 1 秒按毫秒,超过按秒 —— 渲染几页就是几十毫秒,写成「0.0 s」等于没写', () => {
    expect(renderSummary(outcome({ elapsedMs: 42 }))).toContain('42 ms')
    expect(renderSummary(outcome({ elapsedMs: 3341 }))).toContain('3.3 s')
  })
})

describe('formatDuration / pageLabel', () => {
  it('毫秒 ↔ 秒的分界在 1000ms,且不会算出 0', () => {
    expect(formatDuration(0)).toBe('1 ms')
    expect(formatDuration(0.4)).toBe('1 ms')
    expect(formatDuration(999)).toBe('999 ms')
    expect(formatDuration(1000)).toBe('1.0 s')
    expect(formatDuration(3341)).toBe('3.3 s')
  })

  it('页码统一写「第 N 页」(页号是这套东西的权威,口径要一致)', () => {
    expect(pageLabel(1)).toBe('第 1 页')
    expect(pageLabel(12)).toBe('第 12 页')
    expect(pageLabel(97)).toBe('第 97 页')
  })
})

describe('DPI_PRESETS', () => {
  it('含 OCR 预设的 200 / 300 / 400,且都在接口允许的 72–600 内', () => {
    expect(DPI_PRESETS).toContain(200)
    expect(DPI_PRESETS).toContain(300)
    expect(DPI_PRESETS).toContain(400)
    for (const dpi of DPI_PRESETS) {
      expect(dpi).toBeGreaterThanOrEqual(72)
      expect(dpi).toBeLessThanOrEqual(600)
    }
  })
})

describe('describeRenderFailure(失败原因 → 可执行的中文)', () => {
  it('**不把引擎的英文原句直接摆给用户**(这是独立 UI 验收点名的:红条吐 PDFium 原句)', () => {
    const message = describeRenderFailure('渲染失败:File not in PDF format or corrupted')
    expect(message).not.toContain('File not in PDF format')
    expect(message).toContain('不是有效的 PDF')
    // 可执行:说清下一步做什么,而不是只说「失败了」。
    expect(message).toContain('另存')
    // 与主按钮的动词对齐:失败后按钮是「重新渲染」(= 重试),所以先劝重试、再劝换文件。
    // 顺序反了会读成「别点那颗按钮,去换文件」。
    expect(message.indexOf('重试')).toBeLessThan(message.indexOf('换一份文件'))
  })

  it('加密件给「先去密码」,而不是笼统的重试', () => {
    const message = describeRenderFailure('渲染失败:Document is password protected')
    expect(message).toContain('密码')
    expect(message).not.toContain('password')
  })

  it('认不出的原因**不吞**:保留原句(排查要靠它),但补一句下一步', () => {
    const message = describeRenderFailure('渲染失败:some unexpected engine error 0x2A')
    expect(message).toContain('some unexpected engine error 0x2A')
    expect(message).toContain('重试')
  })

  it('空 / 只有前缀时不产出「渲染失败:」这种半句话', () => {
    for (const raw of ['', '渲染失败:', '渲染失败:   ']) {
      const message = describeRenderFailure(raw)
      expect(message).not.toMatch(/渲染失败[:：]/)
      expect(message.length).toBeGreaterThan(0)
    }
  })

  it('前缀:全角(U+FF1A)/ 半角冒号、夹空格,都归一化成同一句(精确断言)', () => {
    // 上一版这条用的是两个**看起来一样**的 ASCII 冒号,等于没测全角(独立审查 F2)。
    // 这里用显式转义写 U+FF1A,并对归一化后的整句做精确断言,不只是「不含某某」。
    const expected = '渲染没有成功:xxx。可以重试;反复失败就换一份文件,或检查文件是否损坏。'
    expect(describeRenderFailure('渲染失败:xxx')).toBe(expected)
    expect(describeRenderFailure('渲染失败\uFF1Axxx')).toBe(expected)
    expect(describeRenderFailure('渲染失败 : xxx')).toBe(expected)
    expect(describeRenderFailure('渲染失败\uFF1A xxx')).toBe(expected)
  })

  it('句末已有标点时不拼出「。。」', () => {
    expect(describeRenderFailure('渲染失败:boom。')).toBe(
      '渲染没有成功:boom。可以重试;反复失败就换一份文件,或检查文件是否损坏。',
    )
    expect(describeRenderFailure('渲染失败:boom.')).not.toContain('boom..')
  })

  it('文件已不在库里给的是「刷新列表」,不是笼统的重试(F1 相关:原因要能行动)', () => {
    const message = describeRenderFailure('渲染失败:文件不存在:jxj/a.pdf')
    expect(message).toContain('已经不在文件库里')
    expect(message).not.toContain('文件不存在:')
  })

  it('**空说明只出一层话**(F1):不再被双重包装成重复标点 + 重复劝重试', () => {
    const message = describeRenderFailure('')
    expect(message).toBe('渲染没有成功,也没拿到具体原因(可能是网络或服务中断)。可以重试。')
    // 旧实现会把「渲染失败,请重试。」再包一层 → 「…重试。。可以重试;…」
    expect(message).not.toContain('。。')
    expect(message.match(/重试/g) ?? []).toHaveLength(1)
  })

  it('状态词是「渲染失败」,不是「未渲染」—— 试过没成,与还没动手是两件事', () => {
    expect(RENDER_FAILED_WORD).toBe('渲染失败')
  })
})
