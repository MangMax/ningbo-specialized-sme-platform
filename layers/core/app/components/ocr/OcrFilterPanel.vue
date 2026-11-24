<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { Filter, X } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import { Checkbox } from '#core/app/components/ui/checkbox'
import { Input } from '#core/app/components/ui/input'
import { Label } from '#core/app/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '#core/app/components/ui/sheet'
import {
  parsePageRange,
  STATE_WORD,
  type PageFilters,
  type PageReviewState,
} from '#core/lib/ocr-workbench'

/**
 * 组合筛选按需展开：默认只占元信息行的一颗「筛选 n」和活跃 chips，
 * 不再常驻 226/358px 的筛选卡。应用前不改当前页，应用后由 navigation
 * 保留仍命中的页、否则明确移到首个命中。
 */
const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  filters: PageFilters
  disabled: boolean
}>()

const emit = defineEmits<{
  filter: [filters: PageFilters]
}>()

const isNarrow = useMediaQuery('(max-width: 639px)')
const side = computed(() => (isNarrow.value ? 'bottom' : 'right'))

const draft = reactive<PageFilters>({
  states: [...props.filters.states],
  range: props.filters.range,
  text: props.filters.text,
})
const rangeError = ref('')

watch(open, (value) => {
  if (!value) return
  draft.states = [...props.filters.states]
  draft.range = props.filters.range
  draft.text = props.filters.text
  rangeError.value = ''
})

watch(
  () => props.filters,
  (value) => {
    if (open.value) return
    draft.states = [...value.states]
    draft.range = value.range
    draft.text = value.text
  },
)

function toggle(state: PageReviewState, checked: boolean | 'indeterminate') {
  draft.states =
    checked === true
      ? [...new Set([...draft.states, state])]
      : draft.states.filter((s) => s !== state)
}

function apply() {
  if (parsePageRange(draft.range) === null) {
    rangeError.value = '页范围无效，请使用正整数页号或由小到大的范围。'
    return
  }
  rangeError.value = ''
  emit('filter', {
    states: [...draft.states],
    range: draft.range,
    text: draft.text,
  })
  open.value = false
}

function clearAll() {
  draft.states = []
  draft.range = ''
  draft.text = ''
  rangeError.value = ''
  emit('filter', { states: [], range: '', text: '' })
  open.value = false
}
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent :side="side" floating-size="compact" class="flex min-h-0 flex-col gap-0 overflow-hidden p-0 max-sm:max-h-dvh">
      <SheetHeader class="shrink-0 border-b px-4 py-4 pr-12">
        <SheetTitle class="flex items-center gap-2">
          <Filter class="size-4" />
          筛选当前文件
        </SheetTitle>
        <SheetDescription>
          状态多选取并集，与其他条件取交集；未选状态表示全部。
        </SheetDescription>
      </SheetHeader>

      <form
        class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4"
        @submit.prevent="apply"
        @keydown.enter.prevent="apply"
      >
        <fieldset :disabled="disabled" class="flex flex-col gap-2">
          <legend class="mb-1 text-xs font-medium">页状态</legend>
          <div class="flex flex-wrap gap-x-4 gap-y-2">
            <span
              v-for="state in ['text', 'empty', 'none'] as const"
              :key="state"
              class="flex min-h-9 items-center gap-2"
            >
              <Checkbox
                :id="`ocr-state-${state}`"
                :model-value="draft.states.includes(state)"
                @update:model-value="toggle(state, $event)"
              />
              <Label :for="`ocr-state-${state}`" class="text-sm">{{
                STATE_WORD[state]
              }}</Label>
            </span>
          </div>
        </fieldset>

        <div class="flex flex-col gap-1.5">
          <Label for="ocr-range" class="text-xs">实际页号 / 范围</Label>
          <Input
            id="ocr-range"
            v-model="draft.range"
            aria-label="实际页号或范围"
            placeholder="如 1,3-8"
            :disabled="disabled"
            :aria-invalid="parsePageRange(draft.range) === null"
            @update:model-value="rangeError = ''"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="ocr-text" class="text-xs">当前文件正文关键词</Label>
          <Input
            id="ocr-text"
            v-model="draft.text"
            aria-label="当前文件正文关键词"
            placeholder="搜索已有 OCR 正文"
            :disabled="disabled"
          />
        </div>

        <p v-if="rangeError" role="alert" class="text-destructive text-xs">
          {{ rangeError }}
        </p>
      </form>

      <SheetFooter class="shrink-0 flex-row flex-wrap items-center gap-2 border-t px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          :disabled="disabled"
          @click="open = false"
        >
          <X />
          取消
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="disabled"
          @click="clearAll"
        >
          清除全部
        </Button>
        <Button size="sm" class="ml-auto" :disabled="disabled" @click="apply">
          应用筛选
        </Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
