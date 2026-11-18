import { getAppModules } from '../../../lib/app-modules'

const modules = getAppModules()
const kinds = new Map(modules.flatMap(({ id, jobKinds }) =>
  (jobKinds ?? []).map(entry => [entry.kind, { ...entry, module: id }] as const),
))

export const taskTabs = [
  { id: 'all', label: '全部任务' },
  ...modules.map(({ id, name }) => ({ id, label: name })),
]

export function getTaskKind(kind: string) {
  return kinds.get(kind)
}

export function getTaskGroups(tab: string) {
  const jobKinds = modules.find(module => module.id === tab)?.jobKinds ?? []
  return [...new Map(jobKinds.map(({ group }) => [group.id, group])).values()]
}

export function resolveTaskFilters(tab: unknown, group: unknown) {
  const selectedTab = taskTabs.find(item => item.id === tab) ?? taskTabs[0]!
  const selectedGroup = getTaskGroups(selectedTab.id).find(item => item.id === group)
  return { tab: selectedTab, group: selectedGroup }
}

export function getTaskFilterKinds(module: string, group?: string) {
  const jobKinds = modules.find(item => item.id === module)?.jobKinds ?? []
  return jobKinds.filter(entry => !group || entry.group.id === group).map(entry => entry.kind)
}
