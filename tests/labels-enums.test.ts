import { describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import {
  ALIAS_SOURCE_KINDS,
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  EVENTS,
  EXPORT_IMPORT_STATUSES,
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

describe('平台接口取值只有一处出处(契约 §2.4)', () => {
  it('取值数组 / 展示顺序 / 标签表三者同值', () => {
    expect(IDENTITY(PLATFORM_INTERFACE_ORDER)).toEqual(IDENTITY(PLATFORM_INTERFACE_VALUES))
    expect(IDENTITY(Object.keys(PLATFORM_INTERFACES))).toEqual(IDENTITY(PLATFORM_INTERFACE_VALUES))
  })

  it('取值数组与 platformQuery.interface 的列枚举同值(跨称号漂移的护栏)', () => {
    expect(IDENTITY(PLATFORM_INTERFACE_VALUES)).toEqual(IDENTITY(schema.platformQuery.interface.enumValues))
  })
})
