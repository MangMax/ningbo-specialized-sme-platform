<!--
  LogFilters — 单行筛选工具栏 + 折叠的高级条件。

  布局沿用 /files 与 /tasks 已采用的做法：控件自己带 `bg-card` 表面、标签走 sr-only，
  筛选不再铺成一张落在页面底色上的大表单。高级条件（时间、操作、关联标识）收进一个
  自带边框表面的 DisclosurePanel；折叠条上直接报已启用几项，收起时也知道筛选范围。

  提交边界只有一个：所有字段一起在「应用筛选」或回车时生效。清理范围读的是已应用的
  filter，不是草稿，所以草稿改动不会改变清理范围。
-->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { LOG_LEVELS, LOG_OUTCOMES, LOG_SOURCES, type LogFilter } from '~~/lib/logging/contract'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import ComparisonDateTimePicker from '@/components/record-correspondence/ComparisonDateTimePicker.vue'
const props = defineProps<{ filter: LogFilter }>()
const emit = defineEmits<{ apply: [value: Record<string, string>] }>()
const draft = reactive<Record<string, string>>({})
const advancedOpen = ref(false)
const ids = [
  { key: 'requestId', label: '请求标识' },
  { key: 'traceId', label: '链路标识' },
  { key: 'taskId', label: '任务标识' },
  { key: 'fileId', label: '文件编号' },
  { key: 'batchId', label: '批次标识' },
  { key: 'resourceId', label: '资源标识' }
]
const choices = [
  { key: 'level', label: '级别', values: LOG_LEVELS },
  { key: 'source', label: '来源', values: LOG_SOURCES },
  { key: 'outcome', label: '结果', values: LOG_OUTCOMES }
]
// 操作在工具栏里，不在折叠区内：折叠条只报它真正装着的条件。
const advancedKeys = ['from', 'to', ...ids.map((i) => i.key)] as const
const liveValues = computed(() => Object.keys(props.filter).filter((key) => key !== 'limit' && key !== 'cursor'))
const appliedAdvanced = computed(
  () => advancedKeys.filter((key) => props.filter[key as keyof LogFilter]).length
)
const advancedTitle = computed(() =>
  appliedAdvanced.value
    ? `更多筛选（已启用 ${appliedAdvanced.value} 项）`
    : '更多筛选（时间与关联标识）'
)
const showReset = computed(() => liveValues.value.length > 0)
/** 收起时也认得出每个下拉管的是哪一类；选中后把类别带在值前面。 */
const summary = (choice: (typeof choices)[number]) =>
  draft[choice.key] && draft[choice.key] !== 'all'
    ? `${choice.label} · ${draft[choice.key]}`
    : `全部${choice.label}`
function localTime(iso: string | undefined) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
}
watch(
  () => props.filter,
  (filter) => {
    for (const key of ['operation', ...ids.map((i) => i.key)])
      draft[key] = String(filter[key as keyof LogFilter] ?? '')
    for (const choice of choices)
      draft[choice.key] = String(filter[choice.key as keyof LogFilter] ?? 'all')
    draft.from = localTime(filter.from)
    draft.to = localTime(filter.to)
    if (filter.from || filter.to || ids.some((i) => !!filter[i.key as keyof LogFilter])) advancedOpen.value = true
  },
  { immediate: true }
)
function apply() {
  const value: Record<string, string> = {}
  for (const key of ['operation', ...ids.map((i) => i.key), ...choices.map((i) => i.key)])
    if (draft[key] && draft[key] !== 'all') value[key] = draft[key]!.trim()
  for (const key of ['from', 'to']) if (draft[key]) value[key] = new Date(draft[key]!).toISOString()
  emit('apply', value)
}
function reset() {
  for (const key of ['operation', ...ids.map((i) => i.key)]) draft[key] = ''
  for (const choice of choices) draft[choice.key] = 'all'
  draft.from = ''
  draft.to = ''
  advancedOpen.value = false
  emit('apply', {})
}
</script>
<template>
  <form class="flex min-w-0 flex-col gap-2" aria-label="日志筛选" @submit.prevent="apply">
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <FieldGroup class="flex min-w-0 flex-1 flex-row flex-wrap items-center gap-2 max-sm:basis-full">
        <Field v-for="choice in choices" :key="choice.key" orientation="horizontal" class="w-28 shrink-0 sm:w-32">
          <FieldLabel :for="`log-${choice.key}`" class="sr-only">{{ choice.label }}</FieldLabel>
          <Select v-model="draft[choice.key]">
            <SelectTrigger
              :id="`log-${choice.key}`"
              size="sm"
              class="bg-card w-full shadow-none data-[active=true]:border-primary/45 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
              :data-active="!!draft[choice.key] && draft[choice.key] !== 'all'"
            >
              <SelectValue>{{ summary(choice) }}</SelectValue>
            </SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="all">全部{{ choice.label }}</SelectItem>
              <SelectItem v-for="value in choice.values" :key="value" :value="value">{{ value }}</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
        </Field>
        <Separator orientation="vertical" class="hidden h-5 sm:block" aria-hidden="true" />
        <!-- 操作是这一行里唯一的自由文本：它吃掉剩余宽度，窄屏时独占一行。 -->
        <Field orientation="horizontal" class="min-w-36 flex-1 sm:max-w-56">
          <FieldLabel for="log-operation" class="sr-only">操作（精确匹配）</FieldLabel>
          <Input
            id="log-operation"
            v-model="draft.operation"
            maxlength="96"
            class="bg-card h-8 shadow-none"
            placeholder="操作，精确匹配"
          />
        </Field>
        <!-- 动作与字段同组，窄屏折行时按钮跟着输入框走，不单独占一整行。 -->
        <div class="flex shrink-0 items-center gap-2 sm:ml-auto">
          <Button type="submit" size="sm">应用筛选</Button>
          <Button v-if="showReset" type="button" variant="ghost" size="sm" @click="reset">重置</Button>
        </div>
      </FieldGroup>
    </div>
    <DisclosurePanel
      v-model:open="advancedOpen"
      keep-mounted
      compact
      :heading-level="2"
      :title="advancedTitle"
      trigger-class="px-4"
      content-class="border-t p-4"
      class="bg-card overflow-hidden rounded-lg border"
    >
      <FieldGroup class="grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field v-for="key in ['from', 'to']" :key="key">
          <FieldLabel :for="`log-${key}`">{{ key === 'from' ? '开始时间' : '结束时间' }}（本地时间）</FieldLabel>
          <ComparisonDateTimePicker
            :id="`log-${key}`"
            :model-value="draft[key] ?? ''"
            :label="key === 'from' ? '开始时间' : '结束时间'"
            @update:model-value="draft[key] = $event"
          />
        </Field>
        <Field v-for="id in ids" :key="id.key">
          <FieldLabel :for="`log-${id.key}`">{{ id.label }}（精确匹配）</FieldLabel>
          <Input :id="`log-${id.key}`" v-model="draft[id.key]" maxlength="128" />
        </Field>
      </FieldGroup>
    </DisclosurePanel>
  </form>
</template>
