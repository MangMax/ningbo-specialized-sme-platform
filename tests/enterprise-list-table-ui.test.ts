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
    },
    {
      enterpriseId: 1207,
      name: '宁波九纵智能科技有限公司',
    },
  ])('不把企业 $enterpriseId 的现名显示成曾用名', ({ enterpriseId, name }) => {
    const wrapper = mount(EnterpriseListTable, {
      props: {
        rows: [{
          enterpriseId,
          name,
          uscc: null,
          district: null,
          aliasNames: [name],
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
    expect(nameCell.text()).not.toContain(`原 ${name}`)
  })

  it('保留真实历史曾用名', () => {
    const wrapper = mount(EnterpriseListTable, {
      props: {
        rows: [{
          enterpriseId: 7289,
          name: '宁波上航测绘股份有限公司',
          uscc: null,
          district: null,
          aliasNames: ['宁波上航测绘股份有限公司', '宁波上航测绘有限公司'],
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
    expect(nameCell.text()).toContain('原 宁波上航测绘有限公司')
    expect(nameCell.text()).not.toContain('原 宁波上航测绘股份有限公司')
  })

  it('不把只差全半角括号的规范化同名显示为曾用名', () => {
    const currentName = '中化(浙江)膜产业发展有限公司'
    const alias = '中化（浙江）膜产业发展有限公司'
    const wrapper = mount(EnterpriseListTable, {
      props: {
        rows: [{
          enterpriseId: 3832,
          name: currentName,
          uscc: null,
          district: null,
          aliasNames: [alias],
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
    expect(nameCell.text()).toContain(currentName)
    expect(nameCell.text()).not.toContain(`原 ${alias}`)
  })
})

describe('企业列表的抽屉触发器', () => {
  it('单击整行时用企业名称按钮作为焦点返回目标', async () => {
    const wrapper = mount(EnterpriseListTable, {
      props: {
        rows: [{
          enterpriseId: 7289,
          name: '宁波上航测绘股份有限公司',
          uscc: null,
          district: null,
          aliasNames: [],
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
    const button = wrapper.get('tbody tr button').element

    await wrapper.get('tbody tr').trigger('click')

    expect(wrapper.emitted('select')?.[0]).toEqual([7289, button])
  })
})
