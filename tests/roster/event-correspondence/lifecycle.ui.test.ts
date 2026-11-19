// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import Decision from '../../../layers/sme-roster/app/components/record-correspondence/EventCorrespondenceDecision.vue'
let wrapper: ReturnType<typeof mount> | undefined
const edge = { type: 'event_process', eventId: 7, relationId: 10, role: 'context_only' }
const point = { ...edge, id: 9, status: 'confirmed', revision: 2 }
const button = (text: string) => [...document.querySelectorAll('button')].find(n => n.textContent?.trim() === text)
const click = async (text: string) => { expect(button(text), text).toBeDefined(); button(text)!.click(); await flushPromises() }
const enter = async (value: string) => { const n = document.querySelector('textarea')!; n.value = value; n.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises() }
afterEach(() => { wrapper?.unmount(); wrapper = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })
const states = ['not_started', 'initial_read_inflight', 'initial_read_failed', 'editable_draft', 'unknown_commit', 'receipt_readback_pending'] as const
const axes = [ ['same_relation_new_event', { ...edge, eventId: 8 }], ['same_event_new_relation', { ...edge, relationId: 11 }] ] as const
for (const [axis, other] of axes) for (const state of states) {
  it(`${axis}: ${state} A-B-A preserves recoverability and request binding`, async () => {
    let reads = 0, auditUnavailable = true, finish!: (v: unknown) => void
    const initial = new Promise(resolve => { finish = resolve })
    const preflights: any[] = [], writes: any[] = []
    const fetch = vi.fn(async (url: string, options?: any) => {
      if (url.endsWith('/audit')) {
        if (auditUnavailable) throw new Error('audit unavailable')
        expect(options.query).toEqual({ page: 1, pageSize: 50 })
        return { page: 1, pageSize: 50, total: 1, rows: [{ idempotencyKey: preflights[0].idempotencyKey }] }
      }
      if (url.endsWith('/9')) {
        reads++
        if (reads === 1 && state === 'initial_read_inflight') return initial
        if (reads === 1 && state === 'initial_read_failed') throw new Error('initial point unavailable')
        return point
      }
      if (url.endsWith('browser-preflight')) { preflights.push(JSON.parse(JSON.stringify(options.body))); if (options.body.basis === 'B basis' || options.body.basis === 'A recovered basis') throw new Error('preflight unavailable'); return { planHash: 'a'.repeat(64), impact: { created: 0, unlinked: 1, audit: 1 } } }
      if (url.endsWith('browser-commit')) {
        writes.push(JSON.parse(JSON.stringify(options.body)))
        if (state === 'unknown_commit') throw { statusCode: 503 }
        return { correspondenceIds: [9] }
      }
      throw new Error(url)
    })
    vi.stubGlobal('useState', () => ref(true)); vi.stubGlobal('$fetch', fetch)
    wrapper = mount(Decision, { props: { edge, existing: point }, attachTo: document.body, global: { stubs: { RosterSourceReader: true } } }); await flushPromises()
    if (state !== 'not_started') {
      await click('取消对应')
      if (['editable_draft', 'unknown_commit', 'receipt_readback_pending'].includes(state)) {
        await enter('A basis')
        if (state !== 'editable_draft') {
          await click('提交决定')
          expect(preflights[0].operations).toEqual([{ action: 'decide', correspondenceId: 9, expectedRevision: 2, status: 'unlinked' }])
        }
      }
    }
    await wrapper.setProps({ edge: other, existing: null }); await flushPromises()
    await click('确认对应'); await enter('B basis'); await click('提交决定')
    const b = preflights.at(-1)
    expect(b.basis).toBe('B basis'); expect(b.operations).toEqual([{ action: 'create', edge: other, status: 'confirmed' }])
    if (preflights.length > 1) expect(b.idempotencyKey).not.toBe(preflights[0].idempotencyKey)
    if (state === 'initial_read_inflight') { finish(point); await flushPromises() }
    expect(document.querySelector('textarea')!.value).toBe('B basis')
    await wrapper.setProps({ edge, existing: point }); await flushPromises(); await click('取消对应')
    if (state === 'unknown_commit') {
      expect(document.querySelector('textarea')!.disabled).toBe(true)
      await click('重试提交'); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]); expect(reads).toBe(1)
    } else if (state === 'receipt_readback_pending') {
      expect(document.querySelector('textarea')!.disabled).toBe(true)
      auditUnavailable = false; await click('重试读回')
      expect(writes).toHaveLength(1); expect(document.body.textContent).toContain('已提交并读回对应与审计')
    } else {
      // Failed reads may recover on reopening or explicit refresh; interrupted reads must resume.
      if (state === 'initial_read_failed' && button('刷新后重新核对')) await click('刷新后重新核对')
      await enter('A recovered basis')
      console.info('lifecycle-observed', JSON.stringify({ axis, state, reads, preflightDisabled: button('提交决定')?.disabled, refresh: !!button('刷新后重新核对') }))
      expect(document.querySelector('textarea')!.disabled).toBe(false)
      if (state === 'initial_read_inflight' || state === 'initial_read_failed') expect(reads).toBe(2)
      expect(button('提交决定')!.disabled).toBe(false)
      await click('提交决定')
      const a = preflights.at(-1)
      expect(a.basis).toBe('A recovered basis')
      expect(a.operations).toEqual([{ action: 'decide', correspondenceId: 9, expectedRevision: 2, status: 'unlinked' }])
      const completedReads = reads
      for (let round = 0; round < 2; round++) {
        await wrapper.setProps({ edge: other, existing: null }); await flushPromises(); await click('确认对应')
        expect(document.querySelector('textarea')!.value).toBe('B basis')
        await wrapper.setProps({ edge, existing: point }); await flushPromises(); await click('取消对应')
        expect(document.querySelector('textarea')!.value).toBe('A recovered basis')
        expect(button('提交决定') ?? button('重试提交')).toBeDefined()
      }
      expect(reads).toBe(completedReads)

    }
  })
}

for (const [axis, other] of axes) for (const interrupted of ['point', 'choices'] as const) {
  it(`${axis}: interrupted correction ${interrupted} reloads only unfinished stages and stops refetching once ready`, async () => {
    let finish!: (v: unknown) => void
    const late = new Promise(resolve => { finish = resolve })
    let pointReads = 0, discoveries = 0
    const candidate = { edge: { ...edge, relationId: 12 }, existingStatus: null, existingCorrespondenceId: null, evidence: { title: { row: 'specialized_sme' }, process: { declareKind: 'apply', appliedAt: '2022-01-01' }, source: { queryId: 1, interface: 'apply_list', status: 'success', sequenceNo: 1 } } }
    const page = { page: 1, pageSize: 50, total: 1, rows: [candidate] }
    const preflights: any[] = []
    const fetch = vi.fn((url: string, options?: any) => {
      if (url.endsWith('/9')) return ++pointReads === 1 && interrupted === 'point' ? late : Promise.resolve(point)
      if (url.endsWith('/discover')) return ++discoveries === 1 && interrupted === 'choices' ? late : Promise.resolve(page)
      if (url.endsWith('browser-preflight')) { preflights.push(JSON.parse(JSON.stringify(options.body))); return Promise.resolve({ planHash: 'a'.repeat(64), impact: { created: 1, unlinked: 1, audit: 3 } }) }
      throw new Error(url)
    })
    vi.stubGlobal('useState', () => ref(true)); vi.stubGlobal('$fetch', fetch)
    wrapper = mount(Decision, { props: { edge, existing: point }, attachTo: document.body, global: { stubs: { RosterSourceReader: true } } }); await flushPromises()
    await click('改选记录')
    await wrapper.setProps({ edge: other, existing: null }); await flushPromises(); await click('确认对应'); await enter('B correction interruption draft')
    finish(interrupted === 'point' ? point : page); await flushPromises()
    await wrapper.setProps({ edge, existing: point }); await flushPromises(); await click('改选记录')
    expect(pointReads).toBe(interrupted === 'point' ? 2 : 1)
    expect(discoveries).toBe(interrupted === 'point' ? 1 : 2)
    const trigger = document.querySelector('#replacement-record') as HTMLButtonElement
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })); await flushPromises()
    ;(document.querySelector('[role="option"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flushPromises()
    await enter('A correction checked'); await click('提交决定')
    expect(preflights[0].operations).toEqual([{ action: 'correct', correspondenceId: 9, expectedRevision: 2, edge: candidate.edge }])
    const first = preflights[0]
    for (let i = 0; i < 2; i++) {
      await wrapper.setProps({ edge: other, existing: null }); await flushPromises(); await click('确认对应')
      expect(document.querySelector('textarea')!.value).toBe('B correction interruption draft')
      await wrapper.setProps({ edge, existing: point }); await flushPromises(); await click('改选记录')
      expect(document.querySelector('textarea')!.value).toBe('A correction checked')
      expect(button('提交决定') ?? button('重试提交')).toBeDefined()
    }
    expect(pointReads).toBe(interrupted === 'point' ? 2 : 1)
    expect(discoveries).toBe(interrupted === 'point' ? 1 : 2)
    expect(preflights).toEqual([first])
  })
}
