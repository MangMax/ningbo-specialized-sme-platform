<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Pagination, PaginationContent, PaginationEllipsis, PaginationFirst,
  PaginationItem, PaginationLast, PaginationNext, PaginationPrevious,
} from '@/components/ui/pagination'

const props = defineProps<{
  page: number
  pageSize: number
  total: number
  unit: string
  loading?: boolean
}>()
const emit = defineEmits<{
  'update:page': [value: number]
  'update:pageSize': [value: number]
}>()
const presets = [25, 50, 100, 200]
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
const customOpen = computed(() => custom.value || !presets.includes(props.pageSize))
const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
function onSizeInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value > 0) {
    emit('update:pageSize', Math.min(200, Math.max(1, Math.trunc(value))))
  }
}
</script>

<template>
  <div data-table-pagination data-testid="table-pagination" class="flex flex-wrap items-center gap-x-4 gap-y-3 text-[13px] leading-5">
    <div class="flex items-center gap-2">
      <span class="text-muted-foreground">每页</span>
      <Select v-model="sizeModel">
      <SelectTrigger size="sm" class="bg-card w-20 shadow-none transition-transform duration-150 ease-snap active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100" aria-label="每页条数" :disabled="loading">
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
      <Input v-if="customOpen" :model-value="pageSize" type="number" min="1" max="200" class="bg-card h-8 w-20 shadow-none" aria-label="自定义每页条数" :disabled="loading" @change="onSizeInput" />
      <span class="text-muted-foreground">{{ unit }}</span>
    </div>
    <span class="text-muted-foreground tabular-nums" data-testid="table-total">
      <slot>共 {{ total.toLocaleString('zh-CN') }} {{ unit }}</slot>
    </span>
    <Pagination v-if="total > 0" v-slot="{ page: current }" class="mx-0 w-full justify-center sm:ml-auto sm:w-auto sm:justify-end"
      :page="page" :items-per-page="pageSize" :total="total" :sibling-count="1" :show-edges="totalPages > 5" @update:page="emit('update:page', $event)">
      <PaginationContent v-slot="{ items }" class="flex-wrap justify-center sm:justify-end">
        <PaginationFirst class="hidden sm:flex" :disabled="loading || page <= 1" aria-label="第一页"><ChevronsLeft class="size-4" /><span class="sr-only">第一页</span></PaginationFirst>
        <PaginationPrevious :disabled="loading || page <= 1" aria-label="上一页"><ChevronLeft class="size-4" /><span class="hidden sm:block">上一页</span></PaginationPrevious>
        <template v-for="(item, index) in items" :key="index">
          <PaginationItem v-if="item.type === 'page'" :value="item.value" :is-active="item.value === current" :disabled="loading">{{ item.value }}</PaginationItem>
          <PaginationEllipsis v-else :index="index" />
        </template>
        <PaginationNext :disabled="loading || page >= totalPages" aria-label="下一页"><span class="hidden sm:block">下一页</span><ChevronRight class="size-4" /></PaginationNext>
        <PaginationLast class="hidden sm:flex" :disabled="loading || page >= totalPages" aria-label="最后一页"><ChevronsRight class="size-4" /><span class="sr-only">最后一页</span></PaginationLast>
      </PaginationContent>
    </Pagination>
  </div>
</template>
