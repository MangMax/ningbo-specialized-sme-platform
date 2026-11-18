<!--
  LogFilters —— 快速筛选与高级筛选在同一个 Card 表面里。

  页面把本组件放进唯一一张筛选卡：顶部一行是级别/来源/模块/结果/操作与提交动作，
  下方是「更多筛选」折叠区，二者共用这张卡的底色和边框，不再出现“裸工具条 +
  独立白卡”两个表面。

  桌面（≥sm）：字段与动作同一行，折叠区跨两列在下一行；
  窄屏：字段 → 折叠区 → 动作。应用筛选只渲染一次，窄屏时排在折叠面板之后，
  填完最后一个字段就能直接提交，不需要滚回顶部。

  提交边界只有一个：所有字段一起在「应用筛选」或回车时生效。清理范围读的是已应用的
  filter，不是草稿，所以草稿改动不会改变清理范围。
-->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { LOG_LEVELS, LOG_OUTCOMES, LOG_SOURCES, type LogFilter } from '#core/lib/logging/contract'
import { sourceLabel, outcomeLabel, logModuleLabel, logModuleOptions } from './logPresentation'
import { Button } from '#core/app/components/ui/button'
import { Separator } from '#core/app/components/ui/separator'
import { Input } from '#core/app/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '#core/app/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '#core/app/components/ui/select'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
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
  { key: 'module', label: '模块', values: logModuleOptions },
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
const choiceLabel = (key: string, value: string) =>
  key === 'source' ? sourceLabel(value) : key === 'outcome' ? outcomeLabel(value) : key === 'module' ? logModuleLabel(value) : value
/** 收起时也认得出每个下拉管的是哪一类；选中后把类别带在值前面。 */
const summary = (choice: (typeof choices)[number]) =>
  draft[choice.key] && draft[choice.key] !== ':all'
    ? `${choice.label} · ${choiceLabel(choice.key, draft[choice.key]!)}`
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
      draft[choice.key] = String(filter[choice.key as keyof LogFilter] ?? ':all')
    draft.from = localTime(filter.from)
    draft.to = localTime(filter.to)
    if (filter.from || filter.to || ids.some((i) => !!filter[i.key as keyof LogFilter])) advancedOpen.value = true
  },
  { immediate: true }
)
function apply() {
  const value: Record<string, string> = {}
  for (const key of ['operation', ...ids.map((i) => i.key), ...choices.map((i) => i.key)])
    if (draft[key] && draft[key] !== ':all') value[key] = draft[key]!.trim()
  for (const key of ['from', 'to']) if (draft[key]) value[key] = new Date(draft[key]!).toISOString()
  emit('apply', value)
}
function reset() {
  for (const key of ['operation', ...ids.map((i) => i.key)]) draft[key] = ''
  for (const choice of choices) draft[choice.key] = ':all'
  draft.from = ''
  draft.to = ''
  advancedOpen.value = false
  emit('apply', {})
}
</script>
<template>
  <form
    class="grid min-w-0 grid-cols-1 items-center gap-x-2 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]"
    aria-label="日志筛选"
    @submit.prevent="apply"
  >
    <FieldGroup
      class="order-1 flex min-w-0 flex-row flex-wrap items-center gap-2 sm:col-start-1 sm:row-start-1"
    >
      <Field
        v-for="choice in choices"
        :key="choice.key"
        orientation="horizontal"
        class="shrink-0"
        :class="choice.key === 'module' ? 'w-36 sm:w-40' : 'w-28 sm:w-32'"
      >
        <FieldLabel :for="`log-${choice.key}`" class="sr-only">{{ choice.label }}</FieldLabel>
        <Select v-model="draft[choice.key]">
          <SelectTrigger
            :id="`log-${choice.key}`"
            size="sm"
            class="bg-card w-full shadow-none data-[active=true]:border-primary/45 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
            :data-active="!!draft[choice.key] && draft[choice.key] !== ':all'"
          >
            <SelectValue>{{ summary(choice) }}</SelectValue>
          </SelectTrigger>
          <SelectContent><SelectGroup>
            <SelectItem value=":all">全部{{ choice.label }}</SelectItem>
            <SelectItem v-for="value in choice.values" :key="value" :value="value">{{ choiceLabel(choice.key, value) }}</SelectItem>
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
    </FieldGroup>
    <!-- 单一主操作：窄屏排在折叠面板之后（填完即可提交），桌面与字段同行。 -->
    <div
      class="order-3 flex w-full shrink-0 items-center gap-2 sm:col-start-2 sm:row-start-1 sm:w-auto"
    >
      <Button type="submit" size="sm" class="max-sm:flex-1">应用筛选</Button>
      <Button v-if="showReset" type="button" variant="ghost" size="sm" @click="reset">重置</Button>
    </div>
    <DisclosurePanel
      v-model:open="advancedOpen"
      keep-mounted
      compact
      :heading-level="2"
      :title="advancedTitle"
      trigger-class="px-0 py-2"
      content-class="pt-1 pb-0"
      class="order-2 min-w-0 border-t pt-2 sm:col-span-2 sm:row-start-2"
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
