import { normalizeName } from '../../lib/domain'
import { TITLE_ORDER } from '../../lib/labels'
import type { UsccChecklistFilter } from '../../lib/roster/uscc-research'

const rank = (title: string) => { const i = TITLE_ORDER.indexOf(title); return i < 0 ? TITLE_ORDER.length : i }

type TargetEnterprise = { id: number; name: string; nameNorm: string; district: string | null; city: string | null }

type TargetRecord = { id: number; enterpriseId: number; titleCode: string; source: string; district: string | null }

type TargetAlias = { enterpriseId: number; name: string }

export function platformOnlyUsccTargets(records: TargetRecord[]) {
  const official = new Set(records.filter(row => row.source === 'jxj').map(row => row.enterpriseId))
  return new Set(records.map(row => row.enterpriseId)).difference(official)
}

export function selectUsccTargetRows(
  missing: TargetEnterprise[],
  records: TargetRecord[],
  aliases: TargetAlias[],
  removed: ReadonlySet<number>,
  filter: Omit<UsccChecklistFilter, 'page' | 'pageSize'>,
) {
  const byEnterprise = new Map<number, typeof records>()
  for (const record of records) {
    const bucket = byEnterprise.get(record.enterpriseId) ?? []
    bucket.push(record); byEnterprise.set(record.enterpriseId, bucket)
  }
  const names = new Map<number, Set<string>>()
  for (const alias of aliases) {
    const bucket = names.get(alias.enterpriseId) ?? new Set<string>()
    bucket.add(alias.name); names.set(alias.enterpriseId, bucket)
  }
  const needle = filter.q?.trim() ? normalizeName(filter.q) : null
  return missing.filter(row => !removed.has(row.id)).map(row => {
    const records = byEnterprise.get(row.id) ?? []
    return {
      enterpriseId: row.id, name: row.name, city: row.city,
      district: row.district || records.find(record => record.district)?.district || null,
      titles: [...new Set(records.map(record => record.titleCode))].sort((a, b) => rank(a) - rank(b)),
      aliasNames: [...(names.get(row.id) ?? [])].sort(),
    }
  }).filter(row => (!filter.title?.length || row.titles.some(title => filter.title!.includes(title))) &&
    (!filter.district || row.district === filter.district) &&
    (!needle || normalizeName(row.name).includes(needle) || row.aliasNames.some(alias => normalizeName(alias).includes(needle))))
}
