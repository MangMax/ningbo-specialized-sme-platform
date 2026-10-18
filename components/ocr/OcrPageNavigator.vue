<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import OcrPageCell from './OcrPageCell.vue'
import {
  pageReviewState,
  STATE_WORD,
  type WorkbenchCounts,
  type WorkbenchRow,
} from '~~/lib/ocr-workbench'

/**
 * 快速页面导航面板：缩略图 + 物理页号 + 三档状态，直接点选。
 *
 * 它**不是**第二套翻页器：唯一的导航事件还是 `navigate`，仍然穿过
 * `useOcrNavigation` 的 dirty/写入守卫；这里没有 prev/next。
 *
 * 过滤时只列命中实际页（不重编号），并提供一个明确的「清除页筛选」动作；
 * 非命中页不会悄悄出现在列表里，也不会因为点选而改变筛选。
 */
const props = defineProps<{
  /** 可跳转的页（筛选生效时 = 命中实际页），升序。 */
  pages: number[]
  /** 当前文件的全部行，用来取页图与状态（已经装载，不再发请求）。 */
  rows: WorkbenchRow[]
  currentPage: number | null
  totalPages: number
  counts: WorkbenchCounts
  /** 页筛选是否生效。 */
  filtered: boolean
  /** 草稿/写入在飞/文件未就绪：仍可浏览，但不接受跳转。 */
  disabled: boolean
  blockedReason?: string
  imageVersion?: string | null
  /** 桌面 Popover 更宽，移动 Sheet 更窄。 */
  variant: 'popover' | 'sheet'
}>()

const emit = defineEmits<{
  navigate: [page: number]
  'clear-filters': []
  /** 输入页号是“去这一页”的明确动作：关闭面板，把画面交还给文档。 */
  close: []
}>()

const jump = ref('')
const jumpError = ref('')
const grid = ref<HTMLElement | null>(null)
const rovingPage = ref<number | null>(null)

/** 移动 Sheet 在手机是 4 列、≥640px 的窄屏（含 720 短视口）用 6 列。 */
const sheetWide = useMediaQuery('(min-width: 640px)')
const columns = computed(() =>
  props.variant === 'sheet' ? (sheetWide.value ? 6 : 4) : 5,
)
const rowByPage = computed(
  () => new Map(props.rows.map((row) => [row.page, row])),
)
const stateByPage = computed(() => {
  const map = new Map<number, ReturnType<typeof pageReviewState>>()
  for (const row of props.rows)
    map.set(row.page, pageReviewState(row.result))
  return map
})
const currentIsListed = computed(
  () => props.currentPage !== null && props.pages.includes(props.currentPage),
)

watch(
  [() => props.currentPage, () => props.pages, () => props.disabled],
  () => {
    const hasCurrent =
      props.currentPage !== null && props.pages.includes(props.currentPage)
    if (!hasCurrent || rovingPage.value === null)
      rovingPage.value = props.pages[0] ?? null
    else rovingPage.value = props.currentPage
    if (props.currentPage !== null) jump.value = String(props.currentPage)
    jumpError.value = ''
    void nextTick(() => {
      const cell = grid.value?.querySelector<HTMLElement>(
        `[data-page="${props.currentPage}"]`,
      )
      if (cell && typeof cell.scrollIntoView === 'function')
        cell.scrollIntoView({ block: 'nearest' })
    })
  },
  { immediate: true },
)

function imageFor(page: number): string {
  const url = rowByPage.value.get(page)?.image?.url ?? ''
  if (!url) return ''
  return props.imageVersion
    ? `${url}?v=${encodeURIComponent(props.imageVersion)}`
    : url
}

function stateFor(page: number) {
  return stateByPage.value.get(page) ?? 'none'
}

function goToPage() {
  const value = jump.value.trim()
  const page = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(page)) {
    jumpError.value = '请输入正整数页号。'
    return
  }
  if (!props.pages.includes(page)) {
    jumpError.value = '请输入当前命中范围内的实际页号。'
    return
  }
  if (props.disabled) {
    jumpError.value = props.blockedReason || '当前不能跳页。'
    return
  }
  jumpError.value = ''
  emit('navigate', page)
  emit('close')
}

function select(page: number) {
  if (props.disabled) return
  emit('navigate', page)
}

/** 方向键在网格内移动焦点；Enter/Space 用按钮原生激活。 */
function onGridKeydown(event: KeyboardEvent) {
  if (!grid.value) return
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const cell = target.closest<HTMLElement>('[data-ocr-page-cell]')
  if (!cell) return
  const cells = [
    ...grid.value.querySelectorAll<HTMLElement>('[data-ocr-page-cell]'),
  ]
  const index = cells.indexOf(cell)
  if (index < 0) return
  let next = -1
  if (event.key === 'ArrowRight') next = index + 1
  else if (event.key === 'ArrowLeft') next = index - 1
  else if (event.key === 'ArrowDown') next = index + columns.value
  else if (event.key === 'ArrowUp') next = index - columns.value
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = cells.length - 1
  else return
  if (next < 0 || next >= cells.length) return
  event.preventDefault()
  rovingPage.value = Number(cells[next]!.dataset.page)
  cells[next]!.focus()
}
</script>

<template>
  <div
    class="flex min-h-0 flex-col"
    :class="variant === 'sheet' ? 'flex-1' : 'max-h-[min(70vh,34rem)]'"
  >
    <div
      class="shrink-0 space-y-2 border-b px-3 py-2.5"
      :class="variant === 'sheet' ? 'pr-10' : ''"
    >
      <div class="flex items-baseline justify-between gap-2">
        <p class="text-xs font-medium">页面导航</p>
        <p class="text-muted-foreground text-[11px] tabular-nums">
          第 {{ currentPage ?? '—' }} / {{ totalPages }} 页
        </p>
      </div>
      <form class="flex items-start gap-2" @submit.prevent="goToPage">
        <label class="sr-only" for="ocr-page-jump">跳到实际页号</label>
        <Input
          id="ocr-page-jump"
          v-model="jump"
          class="w-24"
          inputmode="numeric"
          aria-label="跳转实际页号"
          autocomplete="off"
        />
        <Button
          type="submit"
          size="sm"
          :disabled="disabled || !pages.length"
          >跳转</Button
        >
        <p
          v-if="jumpError"
          role="alert"
          class="text-destructive pt-1.5 text-[11px] leading-relaxed"
        >
          {{ jumpError }}
        </p>
      </form>
      <p
        data-ocr-page-nav-summary
        class="text-muted-foreground text-[11px] leading-relaxed"
      >
        全文件 {{ totalPages }} 页 · 有文本 {{ counts.text }} · 空结果
        {{ counts.empty }} · 未识别 {{ counts.none }}
        <template v-if="filtered">
          · 当前命中 {{ pages.length }} 页
        </template>
      </p>
    </div>

    <div
      class="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-[11px]"
    >
      <span class="flex items-center gap-1">
        <span class="border-foreground h-0 w-3 border-t-2" aria-hidden="true" />
        {{ STATE_WORD.text }}
      </span>
      <span class="flex items-center gap-1">
        <span
          class="border-muted-foreground h-0 w-3 border-t-2"
          aria-hidden="true"
        />
        {{ STATE_WORD.empty }}
      </span>
      <span class="flex items-center gap-1">
        <span
          class="border-muted-foreground/70 h-0 w-3 border-t-2 border-dashed"
          aria-hidden="true"
        />
        {{ STATE_WORD.none }}
      </span>
      <Button
        v-if="filtered"
        variant="ghost"
        size="sm"
        class="ml-auto h-6 px-1.5 text-[11px]"
        :disabled="disabled"
        @click="emit('clear-filters')"
        >清除页筛选，显示全部 {{ totalPages }} 页</Button
      >
    </div>

    <p
      v-if="blockedReason"
      role="status"
      class="text-destructive shrink-0 border-b px-3 py-1 text-[11px] leading-relaxed font-medium"
    >
      {{ blockedReason }}
    </p>

    <div
      ref="grid"
      class="min-h-0 flex-1 overflow-y-auto p-2"
      @keydown="onGridKeydown"
    >
      <p
        v-if="!pages.length"
        class="text-muted-foreground px-2 py-6 text-center text-[13px] leading-relaxed"
      >
        当前筛选没有命中页。清除页筛选后可浏览全部页。
      </p>
      <div
        v-else
        class="grid gap-1.5"
        :class="
          columns === 4
            ? 'grid-cols-4'
            : columns === 6
              ? 'grid-cols-6'
              : 'grid-cols-5'
        "
        role="group"
        :aria-label="
          filtered
            ? `筛选中可跳转的实际页，共 ${pages.length} 页`
            : `全部实际页，共 ${pages.length} 页`
        "
      >
        <OcrPageCell
          v-for="page in pages"
          :key="page"
          :page="page"
          :image-url="imageFor(page)"
          :state="stateFor(page)"
          :current="currentIsListed && page === currentPage"
          :disabled="disabled"
          :roving="page === rovingPage"
          :total="totalPages"
          @select="select"
          @focus-cell="rovingPage = $event"
        />
      </div>
    </div>
  </div>
</template>
