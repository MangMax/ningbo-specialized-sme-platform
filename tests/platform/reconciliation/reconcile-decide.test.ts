/** Query processing facts only; business interpretation remains with the agent. */
import { describe, expect, it } from 'vitest'
import { classifyRawQuery, type PlatformRow } from '../../../lib/platform'
import type { PlatformInterface } from '../../../layers/sme-roster/lib/labels'
import { relationFromRow, type PlatformRelationRecord } from '../../../lib/platform/identity'
import {
  type ReconcileQueryEvidence,
  type ReconcileTarget,
  decideDifference,
} from '../../../lib/platform/reconcile'

import { platformFixture as fixture } from '../fixtures/source-replay'

const USCC = '91330211255994457P'
const OLD_NAME = '宁波上航测绘有限公司'
const NEW_NAME = '宁波上航测绘股份有限公司'
const QUERIED_AT = '2026-10-15T17:11:21.514Z'

/** 用真实夹具构造一次查询证据(走真的解析器,不手写记录)。 */
function evidenceFromFixture(
  name: string,
  meta: { interface: PlatformInterface; rdjb?: string },
): ReconcileQueryEvidence {
  const outcome = classifyRawQuery(fixture(name), { ...meta, queryKey: USCC, queriedAt: QUERIED_AT })
  return {
    interface: outcome.interface,
    rdjb: outcome.rdjb,
    queriedAt: outcome.queriedAt,
    status: outcome.status,
    // Named fixtures explicitly declare their entire single-page total.
    completeness: outcome.status === 'failed' ? 'partial' : 'complete',
    failureReason: outcome.failureReason,
    relations: outcome.rows.map((row, index) =>
      relationFromRow(row, { interface: outcome.interface, rdjb: outcome.rdjb, queryKey: USCC, sequenceNo: index + 1 }),
    ),
  }
}

/** 合成一次查询(用于构造合成场景,不依赖真实夹具)。 */
function evidence(
  meta: { interface: PlatformInterface; rdjb?: string },
  rows: PlatformRow[],
  status: ReconcileQueryEvidence['status'] = rows.length ? 'success' : 'no_record',
): ReconcileQueryEvidence {
  const rdjb = meta.rdjb ?? ''
  return {
    interface: meta.interface,
    rdjb,
    queriedAt: QUERIED_AT,
    status,
    completeness: status === 'failed' || status === 'partial' ? 'partial' : 'complete',
    failureReason: null,
    relations: rows.map((row, index) =>
      relationFromRow(row, { interface: meta.interface, rdjb, queryKey: USCC, sequenceNo: index + 1 }),
    ),
  }
}

function failedEvidence(
  meta: { interface: PlatformInterface; rdjb?: string },
  reason: string,
): ReconcileQueryEvidence {
  return {
    interface: meta.interface,
    rdjb: meta.rdjb ?? '',
    queriedAt: QUERIED_AT,
    status: 'failed',
    failureReason: reason,
    relations: [],
  }
}

function target(overrides: Partial<ReconcileTarget> = {}): ReconcileTarget {
  return {
    enterpriseId: 7289,
    enterpriseName: NEW_NAME,
    enterpriseNameNorm: NEW_NAME,
    uscc: USCC,
    titleCode: 'specialized_sme',
    direction: 'extra_in_miit',
    ...overrides,
  }
}

/** 真实夹具 rdjb=1/2 各 0 行 + rdjb=3 的 6 行 + 申报接口的 2 行。 */
const realQueries = (): ReconcileQueryEvidence[] => [
  evidenceFromFixture('business-list-rdjb1-empty.html', { interface: 'business_list', rdjb: '1' }),
  evidenceFromFixture('business-list-rdjb2-empty.html', { interface: 'business_list', rdjb: '2' }),
  evidenceFromFixture('business-list-rdjb3.html', { interface: 'business_list', rdjb: '3' }),
  evidenceFromFixture('apply-list.json', { interface: 'apply_list' }),
]


describe('query processing only', () => {
  it('missing code and no query remain not_queried without invented names or causes', () => {
    for (const t of [target({ uscc: null }), target()]) {
      const v = decideDifference(t, [])
      expect(v.status).toBe('not_queried')
      expect(v.reasonCode).toBeNull()
      expect(v.aliases).toEqual([])
    }
  })
  it('reports no_record only after all four required slots completed empty', () => {
    const slots = [evidence({ interface: 'business_list', rdjb: '1' }, []), evidence({ interface: 'business_list', rdjb: '2' }, []), evidence({ interface: 'business_list', rdjb: '3' }, []), evidence({ interface: 'apply_list' }, [])]
    expect(decideDifference(target(), slots).status).toBe('no_record')
    expect(decideDifference(target(), slots.slice(1)).status).toBe('query_failed')
    slots[0] = failedEvidence({ interface: 'business_list', rdjb: '1' }, 'expired session')
    expect(decideDifference(target(), slots).status).toBe('query_failed')
  })

  it('historical zero-row success without completeness proof cannot become no_record', () => {
    const slots = [evidence({ interface: 'business_list', rdjb: '1' }, []), evidence({ interface: 'business_list', rdjb: '2' }, []), evidence({ interface: 'business_list', rdjb: '3' }, []), evidence({ interface: 'apply_list' }, [])]
    for (const slot of slots) delete slot.completeness
    expect(decideDifference(target(), slots)).toMatchObject({ status: 'query_failed', reasonCode: null })
  })
  it('failed queries do not turn into no_record or confirmed reasons', () => {
    const v = decideDifference(target(), [failedEvidence({ interface: 'apply_list' }, 'timeout')])
    expect(v.status).toBe('query_failed')
    expect(v.reasonCode).toBeNull()
    expect(v.verificationStatus).toBe('pending')
  })
  it.each(['已退回待审核', '已退回', '撤回', '终审不通过', '终审通过', '注销', '待审核'])('keeps platform workflow %s as evidence without inferring a business cause', status => {
    const queries = [evidence({ interface: 'business_list', rdjb: '1' }, [{ id: 'one', qymc: NEW_NAME, tyshxydm: USCC, cszt: status, szsfmc: '浙江省', sqsj: '2026-04-09 16:30:06' }])]
    const v = decideDifference(target(), queries)
    expect(v).toMatchObject({ status: 'needs_review', reasonCode: null, measureCode: 'manual_review', verificationStatus: 'pending', movedIn: null, aliases: [] })
    expect(v.reasonNote).toContain(status)
    expect(v.reasonNote).toContain('尚未完整')
  })
  it('preserves the multi-name fixture as evidence without confirming aliases or migration', () => {
    const queries = realQueries()
    const before = JSON.stringify(queries)
    const v = decideDifference(target(), queries)
    expect(v.status).toBe('needs_review')
    expect(v.reasonCode).toBeNull()
    expect(v.evidenceQuery?.rdjb).toBe('3')
    expect(v.aliases).toEqual([])
    expect(v.movedIn).toBeNull()
    expect(JSON.stringify(queries)).toBe(before)
    expect(queries.flatMap(q => q.relations)).toHaveLength(8)
  })
  it.each(['missing_in_miit', 'extra_in_miit'] as const)('does not default %s to platform_stale', direction => {
    const v = decideDifference(target({ direction }), realQueries())
    expect(v.status).toBe('needs_review')
    expect(v.reasonCode).toBeNull()
  })
})
