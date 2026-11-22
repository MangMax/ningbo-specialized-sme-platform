<script setup lang="ts">
import { computed } from 'vue'
import { Filter, Images, Loader2, MoreHorizontal, RefreshCw, Upload } from '@lucide/vue'
import FilterChip from '#core/app/components/FilterChip.vue'
import { Badge } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#core/app/components/ui/dropdown-menu'
import {
  STATE_BADGE,
  STATE_WORD,
  type PageFilters,
  type PageReviewState,
  type WorkbenchCounts,
} from '#core/lib/ocr-workbench'

const {
  filters,
  canImport,
  importNotReady: IMPORT_NOT_READY,
} = defineProps<{
  selectedPath: string
  counts: WorkbenchCounts
  currentPage: number | null
  currentState: PageReviewState
  filters: PageFilters
  visibleCount: number
  dirty: boolean
  writeBusy: boolean
  ready: boolean
  detailLoading: boolean
  detailError: string
  loadedPath: string
  status: { tone: 'ok' | 'warn' | 'error'; message: string } | null
  notice: string
  canImport: boolean
  importNotReady: string
  renderedCount: number
  pageCount: number | null
  rendering: boolean
}>()
const filterOpen = defineModel<boolean>('filterOpen', { required: true })
const emit = defineEmits<{
  filter: [filters: PageFilters]
  refresh: []
  import: []
  render: []
}>()

interface ActivePageFilter {
  key: string
  label: string
  remove: () => void
}
const filterChips = computed<ActivePageFilter[]>(() => {
  const chips: ActivePageFilter[] = filters.states.map((state) => ({
    key: `state-${state}`,
    label: STATE_WORD[state],
    remove: () =>
      emit('filter', {
        ...filters,
        states: filters.states.filter((item) => item !== state),
      }),
  }))
  if (filters.range.trim())
    chips.push({
      key: 'range',
      label: `页 ${filters.range.trim()}`,
      remove: () => emit('filter', { ...filters, range: '' }),
    })
  if (filters.text.trim())
    chips.push({
      key: 'text',
      label: `关键词 ${filters.text.trim()}`,
      remove: () => emit('filter', { ...filters, text: '' }),
    })
  return chips
})

const activeFilterCount = computed(() => filterChips.value.length)

function clearFilters() {
  emit('filter', { states: [], range: '', text: '' })
}
</script>

<template>
  <header class="bg-card shrink-0 overflow-hidden rounded-md border">
    <div class="ocr-topbar flex h-14 min-w-0 items-center gap-2 px-2.5 sm:px-3">
      <span aria-hidden="true" class="hidden shrink-0 text-sm font-semibold md:inline">识别校对</span>

      <div
        role="region"
        aria-label="当前文件与页号"
        class="flex min-w-0 flex-1 items-center gap-1"
      >
        <slot />
      </div>

      <div class="ml-auto flex shrink-0 items-center gap-1">
        <!-- Short viewports hide the metadata row to give the document height;
             the filter entry and its active count move up here. -->
        <Button
          variant="ghost"
          size="sm"
          class="ocr-short-filter hidden h-8 gap-1 px-2"
          :disabled="!ready || !!detailError"
          aria-label="筛选当前文件"
          @click="filterOpen = true"
        >
          <Filter />
          <span v-if="activeFilterCount" class="tabular-nums">{{
            activeFilterCount
          }}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              class="size-9"
              aria-label="工作台更多操作"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-52">
            <DropdownMenuGroup>
              <DropdownMenuItem @select="emit('refresh')">
                <RefreshCw />
                刷新文件与结果
              </DropdownMenuItem>
              <DropdownMenuItem
                :disabled="!canImport"
                :title="canImport ? undefined : IMPORT_NOT_READY"
                @select="emit('import')"
              >
                <Upload />
                导入识别结果
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="
                  selectedPath &&
                  (renderedCount < (pageCount ?? 0) || renderedCount === 0)
                "
                :disabled="rendering || writeBusy"
                @select="emit('render')"
              >
                <Loader2 v-if="rendering" class="animate-spin motion-reduce:animate-none" />
                <Images v-else />
                {{ rendering ? '渲染中…' : '渲染页图' }}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <!-- 文件级身份只在这里出现一次：计数、筛选入口与活跃条件、状态行。 -->
    <div
      v-if="selectedPath"
      class="ocr-meta-row flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-t px-2.5 py-1.5 text-xs sm:px-3"
    >
      <span class="text-muted-foreground shrink-0 tabular-nums">
        有文本 {{ counts.text }} · 空结果 {{ counts.empty }} · 未识别
        {{ counts.none }}
      </span>
      <Badge
        v-if="currentPage !== null"
        :variant="STATE_BADGE[currentState]"
        class="shrink-0"
        >{{ STATE_WORD[currentState] }}</Badge
      >
      <span
        v-if="activeFilterCount"
        class="text-muted-foreground shrink-0 tabular-nums"
        >命中 {{ visibleCount }} 页</span
      >

      <Button
        variant="outline"
        size="sm"
        class="h-7 shrink-0 px-2"
        :disabled="!ready || !!detailError"
        @click="filterOpen = true"
      >
        <Filter />
        筛选<template v-if="activeFilterCount">
          <span class="tabular-nums">{{ activeFilterCount }}</span></template
        >
      </Button>

      <!-- Chips stay removable at every width (390 included): one horizontally
           scrollable row on narrow screens, wrapped from sm up. -->
      <span
        class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto sm:flex-wrap sm:overflow-visible"
      >
        <FilterChip
          v-for="chip in filterChips"
          :key="chip.key"
          :label="chip.label"
          :disabled="dirty"
          class="max-w-44 sm:max-w-52 [&>button]:size-6"
          @remove="chip.remove"
        />
        <Button
          v-if="activeFilterCount && visibleCount"
          variant="ghost"
          size="sm"
          class="h-7 shrink-0 px-1.5 text-xs"
          :disabled="dirty"
          @click="clearFilters"
          >清除条件</Button
        >
      </span>

      <span class="ml-auto flex min-w-0 items-center gap-2">
        <span
          v-if="dirty"
          role="status"
          class="text-foreground max-w-full truncate text-[11px] font-medium"
          title="有未保存的草稿，请先保存或取消编辑，再切换文件、页面或筛选。"
          >有未保存的草稿，请先保存或取消编辑，再切换文件、页面或筛选。</span
        >
        <template v-else>
          <span
            v-if="status"
            role="status"
            class="max-w-full truncate text-[11px]"
            :class="
              status.tone === 'error'
                ? 'text-destructive font-medium'
                : 'text-muted-foreground'
            "
            :title="status.message"
            >{{ status.message }}</span
          >
          <span
            v-if="notice && visibleCount"
            role="status"
            class="text-muted-foreground max-w-full truncate text-[11px]"
            :title="notice"
            >{{ notice }}</span
          >
          <span
            v-if="detailLoading && loadedPath"
            role="status"
            class="text-muted-foreground truncate text-[11px]"
            >正在刷新，保留上次成功读取的当前文件内容…</span
          >
        </template>
      </span>
    </div>
  </header>
</template>

<style scoped>
@media (max-height: 560px) {
  .ocr-meta-row {
    display: none;
  }
  .ocr-short-filter {
    display: inline-flex;
  }
  .ocr-topbar {
    height: 2.5rem;
  }
}
</style>
