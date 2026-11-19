import { onBeforeUnmount, onMounted } from 'vue'
const eventName = 'roster-correspondence-readback'
type ReadbackEvent = CustomEvent<{ reads: Promise<unknown>[] }>
/** Mounted read surfaces join the same explicit readback and retain their own errors. */
export function useRosterCorrespondenceReadback(read: () => Promise<unknown>) {
  const listener = (event: Event) => { (event as ReadbackEvent).detail.reads.push(Promise.resolve().then(read)) }
  onMounted(() => window.addEventListener(eventName, listener))
  onBeforeUnmount(() => window.removeEventListener(eventName, listener))
}
export async function rosterRefreshCorrespondenceViews() {
  const reads: Promise<unknown>[] = []
  window.dispatchEvent(new CustomEvent(eventName, { detail: { reads } }))
  const results = await Promise.allSettled(reads)
  if (results.some(result => result.status === 'rejected' || result.value === false)) throw new Error('readback_failed')
}
