// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import ComparisonPlatformEvidence from '../components/ComparisonPlatformEvidence.vue'
import type {
  ComparisonDisposition,
  ComparisonPlatformEvidence as PlatformEvidence,
} from '../lib/comparison-platform'

// Exercise real Motion's JS fallback; Happy DOM's WAAPI cancellation rejects on teardown.
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })

const mounted: ReturnType<typeof mount>[] = []

function disposition(): ComparisonDisposition {
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
    evidenceQueryId: 1,
    evidenceRelationId: null,
  }
}

function mountEvidence(evidence: PlatformEvidence) {
  const wrapper = mount(ComparisonPlatformEvidence, {
    attachTo: document.body,
    global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } },
    props: {
      enterpriseId: 42,
      currentName: '宁波接口异常企业有限公司',
      evidence,
    },
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('比对行平台证据的可见状态与展开交互', () => {
  it('查询失败先显示中文摘要,点开后显示接口、时点与失败原因', async () => {
    const evidence: PlatformEvidence = {
      aliases: [],
      disposition: disposition(),
      relationCount: 0,
      queries: [
        {
          id: 1,
          interface: 'business_list',
          queryKey: '91330211000000012X',
          rdjb: '2',
          queriedAt: '2026-10-16T03:20:00.000Z',
          status: 'failed',
          failureReason: '平台接口暂不可用',
          relationCount: 0,
          relations: [],
        },
      ],
    }
    const wrapper = mountEvidence(evidence)
    const summary = wrapper.get('[data-testid="platform-evidence-summary"]')
    const toggle = wrapper.get('[data-testid="platform-evidence-details-toggle"]')

    expect(summary.text()).toContain('查询失败 ×1')
    expect(toggle.text()).toBe('查看平台记录')
    expect(toggle.attributes('aria-expanded')).toBe('false')

    await toggle.trigger('click')

    expect(toggle.text()).toBe('查看平台记录')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(document.querySelector('table[aria-label="关联记录"]')).toBeNull()
    expect(document.querySelector('[data-record-kind="business_list"]')?.textContent).toContain('平台服务暂不可用')
    expect(document.querySelector('[data-testid="platform-query-summary"]')?.textContent).toContain('2026-10-16')
    expect(document.body.textContent).toContain('平台服务暂不可用')
    expect(document.body.textContent).not.toMatch(/business_list|rdjb|businessList/)
  })
})

it('已采集第三来源无需差异原因即可打开，摘要按实际来源行计数', async () => {
 const query = { id:60,interface:'recognized_list',queryKey:'913300000000000004',rdjb:'1,2,3',queriedAt:'2025-02-03T01:02:03Z',status:'partial',failureReason:null,relationCount:2,
 relations:[1,2].map(id=>({id,queryId:60,sequenceNo:id,relationKey:'same',nameRaw:'合成三来源企业',usccRaw:'913300000000000004',sourceRdjb:'1',sourcePage:id,province:null,status:null,batch:null,declareKind:null,appliedAt:null,awardBatchLabel:null,year:null,matchBasis:'uscc',verificationStatus:'pending',aliasNameRaw:null,rawFields:{whpcyear:'2024'}})) }
 const wrapper=mountEvidence({aliases:[],disposition:{...disposition(),explanationId:null,evidenceQueryId:null},relationCount:1,queries:[query]})
 expect(wrapper.get('[data-testid="platform-evidence-summary"]').text()).toContain('平台记录 2 条')
 await wrapper.get('[data-testid="platform-evidence-details-toggle"]').trigger('click')
 expect(document.querySelectorAll('[data-record-kind="recognized_list"] [data-testid="platform-relation"]')).toHaveLength(2)
 expect(document.querySelector('[data-record-kind="recognized_list"]')?.textContent).toContain('部分结果')
})
