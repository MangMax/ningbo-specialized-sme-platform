<script setup lang="ts">
import { Search } from '@lucide/vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { StoredFileRow } from '~~/server/utils/stored-files'
defineProps<{
  fileMatches: StoredFileRow[]
  total: number
  fileYears: number[]
  keyword: string
  source: string
  year: string
  selectedPath: string
  filesLoading: boolean
  filesError: string
  disabled: boolean
}>()
const emit = defineEmits<{
  filter: [key: 'q' | 'source' | 'year', value: string]
  select: [path: string]
  retry: []
}>()
function clearFilters() {
  emit('filter', 'q', '')
  emit('filter', 'source', '')
  emit('filter', 'year', '')
}
</script>
<template>
  <Card class="h-fit lg:sticky lg:top-20">
    <CardHeader>
      <CardTitle class="text-sm">选择 PDF</CardTitle>
    </CardHeader>
    <CardContent class="flex flex-col gap-2">
      <div class="relative">
        <Search
          class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
        />
        <Input
          :model-value="keyword"
          @update:model-value="emit('filter', 'q', String($event))"
          class="pl-8"
          type="search"
          aria-label="按文件名搜索"
          placeholder="搜索文件名"
        />
      </div>

      <Select
        :model-value="source || 'all'"
        @update:model-value="
          emit('filter', 'source', $event === 'all' ? '' : String($event))
        "
      >
        <SelectTrigger aria-label="按来源筛选"
          ><SelectValue placeholder="全部来源"
        /></SelectTrigger>
        <SelectContent
          ><SelectGroup>
            <SelectItem value="all">全部来源</SelectItem
            ><SelectItem value="jxj">市经信局</SelectItem
            ><SelectItem value="miit">工信部</SelectItem
            ><SelectItem value="unknown">来源未标注</SelectItem>
          </SelectGroup></SelectContent
        >
      </Select>
      <Select
        :model-value="year || 'all'"
        @update:model-value="
          emit('filter', 'year', $event === 'all' ? '' : String($event))
        "
      >
        <SelectTrigger aria-label="按公布年份筛选"
          ><SelectValue placeholder="全部公布年份"
        /></SelectTrigger>
        <SelectContent
          ><SelectGroup>
            <SelectItem value="all">全部公布年份</SelectItem
            ><SelectItem v-for="y in fileYears" :key="y" :value="String(y)"
              >{{ y }} 年公布</SelectItem
            ><SelectItem value="unknown">公布年份未标注</SelectItem>
          </SelectGroup></SelectContent
        >
      </Select>
      <p class="text-muted-foreground text-xs">
        匹配 {{ fileMatches.length }} / {{ total }} 份 PDF；年份仅指文件公布年。
      </p>
      <Button variant="ghost" size="sm" @click="clearFilters"
        >清除文件筛选</Button
      >
      <p
        v-if="
          selectedPath && !fileMatches.some((f) => f.relPath === selectedPath)
        "
        class="text-muted-foreground text-xs"
      >
        当前文件不在筛选结果中，仍保留当前工作区。
      </p>
      <div v-if="filesLoading && !total" class="flex flex-col gap-1.5">
        <Skeleton v-for="i in 5" :key="i" class="h-8 w-full" />
      </div>

      <Alert v-if="filesError" variant="destructive">
        <AlertDescription class="text-destructive! font-medium"
          >{{ filesError
          }}<Button size="sm" variant="outline" @click="emit('retry')"
            >重试文件列表</Button
          ></AlertDescription
        >
      </Alert>

      <p
        v-if="!filesLoading && !fileMatches.length"
        class="text-muted-foreground text-xs leading-relaxed"
      >
        没有匹配的 PDF。文件库里只登记了非 PDF 时,这一页没有可校对的扫描件。
      </p>

      <!-- 列表用一排按钮而不是表格:每行只有一个动作(选中),表格的列在这里没有信息。 -->
      <ul
        v-if="fileMatches.length"
        class="flex max-h-[26rem] flex-col gap-0.5 overflow-auto"
      >
        <li v-for="file in fileMatches" :key="file.id">
          <button
            type="button"
            class="hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-ring/50 w-full truncate rounded-sm px-2 py-1.5 text-left text-xs transition-colors focus-visible:ring-3 focus-visible:outline-none"
            :class="
              file.relPath === selectedPath
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground'
            "
            :aria-current="file.relPath === selectedPath ? 'true' : undefined"
            :title="file.filename"
            :disabled="disabled"
            @click="emit('select', file.relPath)"
          >
            {{ file.displayName || file.filename }}
          </button>
        </li>
      </ul>
    </CardContent>
  </Card>
</template>
