import type { RosterEnterpriseFilter, RosterEnterpriseDifference, RosterState } from './enterprise-roster-projection'

export interface EnterpriseSelection {
  id: number
  name: string
  year: number | null
  rank: number
  state: RosterState
  difference: RosterEnterpriseDifference
}
export function compareEnterpriseSelection(sort: RosterEnterpriseFilter['sort'], a: EnterpriseSelection, b: EnterpriseSelection) {
  if (sort === 'title' && a.rank !== b.rank) return a.rank - b.rank
  if (sort !== 'name' && sort !== 'title' && a.year !== b.year) return a.year == null ? 1 : b.year == null ? -1 : b.year - a.year
  return a.name.localeCompare(b.name) || a.id - b.id
}
