<script setup lang="ts">
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { computed, ref, watch } from 'vue'
import {
  STATE_WORD,
  parsePageRange,
  type PageFilters,
  type PageReviewState,
} from '~~/lib/ocr-workbench'
const props = defineProps<{
  filters: PageFilters
  pages: number[]
  currentPage: number | null
  total: number
  disabled: boolean
}>()
const emit = defineEmits<{
  filter: [filters: PageFilters]
  navigate: [page: number]
}>()
const expanded = ref(true)
const jump = ref('')
const jumpError = ref('')
watch(
  () => props.currentPage,
  (page) => {
    jump.value = page === null ? '' : String(page)
    jumpError.value = ''
  },
  { immediate: true },
)
const index = computed(() =>
  props.currentPage === null ? -1 : props.pages.indexOf(props.currentPage),
)
function toggle(state: PageReviewState, checked: boolean | 'indeterminate') {
  emit('filter', {
    ...props.filters,
    states:
      checked === true
        ? [...props.filters.states, state]
        : props.filters.states.filter((s) => s !== state),
  })
}
function go() {
  const page = Number(jump.value)
  if (!/^[1-9]\d*$/.test(jump.value) || !props.pages.includes(page)) {
    jumpError.value = '请输入当前命中范围内的实际页号。'
    return
  }
  jumpError.value = ''
  emit('navigate', page)
}
</script>

<template>
  <section
    aria-label="页筛选与导航"
    class="bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-3"
  >
    <Collapsible v-model:open="expanded" class="flex flex-col gap-3">
      <CollapsibleTrigger as-child
        ><Button variant="ghost" size="sm" class="self-start">{{
          expanded ? '收起页筛选' : '展开页筛选'
        }}</Button></CollapsibleTrigger
      >
      <CollapsibleContent
        class="flex flex-col gap-3 data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-150 ease-snap motion-reduce:animate-none"
      >
        <fieldset :disabled="disabled" class="flex flex-wrap gap-x-4 gap-y-2">
          <legend class="mb-2 text-xs font-medium">
            页状态（多选取并集，未选为全部）
          </legend>
          <span
            v-for="state in ['text', 'empty', 'none'] as const"
            :key="state"
            class="flex items-center gap-1.5"
          >
            <Checkbox
              :id="`ocr-state-${state}`"
              :model-value="filters.states.includes(state)"
              @update:model-value="toggle(state, $event)"
            />
            <Label :for="`ocr-state-${state}`" class="text-xs">{{
              STATE_WORD[state]
            }}</Label>
          </span>
        </fieldset>
        <div class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <div class="flex flex-col gap-1">
            <Label for="ocr-range" class="text-xs">实际页号 / 范围</Label>
            <Input
              id="ocr-range"
              aria-label="实际页号或范围"
              placeholder="如 1,3-8"
              :model-value="filters.range"
              :disabled="disabled"
              :aria-invalid="parsePageRange(filters.range) === null"
              @update:model-value="
                emit('filter', { ...filters, range: String($event) })
              "
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="ocr-text" class="text-xs">当前文件正文关键词</Label>
            <Input
              id="ocr-text"
              aria-label="当前文件正文关键词"
              placeholder="搜索已有 OCR 正文"
              :model-value="filters.text"
              :disabled="disabled"
              @update:model-value="
                emit('filter', { ...filters, text: String($event) })
              "
            />
          </div>
        </div>
        <p
          v-if="parsePageRange(filters.range) === null"
          role="alert"
          class="text-destructive text-xs"
        >
          页范围无效，请使用正整数页号或由小到大的范围。
        </p>
      </CollapsibleContent>
    </Collapsible>
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-muted-foreground text-xs tabular-nums"
        >全文件 {{ total }} 页 · 命中 {{ pages.length }} 页</span
      >
      <Button
        size="sm"
        variant="ghost"
        :disabled="disabled"
        @click="emit('filter', { states: [], range: '', text: '' })"
        >清除页筛选</Button
      >
      <form class="flex items-center gap-2" @submit.prevent="go">
        <Input
          v-model="jump"
          class="w-20"
          aria-label="跳转实际页号"
          inputmode="numeric"
          :disabled="disabled || !pages.length"
        />
        <Button
          size="sm"
          variant="outline"
          :disabled="disabled || !pages.length"
          >跳转</Button
        >
      </form>
      <Button
        size="sm"
        variant="outline"
        :disabled="disabled || index <= 0"
        @click="emit('navigate', pages[index - 1]!)"
        >上一处</Button
      >
      <Button
        size="sm"
        variant="outline"
        :disabled="disabled || index < 0 || index >= pages.length - 1"
        @click="emit('navigate', pages[index + 1]!)"
        >下一处</Button
      >
      <span v-if="currentPage !== null" class="text-sm font-medium"
        >当前第 {{ currentPage }} 页</span
      >
    </div>
    <p v-if="jumpError" role="alert" class="text-destructive text-xs">
      {{ jumpError }}
    </p>
  </section>
</template>
