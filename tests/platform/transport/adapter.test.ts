import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUSINESS_GRID,
  APPLY_GRID,
  PlatformResponseError,
  PlatformSessionExpiredError,
  assertSessionAlive,
  classifyPlatformResponse,
  extractEmbeddedZrar,
  parsePlatformList,
} from '../../../lib/platform/adapter'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../fixtures/platform', name), 'utf8')

const RDJB3 = fixture('business-list-rdjb3.html')
const RDJB1 = fixture('business-list-rdjb1-empty.html')
const RDJB2 = fixture('business-list-rdjb2-empty.html')
const APPLY = fixture('apply-list.json')
const EXPIRED = fixture('session-expired.json')
const TABLE = fixture('rendered-table.html')

describe('parsePlatformList:三级回退', () => {
  it('businessList 的 HTML 响应:从页尾嵌入脚本解析出全部 6 条,逐条保序', () => {
    const parsed = parsePlatformList(RDJB3, BUSINESS_GRID)
    expect(parsed.source).toBe('html-script')
    expect(parsed.maxCount).toBe(6)
    expect(parsed.rows).toHaveLength(6)
    expect(parsed.rows.map((r) => r.id)).toEqual([
      'SQ332022062212391',
      'SQ332023041984270',
      'SQ332024052128274',
      'SQ332025060392166',
      'SQ332025062064737',
      'SQ332026052238796',
    ])
    // 平台行字段原样保留(不做业务解释)。
    expect(parsed.rows[0]!.qymc).toBe('宁波上航测绘有限公司')
    expect(parsed.rows[3]!.personuuid).toBe('第四批')
  })

  it('queryList 的纯 JSON 响应:按 Content-Type 不可信,只嗅 body', () => {
    const parsed = parsePlatformList(APPLY, APPLY_GRID)
    expect(parsed.source).toBe('json')
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows.map((r) => r.id)).toEqual([
      'SQ332025060392166',
      'SQ332022062212391',
    ])
    expect(parsed.rows[1]!.year).toBe('2022')
  })

  it('已渲染表格是第三级回退(前两级都拿不到时才用)', () => {
    const parsed = parsePlatformList(TABLE, BUSINESS_GRID)
    expect(parsed.source).toBe('html-table')
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]!.qymc).toBe('宁波合成示例科技有限公司')
  })

  it('结构看不懂时抛 PlatformResponseError,绝不把「看不懂」当「没有记录」', () => {
    expect(() => parsePlatformList('<html><body>你好</body></html>', BUSINESS_GRID)).toThrow(
      PlatformResponseError,
    )
  })
})

describe('assertSessionAlive:会话过期是 failed,不是 no_record', () => {
  it('HTTP 200 + statusCode 301 判为会话过期', () => {
    expect(() => assertSessionAlive(EXPIRED)).toThrow(PlatformSessionExpiredError)
  })

  it('空结果(0 行)的响应体不会被误判为过期', () => {
    expect(() => assertSessionAlive(RDJB1)).not.toThrow()
    expect(extractEmbeddedZrar(RDJB1)).toBeTypeOf('object')
  })
})

describe('classifyPlatformResponse:四态口径', () => {
  const meta = { interface: 'business_list' as const, queryKey: '91330211255994457P', rdjb: '3' }

  it('有行 ⇒ success', () => {
    const outcome = classifyPlatformResponse(RDJB3, BUSINESS_GRID, meta)
    expect(outcome.status).toBe('success')
    expect(outcome.rows).toHaveLength(6)
    expect(outcome.failureReason).toBeNull()
  })

  it('请求成功但 0 行 ⇒ no_record', () => {
    for (const raw of [RDJB1, RDJB2]) {
      const outcome = classifyPlatformResponse(raw, BUSINESS_GRID, meta)
      expect(outcome.status).toBe('no_record')
      expect(outcome.rows).toEqual([])
      expect(outcome.failureReason).toBeNull()
    }
  })

  it('会话过期 ⇒ failed,带上失败原因;绝不落成 no_record', () => {
    const outcome = classifyPlatformResponse(EXPIRED, BUSINESS_GRID, meta)
    expect(outcome.status).toBe('failed')
    expect(outcome.failureReason).toContain('登录超时')
    expect(outcome.rows).toEqual([])
  })

  it('结构异常 ⇒ failed', () => {
    const outcome = classifyPlatformResponse('<html>结构变了</html>', BUSINESS_GRID, meta)
    expect(outcome.status).toBe('failed')
    expect(outcome.failureReason).toBeTruthy()
  })
})
