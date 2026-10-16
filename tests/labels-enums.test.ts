import { describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import {
  ALIAS_SOURCE_KINDS,
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_ORDER,
  DIFFERENCE_STATUS_VARIANTS,
  EVENTS,
  EXPORT_IMPORT_STATUSES,
  FIRST_RECOGNITION_REASONS,
  FIRST_RECOGNITION_REASON_ORDER,
  FIRST_RECOGNITION_STATUSES,
  FIRST_RECOGNITION_STATUS_ORDER,
  IMPORT_BATCH_STATUSES,
  IMPORT_SOURCE_KINDS,
  PLATFORM_INTERFACES,
  PLATFORM_INTERFACE_ORDER,
  PLATFORM_INTERFACE_VALUES,
  PLATFORM_QUERY_STATUSES,
  RELATION_DECLARE_KINDS,
  RELATION_MATCH_BASES,
  REVIEW_OUTCOMES,
  SOURCES,
  VERIFICATION_STATUSES,
} from '../lib/labels'
import {
  FIRST_RECOGNITION_PENDING_REASON_VALUES,
  FIRST_RECOGNITION_STATUS_VALUES,
} from '../lib/roster/first-recognition'

/**
 * 枚举取值只有**一份**:`db/schema.ts` 的列枚举(库层面的冻结)与 `lib/labels.ts` 的
 * 中文标签表(契约 §2 声明的「全表」)必须逐字对齐。
 *
 * 为什么值得单钉一条:写入侧的校验集现在**从既有常量派生**(不再逐个抄一遍),
 * 派生本身不会漂移,但**两个来源之间**仍可能单方面改动 —— 例如给
 * `platform_query.status` 加了第五个取值却忘了标签,或反过来。
 * 这条用例把两侧钉在一起:任何一侧单方面改,这里立刻红。
 *
 * 平台接口同时还钉住 S5 的「联合类型 + 取值数组的唯一出处」:
 * `PLATFORM_INTERFACE_VALUES`(取值)、`PLATFORM_INTERFACE_ORDER`(展示顺序)、
 * `PLATFORM_INTERFACES`(标签表)三者必须是同一组取值。
 */

const IDENTITY = (values: Iterable<string>) => [...values].sort()

const CASES: Array<{ name: string; table: Record<string, string>; values: readonly string[] }> = [
  { name: 'platformQuery.interface', table: PLATFORM_INTERFACES, values: schema.platformQuery.interface.enumValues },
  { name: 'platformQuery.status', table: PLATFORM_QUERY_STATUSES, values: schema.platformQuery.status.enumValues },
  { name: 'platformRelation.matchBasis', table: RELATION_MATCH_BASES, values: schema.platformRelation.matchBasis.enumValues },
  { name: 'platformRelation.declareKind', table: RELATION_DECLARE_KINDS, values: schema.platformRelation.declareKind.enumValues },
  { name: 'differenceReason.status', table: DIFFERENCE_STATUSES, values: schema.differenceReason.status.enumValues },
  { name: 'differenceReason.reasonCode', table: DIFFERENCE_REASONS, values: schema.differenceReason.reasonCode.enumValues },
  { name: 'differenceReason.measureCode', table: DIFFERENCE_MEASURES, values: schema.differenceReason.measureCode.enumValues },
  { name: 'enterpriseAlias.verificationStatus', table: VERIFICATION_STATUSES, values: schema.enterpriseAlias.verificationStatus.enumValues },
  { name: 'enterpriseAlias.sourceKind', table: ALIAS_SOURCE_KINDS, values: schema.enterpriseAlias.sourceKind.enumValues },
  { name: 'importBatch.sourceKind', table: IMPORT_SOURCE_KINDS, values: schema.importBatch.sourceKind.enumValues },
  { name: 'importBatch.status', table: IMPORT_BATCH_STATUSES, values: schema.importBatch.status.enumValues },
  { name: 'recordEvent.reviewOutcome', table: REVIEW_OUTCOMES, values: schema.recordEvent.reviewOutcome.enumValues },
  { name: 'recordEvent.eventType', table: EVENTS, values: schema.recordEvent.eventType.enumValues },
  { name: 'record.source', table: SOURCES, values: schema.record.source.enumValues },
  { name: 'platformExportBatch.importStatus', table: EXPORT_IMPORT_STATUSES, values: schema.platformExportBatch.importStatus.enumValues },
]

describe('冻结取值集:db/schema.ts 的列枚举 ↔ lib/labels.ts 的标签表', () => {
  for (const { name, table, values } of CASES) {
    it(`${name}:标签表的键与列枚举逐字一致`, () => {
      expect(IDENTITY(Object.keys(table))).toEqual(IDENTITY(values))
    })
  }
})

describe('差异状态的标签 / 徽章色 / 展示顺序同键集合(RL-15)', () => {
  it('三张表与 difference_reason.status 的列枚举逐字一致', () => {
    const values = schema.differenceReason.status.enumValues
    expect(IDENTITY(Object.keys(DIFFERENCE_STATUSES))).toEqual(IDENTITY(values))
    expect(IDENTITY(Object.keys(DIFFERENCE_STATUS_VARIANTS))).toEqual(IDENTITY(values))
    expect(IDENTITY(DIFFERENCE_STATUS_ORDER)).toEqual(IDENTITY(values))
  })

  it('每个状态都有徽章色 —— 没有取值会掉到兜底的 quiet', () => {
    for (const code of schema.differenceReason.status.enumValues) {
      expect(DIFFERENCE_STATUS_VARIANTS[code]).toBeTruthy()
    }
  })
})

describe('首次认定的取值也是一处(RL-08,契约 §7.5 增量)', () => {
  /**
   * 这两组取值不是 schema 列(它们是**判定结果**),所以钉法换成「判定的取值集合 ↔
   * 标签表 ↔ 展示顺序 ↔ 网页上的筛选下拉」四者同键集合 —— 改一处忘另一处,这里立刻红。
   */
  it('两态:判定取值 / 标签表 / 展示顺序三方同键', () => {
    expect(IDENTITY(Object.keys(FIRST_RECOGNITION_STATUSES))).toEqual(IDENTITY(FIRST_RECOGNITION_STATUS_VALUES))
    expect(IDENTITY(FIRST_RECOGNITION_STATUS_ORDER)).toEqual(IDENTITY(FIRST_RECOGNITION_STATUS_VALUES))
  })

  it('三条待确认原因:判定取值 / 标签表 / 展示顺序(即优先级)三方一致', () => {
    expect(IDENTITY(Object.keys(FIRST_RECOGNITION_REASONS))).toEqual(IDENTITY(FIRST_RECOGNITION_PENDING_REASON_VALUES))
    // 顺序 = 优先级,这里是**逐位**相等,不是同键集合 —— 判据的优先级是口径的一部分。
    expect(FIRST_RECOGNITION_REASON_ORDER).toEqual([...FIRST_RECOGNITION_PENDING_REASON_VALUES])
  })

  it('每个取值都有非空标签(没有取值会掉到兜底的英文代号)', () => {
    for (const code of FIRST_RECOGNITION_STATUS_VALUES) expect(FIRST_RECOGNITION_STATUSES[code]).toBeTruthy()
    for (const code of FIRST_RECOGNITION_PENDING_REASON_VALUES) expect(FIRST_RECOGNITION_REASONS[code]).toBeTruthy()
  })
})

describe('平台接口取值只有一处出处(契约 §2.4)', () => {
  it('取值数组 / 展示顺序 / 标签表三者同值', () => {
    expect(IDENTITY(PLATFORM_INTERFACE_ORDER)).toEqual(IDENTITY(PLATFORM_INTERFACE_VALUES))
    expect(IDENTITY(Object.keys(PLATFORM_INTERFACES))).toEqual(IDENTITY(PLATFORM_INTERFACE_VALUES))
  })

  it('取值数组与 platformQuery.interface 的列枚举同值(跨称号漂移的护栏)', () => {
    expect(IDENTITY(PLATFORM_INTERFACE_VALUES)).toEqual(IDENTITY(schema.platformQuery.interface.enumValues))
  })
})
