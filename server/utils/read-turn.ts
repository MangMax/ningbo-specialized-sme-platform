/** Best-effort FIFO for synchronous whole reads. The fixed reader must not
 * capture requests. Callers supply only validated primitive read options.
 * No transaction opens until dispatch. Saturation executes the original read
 * inline, preserving its result/error and deliberately forfeiting fairness.
 */
type Primitive = string | number | boolean | null | undefined
type ReadOptions = Exclude<Primitive, undefined> | { [key: string]: Primitive | Primitive[] }
export function createReadTurns<I extends ReadOptions, O>(read: (input: I) => O) {
  type Pending = { encoded: string; bytes: number; resolve(value: O | undefined): void; reject(error: unknown): void }
  const queue: Pending[] = []
  let retainedBytes = 0
  let immediate: ReturnType<typeof setImmediate> | undefined
  function arm() {
    if (immediate || !queue.length) return
    immediate = setImmediate(() => {
      immediate = undefined
      const job = queue.shift()!
      retainedBytes -= job.bytes
      try { job.resolve(read(JSON.parse(job.encoded) as I)) } catch (error) { job.reject(error) }
      // Scheduling from inside this callback enforces a new check iteration;
      // never drain the FIFO here or schedule independent per-request immediates.
      arm()
    })
  }
  return {
    submit(input: I) {
      const encoded = JSON.stringify(input)
      const bytes = Buffer.byteLength(encoded, 'utf8')
      if (queue.length >= 16 || retainedBytes + bytes > 64 * 1024) {
        return { result: Promise.resolve(read(input)), cancel() {} }
      }
      let job: Pending
      const result = new Promise<O | undefined>((resolve, reject) => {
        job = { encoded, bytes, resolve, reject }
        queue.push(job)
        retainedBytes += bytes
        arm()
      })
      return { result, cancel() {
        const index = queue.indexOf(job)
        if (index < 0) return
        queue.splice(index, 1)
        retainedBytes -= job.bytes
        job.encoded = ''
        // The transport is already disconnected; no new domain error or result.
        job.resolve(undefined)
        if (!queue.length && immediate) { clearImmediate(immediate); immediate = undefined }
      } }
    },
  }
}
