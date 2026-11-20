<script setup lang="ts">
import { computed, ref } from 'vue'
import { useElementSize } from '@vueuse/core'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import { Input } from '#core/app/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import {
  Pagination, PaginationContent, PaginationEllipsis, PaginationFirst,
  PaginationItem, PaginationLast, PaginationNext, PaginationPrevious,
} from '#core/app/components/ui/pagination'

const props = defineProps<{
  page: number
  pageSize: number
  maxPageSize?: number
  unit: string
  loading?: boolean
  compact?: boolean
  inCard?: boolean
} & ({ mode: 'cursor'; hasNext: boolean; knownPageCount?: number; total?: never } | { mode?: 'numbered'; total: number; hasNext?: never; knownPageCount?: never })>()
const emit = defineEmits<{
  next: []
  previous: []
  'update:page': [value: number]
  'update:pageSize': [value: number]
}>()
const container = ref<HTMLElement | null>(null)
const { width } = useElementSize(container)
const narrow = computed(() => width.value > 0 && width.value < 768)
const compact = computed(() => props.compact || width.value < 768)
const maximum = computed(() => props.maxPageSize ?? 200)
const presets = computed(() => [25, 50, 100, 200].filter(n => n <= maximum.value))
const custom = ref(false)
// The trigger always shows a number: a preset, or the size actually in effect.
// "自定义…" only names the extra option in the list; showing that label in the
// trigger (where it gets clipped to "自定…") said nothing about rows per page.
const sizeModel = computed({
  get: () => String(props.pageSize),
  set: (value: string) => {
    custom.value = value === 'custom'
    // Picking 自定义… keeps the current size until a number is typed.
    if (!custom.value) emit('update:pageSize', Number(value))
  },
})
const customOpen = computed(() => custom.value || !presets.value.includes(props.pageSize))
const totalPages = computed(() => Math.max(1, Math.ceil((props.total ?? 0) / props.pageSize)))
const cursorPages = computed(() => {
  if (props.mode !== 'cursor' || props.knownPageCount === undefined) return []
  const lastKnown = Math.max(1, Math.trunc(props.knownPageCount))
  const neighbors = [props.page - 1, props.page, props.page + 1]
  const pages = [...new Set(narrow.value ? neighbors : [1, ...neighbors, lastKnown])]
    .filter(n => n >= 1 && (n <= lastKnown || n === props.page)).sort((a, b) => a - b)
  return pages.flatMap((n, index): (number | null)[] =>
    index > 0 && n - pages[index - 1]! > 1 ? [null, n] : [n])
})
function onSizeInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value > 0) {
    emit('update:pageSize', Math.min(maximum.value, Math.max(1, Math.trunc(value))))
  }
}
</script>

<template>
  <div ref="container" data-table-pagination data-testid="table-pagination" class="@container/pager w-full min-w-0 text-table leading-5"
    :class="inCard && 'shrink-0 border-t px-3 py-3 sm:px-4'">
    <div class="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 @max-[24rem]/pager:gap-x-1">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 @max-[26rem]/pager:gap-x-2 @max-[24rem]/pager:gap-x-1.5">
        <div class="flex flex-wrap items-center gap-2 whitespace-nowrap @max-[26rem]/pager:gap-x-1.5 @max-[24rem]/pager:gap-x-1">
          <span class="text-muted-foreground">每页</span>
          <Select v-model="sizeModel">
            <SelectTrigger size="sm" class="bg-card w-20 shadow-none @max-[26rem]/pager:w-auto @max-[26rem]/pager:min-w-12 @max-[26rem]/pager:gap-0.5 @max-[26rem]/pager:px-1.5 transition-transform duration-150 ease-snap active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100" aria-label="每页条数" :disabled="loading">
              <!-- The trigger shows the size that is really in effect. Reka's SelectValue
                   resolves its text from the *registered* items, so a size that is not
                   one of the presets (a deep link, or a typed custom size) matched no
                   item and rendered as an empty control; the slot states the number
                   the size model already carries. -->
              <SelectValue>{{ pageSize }}</SelectValue>
            </SelectTrigger>
            <SelectContent class="shadow-none">
              <SelectItem v-for="n in presets" :key="n" :value="String(n)">{{ n }}</SelectItem>
              <SelectItem value="custom">自定义…</SelectItem>
            </SelectContent>
          </Select>
          <Input v-if="customOpen" :model-value="pageSize" type="number" min="1" :max="maximum" class="bg-card h-8 w-20 shadow-none @max-[24rem]/pager:w-12 @max-[24rem]/pager:px-1" aria-label="自定义每页条数" :disabled="loading" @change="onSizeInput" />
          <span class="text-muted-foreground">{{ unit }}</span>
        </div>
        <span class="text-muted-foreground whitespace-nowrap tabular-nums" data-testid="table-total">
          <slot v-if="mode === 'cursor'">第 {{ page }} 页</slot>
          <template v-else>共 {{ (total ?? 0).toLocaleString('zh-CN') }} {{ unit }}</template>
        </span>
      </div>
      <div v-if="mode === 'cursor'" class="ml-auto flex max-w-full flex-none items-center gap-1 @max-[24rem]/pager:gap-0">
        <Button variant="outline" class="@max-[30rem]/pager:size-8 @max-[30rem]/pager:px-0 @max-[24rem]/pager:size-7 @max-[18rem]/pager:size-6" aria-label="上一页" :disabled="loading || page <= 1" @click="emit('previous')"><ChevronLeft class="size-4" aria-hidden="true" /><span class="hidden @min-[48rem]/pager:block">上一页</span></Button>
        <nav v-if="cursorPages.length" aria-label="已知页码" class="flex items-center gap-1 @max-[24rem]/pager:gap-0">
          <template v-for="(number, index) in cursorPages" :key="number ?? `gap-${index}`">
            <Button v-if="number !== null" :variant="number === page ? 'outline' : 'ghost'" size="icon" class="@max-[30rem]/pager:size-8 @max-[24rem]/pager:size-7 @max-[18rem]/pager:size-6 @max-[24rem]/pager:[&:not([aria-current=page])]:hidden" :aria-label="`第 ${number} 页`" :aria-current="number === page ? 'page' : undefined" :disabled="loading || number > (knownPageCount ?? page)" @click="emit('update:page', number)">{{ number }}</Button>
            <span v-else aria-hidden="true" class="text-muted-foreground px-1 @max-[24rem]/pager:hidden">…</span>
          </template>
        </nav>
        <Button variant="outline" class="@max-[30rem]/pager:size-8 @max-[30rem]/pager:px-0 @max-[24rem]/pager:size-7 @max-[18rem]/pager:size-6" aria-label="下一页" data-table-next :disabled="loading || !hasNext" @click="emit('next')"><span class="hidden @min-[48rem]/pager:block">下一页</span><ChevronRight class="size-4" aria-hidden="true" /></Button>
      </div>
      <Pagination v-else-if="totalPages > 1" v-slot="{ page: current }" aria-label="表格分页" class="mx-0 ml-auto w-auto max-w-full flex-none justify-end"
        :page="page" :items-per-page="pageSize" :total="total ?? 0" :sibling-count="1" :show-edges="totalPages > 5 && !compact" @update:page="emit('update:page', $event)">
        <PaginationContent v-slot="{ items }" class="max-w-full flex-nowrap justify-end @max-[24rem]/pager:gap-0">
          <PaginationFirst v-if="totalPages > 5" class="@max-[32rem]/pager:hidden" :disabled="loading || page <= 1" aria-label="第一页"><ChevronsLeft class="size-4" /><span class="sr-only">第一页</span></PaginationFirst>
          <PaginationPrevious class="@max-[30rem]/pager:size-8 @max-[30rem]/pager:px-0 @max-[24rem]/pager:size-7 @max-[18rem]/pager:size-6" :disabled="loading || page <= 1" aria-label="上一页"><ChevronLeft class="size-4" /><span class="hidden @min-[48rem]/pager:block">上一页</span></PaginationPrevious>
          <template v-for="(item, index) in items" :key="index">
            <PaginationItem v-if="item.type === 'page'" class="@max-[30rem]/pager:size-8 @max-[24rem]/pager:size-7 @max-[18rem]/pager:size-6 @max-[18rem]/pager:[&:not([aria-current=page])]:hidden" :class="customOpen && '@max-[24rem]/pager:[&:not([aria-current=page])]:hidden'" :value="item.value" :is-active="item.value === current" :aria-current="item.value === current ? 'page' : undefined" :aria-label="`第 ${item.value} 页`" :disabled="loading">{{ item.value }}</PaginationItem>
            <PaginationEllipsis v-else :index="index" />
          </template>
          <PaginationNext class="@max-[30rem]/pager:size-8 @max-[30rem]/pager:px-0 @max-[24rem]/pager:size-7 @max-[18rem]/pager:size-6" :disabled="loading || page >= totalPages" aria-label="下一页"><span class="hidden @min-[48rem]/pager:block">下一页</span><ChevronRight class="size-4" /></PaginationNext>
          <PaginationLast v-if="totalPages > 5" class="@max-[32rem]/pager:hidden" :disabled="loading || page >= totalPages" aria-label="最后一页"><ChevronsRight class="size-4" /><span class="sr-only">最后一页</span></PaginationLast>
        </PaginationContent>
      </Pagination>
    </div>
  </div>
</template>
