

export function canonicalImportJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalImportJson(item ?? null)).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalImportJson(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
