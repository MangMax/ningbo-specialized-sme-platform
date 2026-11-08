// @vitest-environment happy-dom
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { it, expect, vi } from 'vitest'
import Declaration from '../components/PlatformDeclarationDetailDialog.vue'
import Business from '../components/PlatformBusinessProcessDetailDialog.vue'
import Directory from '../components/PlatformRecognizedDirectoryDetailDialog.vue'

it.each([Declaration, Business, Directory])('keeps projection state and literal source values local to each displayed version ($__name)', async (component) => {
 const empty = { versionId: 2, ruleVersion: 'test-rule', titleRaw: null, nameRaw: null, usccRaw: null, declareKind: null, declarationYear: null, businessYear: null, status: null, appliedAt: null, validityDateRaw: null, maintenanceBatch: null, district: null, awardNote: null, batch: null, province: null, awardBatchLabel: null, firstObservedAt: null, lastObservedAt: null }
 const fetch=vi.fn(async () => ({record:{interface:'test'},conflicts:[],counts:{versions:3},versions:[{...empty,versionId:1,ruleVersion:null},empty,{...empty,versionId:3,declarationYear:0,businessYear:0,status:false,awardNote:false,maintenanceBatch:0,titleRaw:'unknown-code'}]}))
 vi.stubGlobal('$fetch',fetch)
 const view=mount(component,{attachTo:document.body,props:{open:true,recordId:1}})
 try {
 await flushPromises()
 const versions=new DOMWrapper(document.body).findAll('article')
 expect(versions).toHaveLength(3)
 expect(versions[0]!.text()).toContain('业务字段未同步')
 expect(versions[0]!.text()).not.toContain('原文未提供')
 expect(versions[1]!.text()).toContain('原文未提供')
 expect(versions[1]!.text()).not.toContain('业务字段未同步')
 expect(versions[2]!.text()).toContain('unknown-code')
 expect(versions[2]!.text()).toContain('0')
 expect(versions[2]!.text()).toContain('false')
 expect(fetch).toHaveBeenCalledTimes(1)
 expect(fetch.mock.calls[0]).toHaveLength(2)
 } finally {view.unmount();vi.unstubAllGlobals()}
})
