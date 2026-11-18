import { expect, it } from 'vitest'
import { getAppModules } from '../../../lib/app-modules'
import { defineAppModule, validateAppModules } from '../../../lib/core/module-registry'

it('lists the platform and business modules in declaration order', () => {
  expect(getAppModules().map(({ id, name }) => ({ id, name }))).toEqual([
    { id: 'core', name: '平台底座' },
    { id: 'sme-roster', name: '优质中小企业' },
  ])
})

const core = defineAppModule({ id: 'core', name: '平台底座' })
const roster = defineAppModule({
  id: 'sme-roster',
  name: '优质中小企业',
  nav: [{ title: '企业列表', url: '/' }],
})

it.each([
  {
    reason: 'invalid module identifiers',
    modules: [core, defineAppModule({ id: 'Bad_ID', name: '示例' })],
    error: '模块「Bad_ID」的 id 无效',
  },
  {
    reason: 'duplicate module identifiers',
    modules: [core, roster, defineAppModule({ id: 'sme-roster', name: '示例' })],
    error: '模块「sme-roster」的 id 重复',
  },
  {
    reason: 'duplicate top-level and submenu addresses',
    modules: [roster, defineAppModule({
      id: 'example',
      name: '示例',
      nav: [{ title: '查询', items: [{ title: '首页', url: '/' }] }],
    })],
    error: '模块「example」的 nav 地址「/」重复，已由模块「sme-roster」登记',
  },
  {
    reason: 'duplicate addresses within the same module',
    modules: [defineAppModule({
      id: 'example',
      name: '示例',
      nav: [{ title: '查询', items: [{ title: 'A', url: '/query' }, { title: 'B', url: '/query' }] }],
    })],
    error: '模块「example」的 nav 地址「/query」重复，已由模块「example」登记',
  },
  {
    reason: 'missing dependencies',
    modules: [core, defineAppModule({ id: 'example', name: '示例', dependsOn: ['missing'] })],
    error: '模块「example」的 dependsOn 指向未登记模块「missing」',
  },
  {
    reason: 'dependency cycles',
    modules: [
      core,
      defineAppModule({ id: 'example', name: '示例', dependsOn: ['other'] }),
      defineAppModule({ id: 'other', name: '其他', dependsOn: ['example'] }),
    ],
    error: '模块「example」的 dependsOn 存在循环依赖：example → other → example',
  },
  {
    reason: 'cycles through the implicit dependency on core',
    modules: [defineAppModule({ id: 'core', name: '平台底座', dependsOn: ['sme-roster'] }), roster],
    error: '模块「core」的 dependsOn 存在循环依赖：core → sme-roster → core',
  },
])('rejects $reason when validating declarations at startup', ({ modules, error }) => {
  expect(() => validateAppModules(modules)).toThrow(error)
})
