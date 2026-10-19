<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { TaskSummary } from '~~/lib/task-center'
import { TASK_STATES } from '~~/lib/task-center'
import { useTaskPolling } from '~/composables/useTaskPolling'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
const props = defineProps<{ id: string; token: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const key = computed(() => props.id)
const headers = () => props.token ? { authorization: `Bearer ${props.token}` } : undefined
const { data, sourceKey, loading, failed, refresh } = useTaskPolling(key, signal => $fetch<TaskSummary>(`/api/task-center/${encodeURIComponent(props.id)}`, { headers: headers(), signal }))
const pending = ref(false)
const cancelRequested = ref(false)
const notice = ref('')
const panel = ref<HTMLElement | null>(null)
onMounted(() => panel.value?.focus())
const itemStatus: Record<string, string> = { success: '查询成功', no_record: '完整查询无记录', auth_failed: '授权失败', failed: '查询失败', partial: '部分', not_queried: '未查询', complete: '完整' }
const current = computed(() => data.value?.id === props.id && sourceKey.value === key.value && !failed.value)
async function act(action: 'cancel' | 'retry') {
  if (!data.value || !current.value || pending.value || !data.value.capabilities[action]) return
  pending.value = true; notice.value = ''
  try {
    const result = await $fetch<{ cancelRequested?: boolean }>(`/api/task-center/${props.id}/${action}`, { method: 'POST', headers: headers() })
    cancelRequested.value = !!result.cancelRequested
    notice.value = result.cancelRequested ? '已请求取消，等待服务端检查点；任务尚未进入取消终态。' : action === 'retry' ? '局部重试已受理；仅补查未完成项。' : '服务端已处理取消请求。'
    await refresh(); emit('changed')
  } catch { notice.value = '操作未确认受理，请刷新状态后再试。请核对 API 授权及任务当前能力。' }
  finally { pending.value = false }
}
</script>
<template>
  <section ref="panel" tabindex="-1" aria-label="任务详情" class="outline-none">
  <Card class="min-w-0 gap-4">
    <CardHeader>
      <CardTitle>任务详情</CardTitle>
      <CardDescription class="break-all font-mono">{{ id }}</CardDescription>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-4">
      <TableFailureState v-if="failed" title="详情加载失败或任务不存在" :compact="!!data" :pending="loading" description="已保留请求的任务编号。可重试，旧详情不会用于当前任务的操作。" @retry="refresh" />
      <p v-else-if="loading && !data" role="status">正在读取任务详情…</p>
      <template v-if="data">
        <p v-if="!current" class="text-muted-foreground text-sm">上次读取的详情：{{ data.id }}</p>
        <div class="flex flex-wrap items-center gap-2"><strong>{{ data.label }}</strong><Badge :variant="data.state === 'failed' ? 'destructive' : 'secondary'">{{ TASK_STATES[data.state] }}</Badge></div>
        <TaskProgress :progress="data.progress" />
        <dl class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <dt class="text-muted-foreground">类型</dt><dd class="break-all">{{ data.kind }}</dd>
          <dt class="text-muted-foreground">创建</dt><dd class="break-all">{{ data.createdAt }}</dd>
          <dt class="text-muted-foreground">开始</dt><dd class="break-all">{{ data.startedAt ?? '尚未开始' }}</dd>
          <dt class="text-muted-foreground">结束</dt><dd class="break-all">{{ data.finishedAt ?? '尚未结束' }}</dd>
        </dl>
        <Alert v-if="data.error" variant="destructive"><AlertTitle>任务错误</AlertTitle><AlertDescription>{{ data.error }}</AlertDescription></Alert>
        <template v-if="data.outcome">
          <p class="text-sm">{{ data.kind === 'reconcile' ? '报告目标' : '完整' }} {{ data.outcome.complete }} · {{ data.kind === 'reconcile' ? '待核实' : '部分' }} {{ data.outcome.partial }} · 查询失败 {{ data.outcome.failed }} · 未查询 {{ data.outcome.notQueried }} · 未完成范围 {{ data.outcome.unfinished }}</p>
          <p v-if="data.kind === 'platform-query-batch'" class="text-muted-foreground text-sm">执行 {{ data.outcome.attempt }} / 10 次。平台取回事实仅保存在任务结果中，不代表正式入库或业务判断完成。</p>
          <p v-else class="text-muted-foreground text-sm">核查状态与查询完整性分别核对；任务完成不代表所有差异已有业务结论。</p>
        </template>
        <ul v-if="data.items?.length" class="flex flex-col gap-3 text-sm" aria-label="平台逐项范围">
          <li v-for="item in data.items" :key="item.id" class="flex flex-col gap-1">
            <span class="break-all font-mono text-xs">{{ item.id }}</span>
            <span>{{ itemStatus[item.status] ?? item.status }} · {{ itemStatus[item.completeness] ?? item.completeness }}</span>
            <span v-for="(position, index) in item.positions" :key="index" class="text-muted-foreground">未完成：{{ position.source }} / {{ position.rdjb ?? '全部称号' }} / 第 {{ position.page }} 页</span>
          </li>
        </ul>
        <p class="text-muted-foreground text-sm">{{ data.capabilities.reason }}</p>
        <slot :task="data" :current="current" :refresh="refresh" />
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" :disabled="!current || pending || !data.capabilities.cancel || (cancelRequested && ['queued','running'].includes(data.state))" @click="act('cancel')">{{ cancelRequested && ['queued','running'].includes(data.state) ? '已请求取消' : '请求取消' }}</Button>
          <Button variant="outline" :disabled="!current || pending || !data.capabilities.retry" @click="act('retry')">重试未完成项</Button>
        </div>
        <p v-if="notice" role="status" class="text-sm">{{ notice }}</p>
        <div class="flex flex-wrap gap-3"><NuxtLink v-for="link in data.links" :key="link.to" :to="link.to" class="text-primary text-sm underline underline-offset-4">{{ link.label }}</NuxtLink></div>
      </template>
      <div class="flex flex-wrap gap-2"><Button variant="outline" :disabled="loading" @click="refresh">刷新详情</Button><Button variant="ghost" @click="emit('close')">关闭详情</Button></div>
    </CardContent>
  </Card>
  </section>
</template>
