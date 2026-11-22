

export function failPlatformBusinessRequest(statusCode: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { statusCode, code })
}

export function platformBusinessPage(filter: { page: number; pageSize: number }) {
  return { page: filter.page, pageSize: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }
}

const RDJB_ORDER = ['1', '2', '3']

export function orderedScopes(values: Iterable<string>): string[] {
  const unique = [...new Set(values)].filter(Boolean)
  return unique.sort((a, b) => {
    const ai = RDJB_ORDER.indexOf(a), bi = RDJB_ORDER.indexOf(b)
    return (ai < 0 ? RDJB_ORDER.length : ai) - (bi < 0 ? RDJB_ORDER.length : bi) || a.localeCompare(b)
  })
}
