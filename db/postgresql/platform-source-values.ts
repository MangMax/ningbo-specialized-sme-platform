export type PlatformSourceCell = string | number | boolean | null | { base64: string; storage?: 'text' }

export const platformSourceFields = [
  'titleRaw', 'status', 'declareKind', 'appliedAt', 'year', 'batch', 'awardBatchLabel', 'province',
] as const

export type PlatformSourceValues = Partial<Record<typeof platformSourceFields[number], PlatformSourceCell>>

export function encodePlatformSourceCell(value: string | number | boolean | Buffer | null): PlatformSourceCell {
  if (Buffer.isBuffer(value)) return { base64: value.toString('base64') }
  if (typeof value === 'string' && value.includes('\0')) return { base64: Buffer.from(value).toString('base64'), storage: 'text' }
  return value
}

export function platformSourceCellValue(cell: PlatformSourceCell | undefined) {
  if (cell === undefined || cell === null) return null
  if (typeof cell !== 'object') return cell
  const bytes = Buffer.from(cell.base64, 'base64')
  return cell.storage === 'text' ? bytes.toString('utf8') : bytes
}
