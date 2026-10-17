import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import type { PdfReadingPosition } from '~~/lib/pdf-reader'
import { parseEvidencePreviewQuery } from '~~/lib/roster/evidence-page'

/** Route writes are echoes, not new reader requests. Only external URLs drive the target. */
export function useSourcePdfRoute() {
  const route = useRoute()
  const router = useRouter()
  const origin = useRequestURL().origin
  const parsed = computed(() => parseEvidencePreviewQuery(route.query, origin))
  const first = (value: unknown) => { const v = Array.isArray(value) ? value[0] : value; return typeof v === 'string' ? v : undefined }
  const sourceRaw = computed(() => first(route.query.sourcePage) ?? first(route.query.page) ?? 'unknown')
  const sourcePage = computed(() => parseEvidencePreviewQuery({ page: sourceRaw.value }).page)
  function readTarget(): PdfReadingPosition | undefined {
    const page = parsed.value.page
    if (page === null) return undefined
    const x = Number(first(route.query.x)), y = Number(first(route.query.y))
    return { page, ...(Number.isFinite(x) && x >= 0 && Number.isFinite(y) && y >= 0 ? { point: { x, y } } : {}) }
  }
  const target = shallowRef(readTarget())
  const invalid = computed(() => {
    if (sourceRaw.value !== 'unknown' && sourcePage.value === null) return '来源页码参数无效，请核对来源页码。'
    if (first(route.query.page) !== undefined && parsed.value.page === null) return '浏览页码参数无效，请输入正整数实际页码。'
    return ''
  })
  const owned = new Set<string>()
  let generation = 0
  let queue = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPage: number | undefined
  watch(() => route.fullPath, path => {
    if (owned.delete(path)) return
    generation++
    clearTimeout(timer)
    lastPage = undefined
    target.value = readTarget() ?? (first(route.query.page) === undefined ? { page: 1 } : undefined)
  })
  function enqueue(request: Parameters<typeof router.resolve>[0] | (() => Parameters<typeof router.resolve>[0]), explicit: boolean) {
    const owner = generation
    queue = queue.then(async () => {
      if (owner !== generation || route.path !== '/preview') return
      const destination = typeof request === 'function' ? request() : request
      const path = router.resolve(destination).fullPath
      if (path === route.fullPath) return
      owned.add(path)
      try { await router[explicit ? 'push' : 'replace'](destination) }
      finally { owned.delete(path) }
    })
  }
  function write(position: PdfReadingPosition, explicit: boolean) {
    if (route.path !== '/preview') return
    const query: Record<string, string | null | undefined | (string | null)[]> = { ...route.query, sourcePage: sourceRaw.value, page: String(position.page), x: undefined as string | undefined, y: undefined as string | undefined }
    if (position.point) { query.x = String(Math.round(position.point.x * 100) / 100); query.y = String(Math.round(position.point.y * 100) / 100) }
    // Retain only the already-validated return path. File access still goes through fileUrl/API.
    query.back = parsed.value.back || undefined
    const destination = { path: '/preview', query, hash: route.hash }
    enqueue(destination, explicit)
  }

  function visible(position: PdfReadingPosition, explicit: boolean) {
    clearTimeout(timer)
    const changedPage = lastPage !== position.page
    lastPage = position.page
    if (explicit || changedPage) write(position, explicit)
    else timer = setTimeout(() => write(position, false), 300)
  }
  function changeView(view: string) { clearTimeout(timer); enqueue(() => ({ path: '/preview', query: { ...route.query, view: view === 'pages' ? 'pages' : undefined }, hash: route.hash }), false) }
  onScopeDispose(() => { generation++; clearTimeout(timer) })
  return { parsed, sourcePage, target, invalid, visible, changeView }
}
