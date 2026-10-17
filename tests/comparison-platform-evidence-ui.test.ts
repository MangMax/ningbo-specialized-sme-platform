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
    expect(document.querySelector('table[aria-label="关联记录"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="platform-query-summary"]')?.textContent).toContain('2026-10-16')
    expect(document.body.textContent).toContain('本次查询未完成')
    expect(document.body.textContent).not.toMatch(/business_list|rdjb|businessList/)
  })
})
