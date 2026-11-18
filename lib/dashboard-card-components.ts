import { defineAsyncComponent, type Component } from 'vue'

// The workbench resolves components here so Nitro can read the manifests.
const components = new Map<string, Component>([
  ['roster-stats', defineAsyncComponent(() => import('../components/RosterDashboardStats.vue'))],
])

export function getDashboardCardComponent(id: string): Component {
  const component = components.get(id)
  if (!component) throw new Error(`未登记工作台卡片组件「${id}」`)
  return component
}
