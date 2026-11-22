// @vitest-environment jsdom
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { it, expect, vi } from 'vitest'
import Declaration from '../../../layers/sme-roster/app/components/PlatformDeclarationDetailDialog.vue'
import Business from '../../../layers/sme-roster/app/components/PlatformBusinessProcessDetailDialog.vue'
import Directory from '../../../layers/sme-roster/app/components/PlatformRecognizedDirectoryDetailDialog.vue'

it.each([Declaration, Business, Directory])('shows only the current projection with literal source values ($__name)', async (component) => {
 const empty = { versionId: 2, ruleVersion: 'test-rule', titleRaw: null, nameRaw: null, usccRaw: null, declareKind: null, declarationYear: null, businessYear: null, status: null, appliedAt: null, validityDateRaw: null, maintenanceBatch: null, district: null, awardNote: null, batch: null, province: null, awardBatchLabel: null, firstObservedAt: null, lastObservedAt: null }
 const fetch = vi.fn(async () => ({
   conflicts: [],
   current: { ...empty, declarationYear: 0, businessYear: 0, status: false, awardNote: false, maintenanceBatch: 0, titleRaw: 'unknown-code' },
   versions: [{ ...empty, titleRaw: 'historical-code' }],
 }))
 vi.stubGlobal('$fetch',fetch)
 const view=mount(component,{attachTo:document.body,props:{open:true,recordId:1}})
 try {
 await flushPromises()
 const rows = new DOMWrapper(document.body).findAll('article')
 expect(rows).toHaveLength(1)
 expect(rows[0]!.text()).toContain('unknown-code')
 expect(rows[0]!.text()).toContain('0')
 expect(rows[0]!.text()).toContain('false')
 expect(rows[0]!.text()).not.toContain('historical-code')
 expect(fetch).toHaveBeenCalledTimes(1)
 expect(fetch.mock.calls[0]).toHaveLength(2)
 } finally {view.unmount();vi.unstubAllGlobals()}
})
