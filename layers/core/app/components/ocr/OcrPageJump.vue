<script setup lang="ts">
import { computed, nextTick, useTemplateRef } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '#core/app/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '#core/app/components/ui/sheet'
import type { WorkbenchCounts, WorkbenchRow } from '#core/lib/ocr-workbench'
import OcrPageNavigator from './OcrPageNavigator.vue'

const { isNarrow, dirty, writeBusy, ready, detailError } = defineProps<{
  isNarrow: boolean
  pages: number[]
  rows: WorkbenchRow[]
  currentPage: number | null
  counts: WorkbenchCounts
  filtered: boolean
  imageVersion: string | null
  dirty: boolean
  writeBusy: boolean
  ready: boolean
  detailError: string
}>()
const pageNavOpen = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ navigate: [page: number]; clearFilters: [] }>()
const pageNavTrigger = useTemplateRef<InstanceType<typeof Button>>('pageNavTrigger')

/**
 * 页面导航的守卫与原因。与底栏/筛选同一口径：草稿与写入在飞时不能跳页，
 * 但仍允许打开面板浏览（页面格子只做 aria-disabled，不用 disabled 把焦点也拿走）。
 */
const navDisabled = computed(
  () =>
    dirty ||
    writeBusy ||
    !ready ||
    !!detailError,
)
const navBlockedReason = computed(() => {
  if (dirty) return '有未保存的草稿，保存或取消编辑后才能跳到别的页。'
  if (writeBusy) return '写入处理中，完成后再跳到别的页。'
  if (detailError) return '这份文件的结果现在读不到，先重试读取。'
  if (!ready) return '文件还在读取中，稍后再跳页。'
  return ''
})

/**
 * 页面导航面板的唯一出口。桌面保持打开以便连续翻看；移动端点完即回到文档，
 * 并把焦点交还页号触发按钮，避免焦点落到 body。
 */
function selectNavigatorPage(page: number) {
  emit('navigate', page)
  if (!isNarrow) return
  closePageNav()
}

/** 输入页号后关闭面板。 */
function closePageNav() {
  pageNavOpen.value = false
}

/** 移动端页号按钮位于 Sheet 外，关闭后显式恢复焦点。 */
function focusPageNavTrigger(event: Event) {
  event.preventDefault()
  void nextTick(() => pageNavTrigger.value?.$el?.focus())
}
</script>

<template>
  <!-- 页面导航：桌面用 Popover（覆盖层，不占文档宽），移动端点开是底部 Sheet。
       一个入口同时承担“输入实际页号”和“直接点页/缩略图”。 -->
  <Popover v-if="!isNarrow" v-model:open="pageNavOpen">
    <PopoverTrigger as-child>
      <Button
        ref="pageNavTrigger"
        variant="ghost"
        size="sm"
        class="shrink-0 gap-1 tabular-nums"
        :disabled="currentPage === null"
        aria-label="跳转实际页号"
        aria-haspopup="dialog"
        :aria-expanded="pageNavOpen"
        :title="
          currentPage === null
            ? '当前没有可跳转的页'
            : '打开页导航：直接点页或输入实际页号'
        "
      >
        <span aria-live="polite">
          {{
            currentPage === null
              ? '无命中页'
              : `第 ${currentPage} / ${rows.length} 页`
          }}
        </span>
        <ChevronDown class="size-3.5 opacity-60" />
      </Button>
    </PopoverTrigger>
    <PopoverContent
      align="start"
      class="w-[min(88vw,24rem)] p-0"
    >
      <OcrPageNavigator
        :pages="pages"
        :rows="rows"
        :current-page="currentPage"
        :total-pages="rows.length"
        :counts="counts"
        :filtered="filtered"
        :disabled="navDisabled"
        :blocked-reason="navBlockedReason"
        :image-version="imageVersion"
        variant="popover"
        @navigate="selectNavigatorPage"
        @clear-filters="emit('clearFilters')"
        @close="closePageNav"
      />
    </PopoverContent>
  </Popover>
  <Button
    v-else
    ref="pageNavTrigger"
    variant="ghost"
    size="sm"
    class="shrink-0 gap-1 tabular-nums"
    :disabled="currentPage === null"
    aria-label="跳转实际页号"
    aria-haspopup="dialog"
    :aria-expanded="pageNavOpen"
    :title="
      currentPage === null
        ? '当前没有可跳转的页'
        : '打开页导航：直接点页或输入实际页号'
    "
    @click="pageNavOpen = true"
  >
    <span aria-live="polite">
      {{
        currentPage === null
          ? '无命中页'
          : `第 ${currentPage} / ${rows.length} 页`
      }}
    </span>
    <ChevronDown class="size-3.5 opacity-60" />
  </Button>

  <!-- 移动端的同一面板：底部 Sheet，点选后关闭并回到当前页上下文。 -->
  <Sheet v-if="isNarrow" v-model:open="pageNavOpen">
    <SheetContent
      side="bottom"
      class="max-h-[85dvh] gap-0 p-0"
      @close-auto-focus="focusPageNavTrigger"
    >
      <!-- 面板自己带可见标题；这里只给读屏一个标题与说明。 -->
      <SheetHeader class="sr-only">
        <SheetTitle>页面导航</SheetTitle>
        <SheetDescription>
          直接点缩略图或输入实际页号；这里只列当前筛选命中的页。
        </SheetDescription>
      </SheetHeader>
      <OcrPageNavigator
        :pages="pages"
        :rows="rows"
        :current-page="currentPage"
        :total-pages="rows.length"
        :counts="counts"
        :filtered="filtered"
        :disabled="navDisabled"
        :blocked-reason="navBlockedReason"
        :image-version="imageVersion"
        variant="sheet"
        class="min-h-0 flex-1"
        @navigate="selectNavigatorPage"
        @clear-filters="emit('clearFilters')"
        @close="closePageNav"
      />
    </SheetContent>
  </Sheet>
</template>
