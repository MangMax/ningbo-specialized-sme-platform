// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import SourceRowDetail from '../../../layers/sme-roster/app/components/record-correspondence/SourceRowDetail.vue'
import type { ExportRowSource } from '../../../layers/sme-roster/lib/roster/correspondence-view'

it.each(['终审通过', null])('labels only the platform export review status and preserves the original field: %s', regStatus => {
  const exportRow: ExportRowSource = { id: 1, batchId: 2, sourceRowNo: 3, usccRaw: null, nameRaw: '合成企业', district: null, province: null, city: null, regStatus, rawFields: { 审核状态: regStatus }, batch: { id: 2, titleCode: 'specialized_sme', year: 2025, collectedOn: '2026-10-01', originalFilename: 'synthetic.xlsx', sha256: '3'.repeat(64), rowCount: 1, importStatus: 'imported', replacedBatchId: null }, correspondences: [] }
  const original = JSON.stringify(exportRow)
  const wrapper = mount(SourceRowDetail, { props: { exportRow } })
  try {
    const label = wrapper.findAll('dt').find(node => node.text() === '平台审核状态原值')
    expect(label).toBeDefined()
    expect(label!.element.nextElementSibling?.textContent).toBe(regStatus ?? '未提供')
    expect(wrapper.text()).not.toContain('登记状态原值')
    expect(JSON.stringify(exportRow)).toBe(original)
  } finally { wrapper.unmount() }
})
