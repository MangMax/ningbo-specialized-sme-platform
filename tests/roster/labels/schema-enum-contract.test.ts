import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { enterpriseAlias } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent } from '../../../db/postgresql/ledger-tables'
import { differenceReason } from '../../../db/postgresql/roster-selection-tables'
import {
  ALIAS_SOURCE_KINDS,
  DIFFERENCE_MEASURES,
  DIFFERENCE_REASONS,
  DIFFERENCE_STATUSES,
  DIFFERENCE_STATUS_ORDER,
  DIFFERENCE_STATUS_RAILS,
  DIFFERENCE_STATUS_VARIANTS,
  EVENTS,
  FIRST_RECOGNITION_REASONS,
  FIRST_RECOGNITION_REASON_ORDER,
  FIRST_RECOGNITION_STATUSES,
  FIRST_RECOGNITION_STATUS_ORDER,
  IMPORT_SOURCE_KIND_ORDER,
  IMPORT_SOURCE_KINDS,
  PLATFORM_INTERFACES,
  PLATFORM_INTERFACE_ORDER,
  PLATFORM_INTERFACE_VALUES,
  PLATFORM_QUERY_STATUSES,
  RELATION_MATCH_BASES,
  REVIEW_OUTCOMES,
  SOURCES,
  VERIFICATION_STATUSES,
  VERIFICATION_STATUS_ORDER,
} from '../../../layers/sme-roster/lib/labels'
import {
  FIRST_RECOGNITION_PENDING_REASON_VALUES,
  FIRST_RECOGNITION_STATUS_VALUES,
} from '../../../layers/sme-roster/lib/roster/first-recognition'

const platformDdl = readFileSync(new URL('../../../db/postgresql/roster-platform-schema.sql', import.meta.url), 'utf8')
function constraintValues(name: string) {
  const declaration = platformDdl.split('\n').find(line => line.includes(`CONSTRAINT ${name} CHECK`))
  if (!declaration) throw new Error(`Missing PostgreSQL constraint ${name}`)
  return [...declaration.matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

const IDENTITY = (values: Iterable<string>) => [...values].sort()

const CASES: Array<{ name: string; table: Record<string, string>; values: readonly string[] }> = [
  { name: 'platformCollection.interface', table: PLATFORM_INTERFACES, values: constraintValues('platform_collection_interface_ck') },
  { name: 'platformCollection.status', table: PLATFORM_QUERY_STATUSES, values: constraintValues('platform_collection_status_ck') },
  { name: 'platformObservationAssignment.matchBasis', table: RELATION_MATCH_BASES, values: constraintValues('platform_assignment_match_ck') },
  { name: 'differenceReason.status', table: DIFFERENCE_STATUSES, values: differenceReason.status.enumValues },
  { name: 'differenceReason.reasonCode', table: DIFFERENCE_REASONS, values: differenceReason.reasonCode.enumValues },
  { name: 'differenceReason.measureCode', table: DIFFERENCE_MEASURES, values: differenceReason.measureCode.enumValues },
  { name: 'enterpriseAlias.verificationStatus', table: VERIFICATION_STATUSES, values: enterpriseAlias.verificationStatus.enumValues },
  { name: 'enterpriseAlias.sourceKind', table: ALIAS_SOURCE_KINDS, values: enterpriseAlias.sourceKind.enumValues },
  { name: 'recordEvent.reviewOutcome', table: REVIEW_OUTCOMES, values: recordEvent.reviewOutcome.enumValues },
  { name: 'recordEvent.eventType', table: EVENTS, values: recordEvent.eventType.enumValues },
  { name: 'record.source', table: SOURCES, values: record.source.enumValues },
]

describe('PostgreSQL 取值集与业务标签', () => {
  for (const { name, table, values } of CASES) {
    it(`${name}:标签表的键与取值逐字一致`, () => {
      expect(IDENTITY(Object.keys(table))).toEqual(IDENTITY(values))
    })
  }
})

describe('维护状态的中文标签与展示顺序', () => {
  it('别名撤回显示为已撤回并排在待核实之后，平台关系与差异原因仍只允许两态', () => {
    expect(VERIFICATION_STATUSES.withdrawn).toBe('已撤回')
    expect(VERIFICATION_STATUS_ORDER).toEqual(['confirmed', 'pending', 'withdrawn'])
    expect(constraintValues('platform_assignment_verification_ck')).toEqual(['confirmed', 'pending'])
    expect(differenceReason.verificationStatus.enumValues).toEqual(['confirmed', 'pending'])
  })

  it('正式事件更正具有中文来源标签并追加到原有来源展示顺序', () => {
    expect(IMPORT_SOURCE_KINDS.event_correction).toBe('正式事件更正')
    expect(IMPORT_SOURCE_KINDS.platform_archive).toBe('平台采集归档')
    expect(IMPORT_SOURCE_KIND_ORDER).toEqual([
      'announcement', 'platform_export', 'alias_evidence',
      'event_correction',
      'platform_archive',
    ])
  })
})

describe('差异状态的标签 / 徽章色 / 展示顺序同键集合(RL-15)', () => {
  it('三张表与 difference_reason.status 的取值逐字一致', () => {
    const values = differenceReason.status.enumValues
    expect(IDENTITY(Object.keys(DIFFERENCE_STATUSES))).toEqual(IDENTITY(values))
    expect(IDENTITY(Object.keys(DIFFERENCE_STATUS_VARIANTS))).toEqual(IDENTITY(values))
    expect(IDENTITY(DIFFERENCE_STATUS_ORDER)).toEqual(IDENTITY(values))
    expect(IDENTITY(Object.keys(DIFFERENCE_STATUS_RAILS))).toEqual(IDENTITY(values))
  })

  it('每个状态都有徽章色 —— 没有取值会掉到兜底的 quiet', () => {
    for (const code of differenceReason.status.enumValues) {
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

  it('取值数组与 platformCollection.interface 的列枚举同值(跨称号漂移的护栏)', () => {
    expect(IDENTITY(PLATFORM_INTERFACE_VALUES)).toEqual(IDENTITY(constraintValues('platform_collection_interface_ck')))
  })
})
