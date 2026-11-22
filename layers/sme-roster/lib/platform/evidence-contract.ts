/** Shared evidence wire contract; neither reader imports the other for constants. */
export const MAX_FULL_QUERY_BYTES = 4 * 1024 * 1024
export const MAX_FULL_PAGE_BYTES = 8 * 1024 * 1024
export function assertPlatformFullReadBudget(budget: readonly number[]) {
  if (budget.some(n => n > MAX_FULL_QUERY_BYTES) || budget.reduce((sum, bytes) => sum + bytes, 0) > MAX_FULL_PAGE_BYTES) {
    const message = 'Platform evidence exceeds full-read budget; use view=summary or reduce pageSize'
    throw Object.assign(new Error(message), { statusCode: 413, statusMessage: message })
  }
}
