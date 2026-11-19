import { getAppModules } from '../../../lib/app-modules'

export function getTaskTabs() {
  return [
    { id: 'all', label: '全部任务' },
    ...getAppModules().map(({ id, name }) => ({ id, label: name })),
  ]
}

export function getTaskKind(kind: string) {
  for (const { id, jobKinds } of getAppModules()) {
    const entry = jobKinds?.find(candidate => candidate.kind === kind)
    if (entry) return { ...entry, module: id }
  }
}

export function getTaskGroups(tab: string) {
  const jobKinds = getAppModules().find(module => module.id === tab)?.jobKinds ?? []
  return [...new Map(jobKinds.map(({ group }) => [group.id, group])).values()]
}

export function resolveTaskFilters(tab: unknown, group: unknown) {
  const taskTabs = getTaskTabs()
  const selectedTab = taskTabs.find(item => item.id === tab) ?? taskTabs[0]!
  const selectedGroup = getTaskGroups(selectedTab.id).find(item => item.id === group)
  return { tab: selectedTab, group: selectedGroup }
}

export function getTaskFilterKinds(module: string, group?: string) {
  const jobKinds = getAppModules().find(item => item.id === module)?.jobKinds ?? []
  return jobKinds.filter(entry => !group || entry.group.id === group).map(entry => entry.kind)
}
