import { normalizeName, normalizeUscc } from './domain'

interface ComparisonFilterRow {
  titleCode: string
  direction: string
  district: string | null
  name: string
  uscc: string | null
  curated: boolean
  platform: { aliases: { name: string; verificationStatus: string }[] }
}

export interface ComparisonRowFilter {
  title?: readonly string[]
  direction?: string
  district?: string
  q?: string
  showCurated?: boolean
}

/** Keep the comparison page and its export on the same visible-row filters. */
export function filterComparisonRows<T extends ComparisonFilterRow>(
  rows: readonly T[],
  filter: ComparisonRowFilter,
): T[] {
  const district = filter.district?.trim() ?? ''
  const search = filter.q?.trim() ?? ''
  const nameNeedle = normalizeName(search)
  const usccNeedle = normalizeUscc(search)

  return rows.filter((row) => {
    if (filter.title?.length && !filter.title.includes(row.titleCode)) return false
    if (filter.direction && row.direction !== filter.direction) return false
    if (district && row.district !== district) return false
    if (!filter.showCurated && row.curated) return false
    if (!search) return true

    const confirmedAliasHit = row.platform.aliases.some(
      (alias) => alias.verificationStatus === 'confirmed' && normalizeName(alias.name).includes(nameNeedle),
    )
    return (
      (nameNeedle !== '' && normalizeName(row.name).includes(nameNeedle)) ||
      (usccNeedle !== '' && normalizeUscc(row.uscc).includes(usccNeedle)) ||
      confirmedAliasHit
    )
  })
}
