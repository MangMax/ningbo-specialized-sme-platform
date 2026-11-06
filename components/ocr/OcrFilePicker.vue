<script setup lang="ts">
import { computed } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { Check, FileText, Search, X } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import type { WorkbenchCounts } from '~~/lib/ocr-workbench'
import type { StoredFileRow } from '~~/server/utils/stored-files'

/**
 * 文件选择不再常驻成一张卡：工作台顶栏显示当前文件，点开才是这个 Sheet。
 * 当前文件固定置顶并带 check —— 搜索把它过滤掉时，用户仍知道自己在校对哪一份。
 * 除当前文件外不显示页数/待处理统计：那需要每文件额外请求，规则不允许 N+1。
 */
const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  fileMatches: StoredFileRow[]
  total: number
  fileYears: number[]
  keyword: string
  source: string
  year: string
  selectedPath: string
  selected: StoredFileRow | null
  currentPageCount: number
  currentCounts: WorkbenchCounts
  currentLoading: boolean
  filesLoading: boolean
  filesError: string
  disabled: boolean
  /** 有未保存草稿/写入在飞时不允许切换；原因显示在 Sheet 内。 */
  blockedReason?: string
}>()

const emit = defineEmits<{
  filter: [key: 'q' | 'source' | 'year', value: string]
  select: [path: string]
  retry: []
}>()

const isNarrow = useMediaQuery('(max-width: 639px)')
const side = computed(() => (isNarrow.value ? 'bottom' : 'right'))
const hasFileFilter = computed(
  () => !!(props.keyword || props.source || props.year),
)
const otherFiles = computed(() =>
  props.fileMatches.filter((file) => file.relPath !== props.selectedPath),
)
const selectedInMatches = computed(() =>
  props.fileMatches.some((file) => file.relPath === props.selectedPath),
)

function clearFilters() {
  emit('filter', 'q', '')
  emit('filter', 'source', '')
  emit('filter', 'year', '')
}

function choose(path: string) {
  if (props.disabled || props.blockedReason) return
  // The parent closes the sheet only after an accepted selection. Closing here
  // would hide the fact that the draft guard rejected the switch.
  emit('select', path)
}

function display(file: StoredFileRow) {
  return file.displayName || file.filename
}

function fileMeta(file: StoredFileRow) {
  const sourceWord =
    file.source === 'miit'
      ? '工信部'
      : file.source === 'jxj'
        ? '市经信局'
        : '来源未标注'
  return [sourceWord, file.year == null ? '年份未标注' : `${file.year} 年公布`].join(
    ' · ',
  )
}
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent :side="side" floating-size="standard" class="flex min-h-0 flex-col gap-0 overflow-hidden p-0 max-sm:max-h-dvh">
      <SheetHeader class="shrink-0 border-b px-4 py-4">
        <SheetTitle>选择 PDF</SheetTitle>
        <SheetDescription>
          只列已登记的 PDF；年份仅指文件公布年，不替代认定/复核年份。
        </SheetDescription>
      </SheetHeader>

      <div class="flex shrink-0 flex-col gap-2 border-b px-4 py-3">
        <div class="relative">
          <Search
            class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
          />
          <Input
            :model-value="keyword"
            class="pl-8"
            type="search"
            aria-label="按文件名搜索"
            placeholder="搜索文件名"
            @update:model-value="emit('filter', 'q', String($event))"
          />
        </div>
        <!-- 两个筛选控件成组、均匀占列：trigger 默认 w-fit 会在列里留下大空洞。 -->
        <div class="grid grid-cols-2 gap-2">
          <Select
            :model-value="source || 'all'"
            @update:model-value="
              emit('filter', 'source', $event === 'all' ? '' : String($event))
            "
          >
            <SelectTrigger class="w-full" aria-label="按来源筛选">
              <SelectValue placeholder="全部来源" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部来源</SelectItem>
                <SelectItem value="jxj">市经信局</SelectItem>
                <SelectItem value="miit">工信部</SelectItem>
                <SelectItem value="unknown">来源未标注</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            :model-value="year || 'all'"
            @update:model-value="
              emit('filter', 'year', $event === 'all' ? '' : String($event))
            "
          >
            <SelectTrigger class="w-full" aria-label="按公布年份筛选">
              <SelectValue placeholder="全部公布年份" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部公布年份</SelectItem>
                <SelectItem v-for="y in fileYears" :key="y" :value="String(y)">
                  {{ y }} 年公布
                </SelectItem>
                <SelectItem value="unknown">公布年份未标注</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground text-xs tabular-nums">
            匹配 {{ fileMatches.length }} / {{ total }} 份 PDF
          </span>
          <Button
            v-if="hasFileFilter"
            variant="outline"
            size="sm"
            class="h-8"
            @click="clearFilters"
          >
            <X />
            清除文件筛选
          </Button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-2 py-2">
        <div v-if="filesLoading && !total" class="flex flex-col gap-1.5 p-2">
          <Skeleton v-for="i in 5" :key="i" class="h-11 w-full" />
        </div>

        <Alert v-if="filesError" variant="destructive" class="m-2">
          <AlertDescription class="text-destructive! font-medium">
            {{ filesError }}
            <Button size="sm" variant="outline" class="ml-2" @click="emit('retry')">
              重试文件列表
            </Button>
          </AlertDescription>
        </Alert>

        <template v-if="selected">
          <p class="text-muted-foreground px-2 pt-1 pb-1 text-[11px] font-medium">
            当前文件
          </p>
          <div
            aria-current="true"
            class="bg-accent text-accent-foreground flex min-h-11 w-full items-start gap-2 rounded-sm px-2 py-2"
          >
            <Check class="mt-0.5 size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium break-words" :title="display(selected)">
                {{ display(selected) }}
              </p>
              <p class="text-muted-foreground mt-0.5 truncate text-[11px]">
                {{ fileMeta(selected) }}
                <template v-if="currentLoading"> · 正在读取页数…</template>
                <template v-else-if="currentPageCount > 0">
                  · 共 {{ currentPageCount }} 页 · 有文本
                  {{ currentCounts.text }} · 空结果 {{ currentCounts.empty }} ·
                  未识别 {{ currentCounts.none }}
                </template>
              </p>
            </div>
          </div>
          <p
            v-if="keyword || source || year"
            class="text-muted-foreground px-2 pt-2 text-[11px]"
          >
            {{
              selectedInMatches
                ? '当前文件也在匹配结果中。'
                : '当前文件不在筛选结果中，仍保留当前工作区。'
            }}
          </p>
        </template>

        <p class="text-muted-foreground px-2 pt-2 pb-1 text-[11px] font-medium">
          {{ selected ? '其他 PDF' : 'PDF 文件' }}
        </p>

        <ul v-if="otherFiles.length || (!selected && fileMatches.length)" class="flex flex-col gap-0.5">
          <li v-for="file in selected ? otherFiles : fileMatches" :key="file.id">
            <button
              type="button"
              class="hover:bg-accent/60 focus-visible:border-ring focus-visible:ring-ring/50 flex min-h-11 w-full items-start gap-2 rounded-sm px-2 py-2 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none"
              :disabled="disabled || !!blockedReason"
              :title="file.filename"
              @click="choose(file.relPath)"
            >
              <FileText class="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <span class="min-w-0 flex-1">
                <!-- Full names wrap; truncation must not hide the distinguishing
                     tail of two similarly named files. -->
                <span class="block text-sm break-words">{{
                  display(file)
                }}</span>
                <span class="text-muted-foreground mt-0.5 block truncate text-[11px]">
                  {{ fileMeta(file) }}
                </span>
              </span>
            </button>
          </li>
        </ul>

        <p
          v-if="!filesLoading && !fileMatches.length"
          class="text-muted-foreground px-2 py-4 text-[13px] leading-relaxed"
        >
          没有匹配的 PDF。
        </p>
        <p
          v-else-if="selected && !otherFiles.length"
          class="text-muted-foreground px-2 py-4 text-[13px] leading-relaxed"
        >
          没有其他匹配文件。
        </p>
      </div>

      <SheetFooter class="shrink-0 border-t px-4 py-3">
        <p
          v-if="blockedReason"
          role="status"
          class="text-destructive text-[13px] leading-relaxed font-medium"
        >
          {{ blockedReason }}
        </p>
        <p class="text-muted-foreground text-[11px] leading-relaxed">
          选中即切换；切换文件会把页码重置为第 1 页，并清空页筛选。
        </p>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
