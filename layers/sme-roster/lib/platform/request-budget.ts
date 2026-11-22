/** Process-wide platform budget shared by all platform requests.
 * A slot covers the whole request (body read and retry backoff included).
 */
let active = 0
const waiting: Array<() => void> = []
export const PLATFORM_MAX_CONCURRENT_REQUESTS = 2
export async function withPlatformRequestBudget<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(enter)
      if (index >= 0) waiting.splice(index, 1)
      reject(signal?.reason)
    }
    const enter = () => { signal?.removeEventListener('abort', abort); active++; resolve() }
    if (signal?.aborted) { reject(signal.reason); return }
    if (active < PLATFORM_MAX_CONCURRENT_REQUESTS) enter()
    else { waiting.push(enter); signal?.addEventListener('abort', abort, { once: true }) }
  })
  try { return await run() }
  finally { active--; waiting.shift()?.() }
}
