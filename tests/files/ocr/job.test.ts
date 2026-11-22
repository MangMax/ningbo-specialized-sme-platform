import { describe, expect, it } from 'vitest'
import { parseOcrParams } from '../../../layers/core/server/utils/jobs/ocr'
import { DEFAULT_OCR_OPTIONAL_PAYLOAD, ocrRequestVariant, pagesFromJsonl } from '../../../layers/core/server/utils/ocr-api'
import { ocrPageCacheKey } from '../../../layers/core/server/utils/ocr-page-cache'

describe('ocr 任务的参数校验(纯函数,提交时跑)', () => {
  it('files 非空、必须是 PDF;model 给成非字符串就报错', () => {
    expect(parseOcrParams({}).ok).toBe(false)
    expect(parseOcrParams({ files: [] }).ok).toBe(false)
    expect(parseOcrParams({ files: [1] }).ok).toBe(false)
    const notPdf = parseOcrParams({ files: ['jxj/announcement/2024/1/x.docx'] })
    expect(notPdf.ok).toBe(false)
    if (!notPdf.ok) expect(notPdf.message).toContain('只吃 PDF')
    expect(parseOcrParams({ files: ['a.pdf'], model: 3 }).ok).toBe(false)

    const good = parseOcrParams({ files: [' jxj/a.pdf '], model: ' PaddleOCR-VL-1.6 ' })
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(good.params).toEqual({ files: ['jxj/a.pdf'], model: 'PaddleOCR-VL-1.6' })
  })

  it('★ 显式拒掉 pageRanges(只识别某几页会让页码静默错位)', () => {
    const r = parseOcrParams({ files: ['a.pdf'], pageRanges: '3-5' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('pageRanges')
      expect(r.message).toContain('页码')
    }
    expect(parseOcrParams({ files: ['a.pdf'], pages: '1' }).ok).toBe(false)
    expect(parseOcrParams({ files: ['a.pdf'], range: '1-2' }).ok).toBe(false)
    // 空值不算「用了」这个参数。
    expect(parseOcrParams({ files: ['a.pdf'], pageRanges: '' }).ok).toBe(true)
  })
})

describe('ocr-api 的纯解析件', () => {
  it('JSONL 按 `layoutParsingResults[].markdown.text` 平铺成页,页号从 1 起', () => {
    const jsonl = [
      JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: 'p1' } }, { markdown: { text: 'p2' } }] } }),
      JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: 'p3' } }] } }),
    ].join('\n')
    expect(pagesFromJsonl(jsonl).map((p) => [p.page, p.markdown])).toEqual([
      [1, 'p1'],
      [2, 'p2'],
      [3, 'p3'],
    ])
  })

  it('形状不对(不是文档解析模型)时明确报错,不静默给空结果', () => {
    const bad = JSON.stringify({ result: { ocrResults: [] } })
    expect(() => pagesFromJsonl(bad)).toThrow(/layoutParsingResults/)
  })
})

describe('中转命中判据(纯函数)', () => {
  it('ocrRequestVariant:同模型同选项稳定;模型或有效选项变则指纹变', () => {
    expect(ocrRequestVariant('m')).toBe(ocrRequestVariant('m'))
    expect(ocrRequestVariant('m')).not.toBe(ocrRequestVariant('m2'))
    // 「影响 OCR 的选项」就是实际发出的 optionalPayload —— 它一变,指纹必须变。
    const tweaked = { ...DEFAULT_OCR_OPTIONAL_PAYLOAD, temperature: 0.2 }
    expect(ocrRequestVariant('m')).not.toBe(ocrRequestVariant('m', tweaked))
  })

  it('ocrPageCacheKey:页图哈希或指纹任一不同 ⇒ key 不同', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(ocrPageCacheKey(a, 'v')).toBe(ocrPageCacheKey(a, 'v'))
    expect(ocrPageCacheKey(a, 'v')).not.toBe(ocrPageCacheKey(b, 'v'))
    expect(ocrPageCacheKey(a, 'v')).not.toBe(ocrPageCacheKey(a, 'v2'))
  })
})
