// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import EnterpriseListTable from '../components/EnterpriseListTable.vue'

const mounted: ReturnType<typeof mount>[] = []

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('企业列表的曾用名', () => {
  it.each([
    {
      enterpriseId: 987,
      name: '宁波芯速联光电科技有限公司',
      oldName: '宁波芯速联旧称有限公司',
    },
    {
      enterpriseId: 1207,
      name: '宁波九纵智能科技有限公司',
      oldName: '宁波九纵旧称有限公司',
    },
  ])('不把企业 $enterpriseId 的现名显示成曾用名', ({ enterpriseId, name, oldName }) => {
    const wrapper = mount(EnterpriseListTable, {
      props: {
        rows: [{
          enterpriseId,
          name,
          uscc: null,
          district: null,
          aliasNames: [name, oldName],
          titles: [],
          firstRecognition: [],
          difference: { count: 0, status: null, reasonCode: null, anyCurrent: false },
        }],
        loading: false,
        hasError: false,
        selectedId: null,
        filtered: false,
      },
    })
    mounted.push(wrapper)

    const nameCell = wrapper.get('tbody tr td:nth-child(2)')
    expect(nameCell.text()).toContain(name)
    expect(nameCell.text()).toContain(`原 ${oldName}`)
    expect(nameCell.text()).not.toContain(`原 ${name}`)
  })
})
