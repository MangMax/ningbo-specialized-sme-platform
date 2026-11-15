let activeWriters = 0
const waiters = new Set<() => void>()

// One lease per dispatched import; release only after its result or process exit.
export function beginImportWrite(): () => void {
  activeWriters++
  return () => {
    if (--activeWriters === 0) {
      for (const resolve of waiters) resolve()
      waiters.clear()
    }
  }
}

export function whenImportWriterIdle(): Promise<void> {
  return activeWriters ? new Promise(resolve => waiters.add(resolve)) : Promise.resolve()
}
