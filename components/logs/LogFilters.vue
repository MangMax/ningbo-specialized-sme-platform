<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { LOG_LEVELS, LOG_OUTCOMES, LOG_SOURCES, type LogFilter } from '~~/lib/logging/contract'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
const props = defineProps<{ filter: LogFilter }>()
const emit = defineEmits<{ apply: [value: Record<string, string>] }>()
const draft = reactive<Record<string, string>>({})
const identifiersOpen = ref(false)
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
    if (ids.some((i) => !!filter[i.key as keyof LogFilter])) identifiersOpen.value = true
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
</script>
<template>
  <form class="flex min-w-0 flex-col gap-3" aria-label="日志筛选" @submit.prevent="apply">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <div v-for="key in ['from', 'to']" :key="key" class="flex min-w-0 flex-col gap-2">
        <Label :for="`log-${key}`">{{ key === 'from' ? '开始时间' : '结束时间' }}（本地时间）</Label
        ><Input
          :id="`log-${key}`"
          v-model="draft[key]"
          type="datetime-local"
          step="1"
          class="min-w-0 w-full"
        />
      </div>
      <div v-for="choice in choices" :key="choice.key" class="flex min-w-0 flex-col gap-2">
        <Label :for="`log-${choice.key}`">{{ choice.label }}</Label
        ><Select v-model="draft[choice.key]"
          ><SelectTrigger :id="`log-${choice.key}`" class="w-full"><SelectValue /></SelectTrigger
          ><SelectContent
            ><SelectGroup
              ><SelectItem value="all">全部{{ choice.label }}</SelectItem
              ><SelectItem v-for="value in choice.values" :key="value" :value="value">{{
                value
              }}</SelectItem></SelectGroup
            ></SelectContent
          ></Select
        >
      </div>
      <div class="flex min-w-0 flex-col gap-2">
        <Label for="log-operation">操作（精确匹配）</Label
        ><Input
          id="log-operation"
          v-model="draft.operation"
          maxlength="96"
          placeholder="如 task.finished"
        />
      </div>
    </div>
    <DisclosurePanel v-model:open="identifiersOpen" :heading-level="2">
      <template #trigger><span class="text-sm">关联标识筛选</span></template>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div v-for="id in ids" :key="id.key" class="flex min-w-0 flex-col gap-2">
          <Label :for="`log-${id.key}`">{{ id.label }}（精确匹配）</Label
          ><Input :id="`log-${id.key}`" v-model="draft[id.key]" maxlength="128" />
        </div>
      </div>
    </DisclosurePanel>
    <div class="flex flex-wrap gap-2">
      <Button type="submit">应用筛选</Button
      ><Button type="button" variant="outline" @click="emit('apply', {})">重置筛选</Button>
    </div>
  </form>
</template>
