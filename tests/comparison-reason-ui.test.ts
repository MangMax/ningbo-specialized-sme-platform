// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ComparisonReconcile from '../components/ComparisonReconcile.vue'
import ComparisonPlatformEvidence from '../components/ComparisonPlatformEvidence.vue'
import type {
  ComparisonDisposition,
  ComparisonPlatformEvidence as PlatformEvidence,
} from '../lib/comparison-platform'
import type { ReconcileEntry } from '../lib/reconcile'
import { TITLES } from '../lib/labels'

/**
 * 比对页「平台解释 / 平台证据」两列的**库内口径**(RL-15)。
 *
 * 用户 2026-10-16 反馈「三个称号从平台获取的数据都没了」—— 根因是解释缓存缺失时
 * 「平台解释」列整列退化成 `—`。这两列现在必须**读库**(`difference_reason` /
 * `platform_query` / `platform_relation`),并且:
 *  - 没有解释记录时显示状态机默认态「未查询」,**不是**「无数据」;
 *  - 「平台未更新」(`confirmed_reason` + `platform_stale`)**不得**显示成「无记录」;
 *  - 原因、配对的后续措施、可展开的接口证据(时点 / 接口 / 原始关系)都要看得到。
 */

/** 挂载的组件在用例之间逐个卸载 —— 不能只清 `document.body`(Tooltip 内容 teleport 到 body,
 *  提前清掉会让组件更新时找不到父节点、抛 `insertBefore of null`)。 */
const mounted: ReturnType<typeof mount>[] = []

function mountIn(component: Parameters<typeof mount>[0], options: Record<string, unknown>) {
  const wrapper = mount(component, { ...options, attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

function disposition(patch: Partial<ComparisonDisposition> = {}): ComparisonDisposition {
  return {
    explanationId: 1,
    status: 'not_queried',
    reasonCode: null,
    reasonNote: null,
    measureCode: null,
    measureNote: null,
    movedIn: null,
    verificationStatus: 'pending',
    recordedAt: null,
    evidenceQueryId: null,
    evidenceRelationId: null,
    ...patch,
  }
}

/** 展开 tooltip 并取回它渲染出的文字(内容 teleport 到 body)。 */
async function openAndReadText(wrapper: ReturnType<typeof mount>): Promise<string> {
  await wrapper.get('[data-testid="reconcile-badge"]').trigger('click')
  await new Promise((r) => setTimeout(r, 0))
  await wrapper.vm.$nextTick()
  return document.body.textContent ?? ''
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('比对行「平台解释」列:读库内状态与原因', () => {
  it('平台未更新(confirmed_reason + platform_stale)显示成「已确认原因 · 平台未更新」,**不是**「无记录」', async () => {
    const wrapper = mountIn(
      ComparisonReconcile,
      {
        props: {
          explanation: null,
          disposition: disposition({
            status: 'confirmed_reason',
            reasonCode: 'platform_stale',
            reasonNote: '平台关系状态「待审核」(2025-1),导出表尚未收录。',
            measureCode: 'mark_platform_snapshot',
            measureNote: '标明平台时点,不覆盖历史。',
            verificationStatus: 'confirmed',
            recordedAt: '2026-10-16T03:33:27.157Z',
            evidenceQueryId: 12,
            evidenceRelationId: 34,
          }),
        },
        attachTo: document.body,
      },
    )
    expect(wrapper.get('[data-testid="reconcile-badge"]').text()).toBe('已确认原因')
    const text = await openAndReadText(wrapper)
    expect(text).toContain('平台未更新')
    expect(text).toContain('标明平台时点,不覆盖历史')
    expect(text).toContain('待审核')
    expect(text).not.toContain('无记录')
    expect(text).not.toContain('已确认无差异')
  })

  it('待核实的行显示「待核实」并带出缺证据的说明(不伪装成有原因)', async () => {
    const wrapper = mountIn(ComparisonReconcile, {
      props: {
        explanation: null,
        disposition: disposition({
          status: 'needs_review',
          reasonNote: '平台关系的省份同时含宁波市与非宁波市,但申报时间不足以排出先后。',
          measureCode: 'manual_review',
          measureNote: '人工核对申报时间与区划后判定方向。',
        }),
      },
      attachTo: document.body,
    })
    expect(wrapper.get('[data-testid="reconcile-badge"]').text()).toBe('待核实')
    const text = await openAndReadText(wrapper)
    expect(text).toContain('转人工核实')
    expect(text).toContain('申报时间不足以排出先后')
  })

  it('没有解释记录 ⇒ 状态机默认态「未查询」,并说明还没有解释记录(不是「无数据」)', async () => {
    const wrapper = mountIn(ComparisonReconcile, {
      props: { explanation: null, disposition: disposition({ explanationId: null, status: 'not_queried' }) },
      attachTo: document.body,
    })
    expect(wrapper.get('[data-testid="reconcile-badge"]').text()).toBe('未查询')
    expect(wrapper.find('[data-testid="reconcile-empty"]').exists()).toBe(false)
    const text = await openAndReadText(wrapper)
    expect(text).toContain('还没有解释记录')
  })

  it('无统代无法直查:如实显示「未查询 · 转人工核实」与原因说明', async () => {
    const wrapper = mountIn(ComparisonReconcile, {
      props: {
        explanation: null,
        disposition: disposition({
          status: 'not_queried',
          reasonNote: '本企业无统一社会信用代码;平台两接口只认 tyshxydm,无法直查。',
          measureCode: 'manual_review',
          measureNote: '先补统一社会信用代码。',
        }),
      },
      attachTo: document.body,
    })
    const text = await openAndReadText(wrapper)
    expect(text).toContain('无统一社会信用代码')
    expect(text).toContain('转人工核实')
  })

  it('迁入来源缺项时显示「待补证」,不猜填', async () => {
    const wrapper = mountIn(ComparisonReconcile, {
      props: {
        explanation: null,
        disposition: disposition({
          status: 'confirmed_reason',
          reasonCode: 'moved_in',
          measureCode: 'record_moved_in',
          movedIn: { city: '绍兴市', titleCode: 'specialized_sme', year: 2022, batch: null },
        }),
      },
      attachTo: document.body,
    })
    const text = await openAndReadText(wrapper)
    expect(text).toContain('绍兴市')
    // `moved_in_title_code` 是 `title.code`(契约 §1.5 FK→title.code),**不是** rdjb ——
    // 要显示称号中文名,而不是原样吐出 `specialized_sme`。
    expect(text).toContain(TITLES.specialized_sme)
    expect(text).not.toContain('specialized_sme')
    expect(text).toContain('待补证')
  })

  it('说明与标签同义时只显示一次(写入侧的 measure_note 常写成标签本身)', async () => {
    const wrapper = mountIn(ComparisonReconcile, {
      props: {
        explanation: null,
        disposition: disposition({
          status: 'confirmed_reason',
          reasonCode: 'platform_stale',
          measureCode: 'mark_platform_snapshot',
          measureNote: '标明平台时点,不覆盖历史。',
          verificationStatus: 'confirmed',
        }),
      },
    })
    const text = await openAndReadText(wrapper)
    expect(text).toContain('标明平台时点,不覆盖历史')
    expect(text).not.toContain('标明平台时点,不覆盖历史 — 标明平台时点,不覆盖历史')
  })

  it('旧解释缓存存在时只作**对照**列出,不当主源', async () => {
    const cached: ReconcileEntry = {
      key: 'k',
      uscc: '91330211000000001X',
      name: '宁波平台滞后企业',
      nameNorm: '宁波平台滞后企业',
      titleCode: 'specialized_sme',
      direction: 'missing_in_miit',
      rdjb: '2',
      explanation: { code: 'on_platform', note: '平台有记录(离线缓存样本)' },
      evidence: {
        rdjb: '2',
        rdjbLabel: '专精特新中小企业',
        businessCount: 2,
        applyCount: 0,
        provinces: ['宁波市'],
        businessStatuses: [],
        applyStatuses: [],
        records: [],
      },
      fetchedAt: '2026-10-15T11:46:13.380Z',
    }
    const wrapper = mountIn(ComparisonReconcile, {
      props: {
        disposition: disposition({
          status: 'confirmed_reason',
          reasonCode: 'platform_stale',
          measureCode: 'mark_platform_snapshot',
          verificationStatus: 'confirmed',
        }),
        explanation: cached,
      },
      attachTo: document.body,
    })
    // 主徽章是库内状态,不是缓存的「平台有记录」。
    expect(wrapper.get('[data-testid="reconcile-badge"]').text()).toBe('已确认原因')
    const text = await openAndReadText(wrapper)
    expect(text).toContain('平台未更新')
    expect(text).toContain('旧解释缓存')
    expect(text).toContain('平台有记录(离线缓存样本)')
    expect(text).toContain('2026-10-15')
  })
})

// ---------------------------------------------------------------------------
// 「平台证据」列:曾用名 + 可展开的接口证据(时点 / 接口 / 原始关系)
// ---------------------------------------------------------------------------

function evidence(patch: Partial<PlatformEvidence> = {}): PlatformEvidence {
  return { aliases: [], disposition: disposition(), queries: [], relationCount: 0, ...patch }
}

describe('比对行「平台证据」列:库内查询与原始关系原文', () => {
  it('曾用名分「已确认 / 待核」两组;待核的不并入现名', async () => {
    const wrapper = mountIn(ComparisonPlatformEvidence, {
      props: {
        enterpriseId: 1,
        evidence: evidence({
          aliases: [
            { id: 1, name: '宁波上航测绘有限公司', nameNorm: '宁波上航测绘有限公司', sourceKind: 'platform_business', sourceRefId: 0, verificationStatus: 'confirmed', validFrom: null, note: null },
            { id: 2, name: '宁波疑似旧名有限公司', nameNorm: '宁波疑似旧名有限公司', sourceKind: 'platform_apply', sourceRefId: 0, verificationStatus: 'pending', validFrom: null, note: null },
          ],
        }),
      },
    })
    expect(wrapper.text()).toContain('待核别名 1')
    await wrapper.get('[data-testid="platform-evidence-details-toggle"]').trigger('click')
    expect(wrapper.text()).toContain('曾用名')
    expect(wrapper.text()).toContain('宁波上航测绘有限公司')
    expect(wrapper.text()).toContain('待核别名')
    expect(wrapper.text()).toContain('宁波疑似旧名有限公司')
  })

  it('查询证据带出接口、时点与关系条数,展开后是**原始关系**字段', async () => {
    const wrapper = mountIn(ComparisonPlatformEvidence, {
      props: {
        enterpriseId: 7,
        evidence: evidence({
          relationCount: 1,
          queries: [
            {
              id: 12,
              interface: 'business_list',
              queryKey: '91330211000000002Y',
              rdjb: '2',
              queriedAt: '2026-10-16T03:20:00.000Z',
              status: 'success',
              failureReason: null,
              relationCount: 1,
              relations: [
                {
                  id: 34,
                  queryId: 12,
                  sequenceNo: 1,
                  relationKey: 'SQ332025000000001',
                  usccRaw: '91330211000000002Y',
                  nameRaw: '宁波平台滞后企业',
                  aliasNameRaw: null,
                  province: '宁波市',
                  status: '待审核',
                  batch: '2025-1',
                  declareKind: 'apply',
                  appliedAt: '2025-03-01',
                  awardBatchLabel: null,
                  year: 2025,
                  matchBasis: 'uscc',
                  verificationStatus: 'confirmed',
                },
              ],
            },
          ],
        }),
      },
      attachTo: document.body,
    })
    expect(wrapper.get('[data-testid="platform-evidence-summary"]').text()).toContain('查询成功 ×1')
    expect(wrapper.get('[data-testid="platform-evidence-summary"]').text()).toContain('关系 1')
    // 详情默认收起以保持行高;点开后才出现接口、时点与原始关系入口。
    // 关系原文默认收起(表窄),点开后逐条可见。
    expect(wrapper.find('[data-testid="platform-relation"]').exists()).toBe(false)
    await wrapper.get('[data-testid="platform-evidence-details-toggle"]').trigger('click')
    expect(wrapper.get('[data-testid="platform-query-summary"]').text()).toContain('业务接口')
    expect(wrapper.get('[data-testid="platform-query-summary"]').text()).toContain('2026-10-16')
    await wrapper.get('[data-testid="platform-evidence-toggle"]').trigger('click')
    const relation = wrapper.get('[data-testid="platform-relation"]')
    expect(relation.text()).toContain('宁波平台滞后企业')
    expect(relation.text()).toContain('91330211000000002Y')
    expect(relation.text()).toContain('待审核')
    expect(relation.text()).toContain('按统一社会信用代码')
  })

  it('没有曾用名也没有查询时给「—」,不编造', () => {
    const wrapper = mountIn(ComparisonPlatformEvidence, { props: { enterpriseId: 9, evidence: evidence() } })
    expect(wrapper.text().trim()).toBe('—')
  })
})
