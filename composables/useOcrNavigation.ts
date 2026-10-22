import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRouter,
} from 'vue-router'
import {
  filterWorkbenchRows,
  type PageFilters,
  type WorkbenchRow,
} from '~~/lib/ocr-workbench'
import type { StoredFileRow } from '~~/server/utils/stored-files'

/** Narrow-screen content view. Desktop always shows the image/text pair. */
export type OcrView = 'text' | 'image' | 'compare'
const OCR_VIEWS: readonly OcrView[] = ['text', 'image', 'compare']

/** Public workbench navigation state. Drafts and API results never enter the URL. */
export function useOcrNavigation(options: {
  files: Ref<StoredFileRow[]>
  rows: Ref<WorkbenchRow[]>
  ready: Ref<boolean>
  busy: Ref<boolean>
}) {
  const route = useRoute()
  const router = useRouter()
  const selectedPath = ref('')
  const currentPage = ref<number | null>(null)
  const keyword = ref('')
  const source = ref('')
  const year = ref('')
  const filters = ref<PageFilters>({ states: [], range: '', text: '' })
  const view = ref<OcrView>('text')
  const dirty = ref(false)
  const notice = ref('')
  const filteredRows = computed(() =>
    filterWorkbenchRows(options.rows.value, filters.value),
  )
  const currentRow = computed(
    () =>
      (dirty.value || options.busy.value
        ? options.rows.value
        : filteredRows.value
      ).find((row) => row.page === currentPage.value) ?? null,
  )
  const fileMatches = computed(() =>
    options.files.value.filter(
      (file) =>
        [file.displayName, file.filename].some((name) =>
          name
            ?.toLocaleLowerCase()
            .includes(keyword.value.trim().toLocaleLowerCase()),
        ) &&
        (!source.value ||
          (source.value === 'unknown'
            ? !file.source
            : file.source === source.value)) &&
        (!year.value ||
          (year.value === 'unknown'
            ? file.year == null
            : String(file.year) === year.value)),
    ),
  )
  const scalar = (value: unknown) => (typeof value === 'string' ? value : '')
  /**
   * Rapid pager clicks can start several router pushes before the first settles.
   * While our own push is in flight, an older route event must not write the page
   * back (next → prev would otherwise land on 2). Local state is authoritative
   * until the last sync settles; external back/forward still restores afterwards.
   */
  let syncPending = 0
  let syncSequence = 0
  function restore() {
    if (syncPending > 0) return
    const query = route.query
    const file = scalar(query.file)
    // Paths can only select a registered PDF; never pass arbitrary query paths to APIs.
    selectedPath.value = options.files.value.some((f) => f.relPath === file)
      ? file
      : ''
    const page = scalar(query.page)
    currentPage.value =
      /^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page))
        ? Number(page)
        : null
    keyword.value = scalar(query.q).slice(0, 300)
    source.value = ['jxj', 'miit', 'unknown'].includes(scalar(query.source))
      ? scalar(query.source)
      : ''
    const y = scalar(query.year)
    year.value = /^(?:\d{4}|unknown)$/.test(y) ? y : ''
    filters.value = {
      states: [
        ...new Set(
          scalar(query.states)
            .split(',')
            .filter((s): s is 'text' | 'empty' | 'none' =>
              ['text', 'empty', 'none'].includes(s),
            ),
        ),
      ],
      range: scalar(query.range).slice(0, 1000),
      text: scalar(query.text).slice(0, 500),
    }
    // Whitelist the optional view so a hand-edited URL cannot invent a layout.
    const requestedView = scalar(query.view)
    view.value = OCR_VIEWS.includes(requestedView as OcrView)
      ? (requestedView as OcrView)
      : 'text'
  }
  const keys = [
    'file',
    'page',
    'q',
    'source',
    'year',
    'states',
    'range',
    'text',
    'view',
  ]
  function sync(push = false) {
    const query = { ...route.query }
    keys.forEach((key) => delete query[key])
    const values = {
      file: selectedPath.value,
      page: currentPage.value === null ? '' : String(currentPage.value),
      q: keyword.value,
      source: source.value,
      year: year.value,
      states: filters.value.states.join(','),
      range: filters.value.range,
      text: filters.value.text,
      view: view.value === 'text' ? '' : view.value,
    }
    Object.entries(values).forEach(([key, value]) => {
      if (value) query[key] = value
    })
    if (JSON.stringify(query) !== JSON.stringify(route.query)) {
      const sequence = ++syncSequence
      syncPending += 1
      void Promise.resolve(
        router[push ? 'push' : 'replace']({ query, hash: route.hash }),
      )
        .catch(() => {})
        .finally(() => {
          syncPending = Math.max(0, syncPending - 1)
          if (sequence === syncSequence) syncPending = 0
        })
    }
  }
  function blocked() {
    if (dirty.value || options.busy.value) {
      notice.value = dirty.value
        ? '有未保存的草稿，请先保存或取消编辑，再切换或筛选。'
        : '写入处理中，请完成后再切换。'
      return true
    }
    return false
  }
  /**
   * Returns whether the navigation was accepted, so the caller (the file sheet)
   * can keep its own surface open instead of closing over a blocked action.
   */
  function selectFile(path: string): boolean {
    if (path === selectedPath.value) return false
    if (blocked() || !options.files.value.some((f) => f.relPath === path))
      return false
    selectedPath.value = path
    currentPage.value = null
    filters.value = { states: [], range: '', text: '' }
    notice.value = ''
    sync(true)
    return true
  }
  function navigate(page: number) {
    if (blocked() || !filteredRows.value.some((row) => row.page === page))
      return
    currentPage.value = page
    notice.value = ''
    sync(true)
  }
  function setFilters(next: PageFilters) {
    if (blocked()) return
    filters.value = next
    sync()
  }
  function setView(next: OcrView) {
    if (!OCR_VIEWS.includes(next)) return
    view.value = next
    sync()
  }
  function setFileFilter(key: 'q' | 'source' | 'year', value: string) {
    if (key === 'q') keyword.value = value
    else if (key === 'source') source.value = value
    else year.value = value
    sync()
  }
  watch([() => route.query, () => options.files.value], restore, {
    immediate: true,
  })
  watch(dirty, (value) => {
    if (!value && notice.value.includes('未保存的草稿')) notice.value = ''
  })
  watch([filteredRows, options.ready, dirty, options.busy], () => {
    if (!options.ready.value || dirty.value || options.busy.value) return
    if (
      currentPage.value !== null &&
      filteredRows.value.some((row) => row.page === currentPage.value)
    )
      return
    const previous = currentPage.value
    currentPage.value = filteredRows.value[0]?.page ?? null
    // Loading a file for the first time is not a "jump": only announce a move
    // when a filter actually removed the page the user was on.
    notice.value =
      currentPage.value === null
        ? '没有命中页，可清除页筛选恢复。'
        : previous === null
          ? ''
          : `定位到首个命中：第 ${currentPage.value} 页`
    sync()
  })
  onBeforeRouteUpdate((to) => {
    if (to.fullPath === route.fullPath) return
    // Passive URL synchronization is allowed if it does not abandon the draft target.
    if (
      (dirty.value || options.busy.value) &&
      (to.query.file !== selectedPath.value ||
        String(to.query.page ?? '') !== String(currentPage.value ?? '') ||
        scalar(to.query.states) !== filters.value.states.join(',') ||
        scalar(to.query.range) !== filters.value.range ||
        scalar(to.query.text) !== filters.value.text)
    )
      return !blocked()
  })
  onBeforeRouteLeave(() => !blocked())
  function beforeUnload(event: BeforeUnloadEvent) {
    if (!dirty.value && !options.busy.value) return
    event.preventDefault()
    event.returnValue = ''
  }
  onMounted(() => window.addEventListener('beforeunload', beforeUnload))
  onBeforeUnmount(() =>
    window.removeEventListener('beforeunload', beforeUnload),
  )
  return {
    selectedPath,
    currentPage,
    currentRow,
    keyword,
    source,
    year,
    filters,
    view,
    dirty,
    notice,
    filteredRows,
    fileMatches,
    selectFile,
    navigate,
    setFilters,
    setView,
    setFileFilter,
    blocked,
  }
}
