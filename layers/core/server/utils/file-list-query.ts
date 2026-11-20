export function fileListQuery(query: Record<string, unknown>) {
  const positiveInteger = (value: unknown, fallback: number) => {
    const n = Number(value)
    return Number.isSafeInteger(n) && n > 0 ? n : fallback
  }
  return {
    q: typeof query.q === 'string' && query.q ? query.q : undefined,
    page: positiveInteger(query.page, 1),
    pageSize: positiveInteger(query.pageSize, 50),
  }
}
