<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { LogFilter, LogPolicy } from '~~/lib/logging/contract'
import {
  logBrowserHeaders,
  logErrorCode,
  logErrorMessage,
  useLogRead
} from '~/composables/useLogRead'
import TableFailureState from '@/components/TableFailureState.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableRow, TableCell } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'

type PolicyView = LogPolicy & {
  storageBytes: number
  pruned: number
  cleared: number
  accounting: string
  status: {
    dropped: number
    unavailable: boolean
    since: string
    queuedEntries: number
    inFlightEntries: number
    lastError: string | null
  }
}
const props = defineProps<{ filter: LogFilter }>()
const emit = defineEmits<{ changed: [] }>()
const filterLabels: Record<string, string> = {
  from: '开始时间', to: '结束时间', level: '级别', source: '来源', outcome: '结果',
  operation: '操作', requestId: '请求标识', traceId: '链路标识', taskId: '任务标识',
  fileId: '文件编号', batchId: '批次标识', resourceId: '资源标识',
}
const { data, loading, error, refresh } = useLogRead(ref('policy'), () =>
  $fetch<PolicyView>('/api/logs/policy', { retry: 0, headers: logBrowserHeaders })
)
const days = ref(7),
  bytes = ref(536870912),
  initialized = ref(false)
// Draft initialization happens once; refreshing after 409 must preserve the requested values.
watch(data, (value) => {
  if (value && !initialized.value) {
    days.value = value.retentionDays
    bytes.value = value.maxBytes
    initialized.value = true
  }
})
const pending = ref(false),
  notice = ref(''),
  failure = ref('')
type Review =
  | { kind: 'policy'; policy: LogPolicy }
  | { kind: 'clear'; filter: LogFilter & { from: string; to: string } }
const review = ref<Review | null>(null)
const validPolicy = computed(
  () =>
    Number.isInteger(days.value) &&
    days.value >= 1 &&
    days.value <= 365 &&
    Number.isInteger(bytes.value) &&
    bytes.value >= 1048576 &&
    bytes.value <= 4294967296
)
const clearAllowed = computed(
  () =>
    !!props.filter.from &&
    !!props.filter.to &&
    !Number.isNaN(Date.parse(props.filter.from)) &&
    !Number.isNaN(Date.parse(props.filter.to)) &&
    Date.parse(props.filter.from) <= Date.parse(props.filter.to)
)
function reviewPolicy() {
  if (validPolicy.value && !pending.value && data.value && !error.value)
    review.value = { kind: 'policy', policy: { retentionDays: days.value, maxBytes: bytes.value } }
}
function reviewClear() {
  if (!clearAllowed.value || pending.value || !data.value || error.value) return
  const { cursor: _cursor, limit: _limit, ...filter } = props.filter
  review.value = { kind: 'clear', filter: { ...filter, from: filter.from!, to: filter.to! } }
}
let active = true
onBeforeUnmount(() => {
  active = false
})
async function confirm() {
  if (!review.value || pending.value) return
  const target = review.value
  pending.value = true
  notice.value = ''
  failure.value = ''
  try {
    if (target.kind === 'policy') {
      await $fetch('/api/logs/policy', {
        method: 'PATCH',
        retry: 0,
        headers: logBrowserHeaders,
        body: target.policy
      })
      if (active) notice.value = '日志保留策略已修改。'
    } else {
      const result = await $fetch<{ deleted: number; hasMore: boolean }>('/api/logs/clear', {
        method: 'POST',
        retry: 0,
        headers: logBrowserHeaders,
        body: { ...target.filter, confirm: true }
      })
      if (active)
        notice.value = `已确认范围 ${target.filter.from} 至 ${target.filter.to}，筛选 ${JSON.stringify(target.filter)}。本次已清理 ${result.deleted} 条运行日志。${result.hasMore ? '范围内仍有日志；核对后可再次确认清理。' : '本次范围清理已完成。'}业务审计、回执和源文件不受影响。`
    }
    if (active) emit('changed')
  } catch (cause) {
    if (active) failure.value = logErrorMessage(logErrorCode(cause))
  } finally {
    if (active) {
      pending.value = false
      review.value = null
      void refresh()
    }
  }
}
</script>
<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader>
    <CardTitle id="log-management-heading">保留与清理</CardTitle>
    <CardDescription>
      仅管理运行日志，不修改业务审计、导入回执、源文件或任务产物。
    </CardDescription>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-4">
    <Skeleton v-if="loading && !data" class="h-24 w-full" aria-label="正在读取日志策略" />
    <TableFailureState
      v-if="error"
      title="日志策略读取失败"
      :description="`${logErrorMessage(error)} ${data ? '保留上次读取的策略；当前状态需重新加载确认。' : ''}`"
      :pending="loading"
      @retry="refresh"
    />
    <template v-if="data">
      <Table class="data-table"><TableBody>
        <TableRow><TableCell class="text-muted-foreground">当前策略</TableCell><TableCell class="whitespace-normal">{{ data.retentionDays }} 天 / {{ data.maxBytes }} 字节</TableCell></TableRow>
        <TableRow><TableCell class="text-muted-foreground">存储用量</TableCell><TableCell>{{ data.storageBytes }} 字节</TableCell></TableRow>
        <TableRow><TableCell class="text-muted-foreground">累计清理</TableCell><TableCell class="whitespace-normal">策略裁剪 {{ data.pruned }} 条 / 手动清理 {{ data.cleared }} 条</TableCell></TableRow>
        <TableRow><TableCell class="text-muted-foreground">进程状态</TableCell><TableCell class="whitespace-normal">{{ data.status.unavailable ? '不可用' : '可用' }}；已丢弃 {{ data.status.dropped }} 条；排队 {{ data.status.queuedEntries }} 条；写入中 {{ data.status.inFlightEntries }} 条</TableCell></TableRow>
      </TableBody></Table>

      <p class="text-muted-foreground break-words text-sm">
        用量包含日志库与日志库附属文件，不含文件系统分配开销、容器输出或其他进程内存。进程计数从
        {{ data.status.since }} 起。
      </p>
      <form @submit.prevent="reviewPolicy">
        <FieldGroup class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <Field :data-disabled="pending">
            <FieldLabel for="log-retention-days">保留天数（1–365）</FieldLabel
            ><Input
              id="log-retention-days"
              v-model.number="days"
              type="number"
              min="1"
              max="365"
              required
              :disabled="pending"
            />
          </Field>
          <Field :data-disabled="pending">
            <FieldLabel for="log-max-bytes">容量字节（1 MiB–4 GiB）</FieldLabel
            ><Input
              id="log-max-bytes"
              v-model.number="bytes"
              type="number"
              min="1048576"
              max="4294967296"
              required
              :disabled="pending"
            />
          </Field>
          <Button
            type="submit"
            variant="outline" class="sm:col-span-2 sm:justify-self-start"
            :disabled="pending || loading || !!error || !validPolicy"
            >核对策略修改</Button
          >
        </FieldGroup>
      </form>
      <p class="text-muted-foreground text-sm">
        保留期与容量取更严格者。缩短保留期或降低容量可能清理已有运行日志。
      </p>
      <div class="flex flex-col items-start gap-2">
        <Button
          variant="destructive"
          :disabled="pending || loading || !!error || !clearAllowed"
          @click="reviewClear"
          >清理当前筛选范围</Button
        >
        <p class="text-muted-foreground text-sm">
          请先在筛选中应用明确的开始和结束时间。每次最多清理 1000 条；所有已应用的筛选同时生效。
        </p>
      </div>
    </template>
    <Alert v-if="notice || failure" :variant="failure ? 'destructive' : 'default'" role="status"
      ><AlertDescription>{{ failure || notice }}</AlertDescription></Alert
    >
    <Dialog
      :open="!!review"
      @update:open="
        (value) => {
          if (!value && !pending) review = null
        }
      "
    >
      <DialogContent
        class="max-h-[90dvh] overflow-y-auto"
        @interact-outside="pending && $event.preventDefault()"
        @escape-key-down="pending && $event.preventDefault()"
      >
        <DialogHeader
          ><DialogTitle>{{
            review?.kind === 'policy' ? '确认修改日志保留策略' : '确认清理运行日志'
          }}</DialogTitle
          ><DialogDescription
            >此操作可能永久删除运行日志。业务审计、回执、源文件和任务产物不在清理范围。</DialogDescription
          ></DialogHeader
        >
        <template v-if="review?.kind === 'policy'"
          ><p class="text-sm">当前：{{ data?.retentionDays }} 天 / {{ data?.maxBytes }} 字节</p>
          <p class="text-sm">
            修改为：{{ review.policy.retentionDays }} 天 / {{ review.policy.maxBytes }} 字节
          </p></template
        >
        <template v-else-if="review?.kind === 'clear'"
          ><p class="text-sm">清理以下已固定范围，每次最多 1000 条：</p>
          <Table><TableBody><TableRow v-for="(value, key) in review.filter" :key="key">
            <TableCell class="text-muted-foreground">{{ filterLabels[key] ?? key }}</TableCell>
            <TableCell class="break-all">{{ value }}</TableCell>
          </TableRow></TableBody></Table>
        </template>
        <DialogFooter
          ><Button variant="outline" :disabled="pending" @click="review = null">取消</Button
          ><Button variant="destructive" :disabled="pending" @click="confirm">{{
            pending ? '正在提交…' : review?.kind === 'policy' ? '确认修改策略' : '确认清理范围'
          }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>
    </CardContent>
  </Card>
</template>
