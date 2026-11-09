<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import TablePagination from '@/components/TablePagination.vue'
import { Textarea } from '@/components/ui/textarea'
const props = defineProps<{ fileId: number }>()
const emit = defineEmits<{ synced: [] }>()
const open = ref(false),
  enabled = ref(false),
  busy = ref(false),
  basis = ref(''),
  failure = ref('')
type Request = { idempotencyKey: string; basis: string }
type Plan = {
  planHash: string
  chunks: number
  completed: number[]
  counts: {
    updated: number
    unchanged: number
    conflicts: number
    failed: number
    unexecuted: number
  }
  rows: {
    eventId: number
    enterpriseId: number
    enterpriseName: string
    status: string
    reason: string
    before: { year: number | null; batchSeq: number | null }
    after: { year: number | null; batchSeq: number | null }
  }[]
}
const plan = ref<Plan | null>(null),
  request = ref<Request | null>(null)
const page = ref(1),
  pageSize = ref(50)
const visibleRows = computed(
  () =>
    plan.value?.rows.slice((page.value - 1) * pageSize.value, page.value * pageSize.value) ?? [],
)
watch(open, async (value) => {
  if (!value) return
  failure.value = ''
  try {
    enabled.value = (
      await $fetch<{ writeEnabled: boolean }>('/api/roster/evidence-review/browser-context')
    ).writeEnabled
  } catch {
    enabled.value = false
  }
})
watch(basis, () => {
  plan.value = null
  request.value = null
})
function message(e: unknown) {
  const error = e as { data?: { error?: { message?: string } } }
  return error.data?.error?.message ?? '请求结果未确认，请保留原请求重试。'
}
async function preflight() {
  busy.value = true
  failure.value = ''
  request.value ??= { idempotencyKey: crypto.randomUUID(), basis: basis.value }
  try {
    plan.value = await $fetch<Plan>(`/api/files/${props.fileId}/event-sync/browser-preflight`, {
      method: 'POST',
      body: request.value,
    })
  } catch (e) {
    failure.value = message(e)
  } finally {
    busy.value = false
  }
}
async function commit() {
  if (!plan.value || !request.value) return
  busy.value = true
  failure.value = ''
  try {
    while (plan.value.completed.length < plan.value.chunks) {
      plan.value = await $fetch<Plan>(`/api/files/${props.fileId}/event-sync/browser-commit`, {
        method: 'POST',
        body: {
          request: request.value,
          planHash: plan.value.planHash,
          chunk: plan.value.completed.length,
        },
      })
      emit('synced')
    }
  } catch (e) {
    failure.value = message(e)
  } finally {
    busy.value = false
  }
}
function reset() {
  page.value = 1
  plan.value = null
  request.value = null
  failure.value = ''
}
</script>
<template>
  <Button variant="ghost" size="sm" @click="open = true">同步到企业</Button>
  <Sheet v-model:open="open">
    <SheetContent floating-size="detail" class="flex flex-col">
      <SheetHeader
        ><SheetTitle>同步到企业</SheetTitle
        ><SheetDescription
          >按已保存的分段物理页范围，仅补正式事件未知年份、批次。复核年份是原认定年。</SheetDescription
        ></SheetHeader
      >
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <p v-if="!enabled">当前为只读，未开放页面提交。</p>
        <label class="block"
          >核实依据<Textarea
            v-model="basis"
            :disabled="busy"
            placeholder="说明已核实的分段、附件及物理页"
        /></label>
        <p v-if="failure" role="alert">{{ failure }}</p>
        <template v-if="plan">
          <p aria-live="polite">
            已更新 {{ plan.counts.updated }}；无需更改 {{ plan.counts.unchanged }}；待核/冲突
            {{ plan.counts.conflicts }}；失败 {{ plan.counts.failed }}；未执行
            {{ plan.counts.unexecuted }}
          </p>
          <p v-if="plan.counts.unexecuted === 0">
            本计划无剩余可更新项。待核项仍须核实；请重新读取企业名单、详情及导出。
          </p>
          <p v-else>确认后按每块100条顺序执行。中断会保留已完成块，可重试继续。</p>
          <ul class="space-y-3">
            <li v-for="row in visibleRows" :key="row.eventId" class="break-words border-b pb-3">
              <a :href="`/enterprises/${row.enterpriseId}`">{{ row.enterpriseName }}</a>
              · 事件 {{ row.eventId }}
              <p>
                {{ row.before.year ?? '年份待核' }} / {{ row.before.batchSeq ?? '批次待核' }} →
                {{ row.after.year ?? '年份待核' }} /
                {{ row.after.batchSeq ?? '批次待核' }}
              </p>
              <p>{{ row.reason }}</p>
            </li>
          </ul>
          <TablePagination
            :page="page"
            :page-size="pageSize"
            :total="plan.rows.length"
            :loading="busy"
            unit="个事件"
            @update:page="page = $event"
            @update:page-size="
              pageSize = $event
              page = 1
            "
          />
        </template>
      </div>
      <div class="flex flex-wrap gap-2 border-t p-4">
        <Button :disabled="!enabled || busy || !basis.trim()" @click="preflight">{{
          busy ? '处理中…' : '预检 / 重试预检'
        }}</Button>
        <Button
          v-if="plan && plan.counts.unexecuted > 0"
          :disabled="!enabled || busy"
          @click="commit"
          >确认同步 / 继续</Button
        >
        <Button variant="outline" :disabled="busy" @click="reset">重新预检新计划</Button>
      </div>
    </SheetContent>
  </Sheet>
</template>
