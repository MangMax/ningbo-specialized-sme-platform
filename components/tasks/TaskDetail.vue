<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import type { TaskSummary } from '~~/lib/task-center'
import { TASK_LABELS, TASK_STATES } from '~~/lib/task-center'
import { useTaskPolling } from '~/composables/useTaskPolling'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'

/**
 * 一条任务的详情。
 *
 * 首屏只回答业务问题：这是什么任务、现在到哪、结果能不能用、下一步做什么。
 * kind / 规则 / 快照 / dataVersion / SHA-256 / 原始编号收进“核对信息”折叠，
 * 保留可审计信息但不与业务结论同权。
 *
 * 操作只有一组，且只在任务真正支持时出现：取消依赖 `capabilities.cancel`
 * 且任务仍在排队/运行；重试依赖 `capabilities.retry`。导出下载/重新生成由页面
 * 通过 `actions` 插槽并入同一组，不另建第二套按钮。
 */
const props = defineProps<{
  id: string
  token: string
  /** 只读原因与进入授权的入口由页面决定（它拥有授权状态）。 */
  authorizationReason?: string
  dated?: (iso: string | null | undefined) => string
}>()
const emit = defineEmits<{ close: []; changed: []; 'request-authorization': [] }>()

const key = computed(() => props.id)
const headers = () => props.token ? { authorization: `Bearer ${props.token}` } : undefined
const { data, sourceKey, loading, failed, refresh: reload } = useTaskPolling(key, signal => $fetch<TaskSummary>(`/api/task-center/${encodeURIComponent(props.id)}`, { headers: headers(), signal }))
/** Event handlers and slot consumers get a plain void wrapper so Vue's handler
 *  typing stays simple; the polling promise is this component's business. */
function refresh() { void reload() }

const pending = ref(false)
const cancelRequested = ref(false)
const notice = ref('')
const showTechnical = ref(false)
const panel = useTemplateRef<HTMLElement>('panel')

// Reveal the detail once, when a person opens a task — never on a poll, never when
// the credential changes (authorizing from the page keeps the card mounted), and
// never by moving focus, so a person reading the page is not thrown around.
function reveal() {
  const element = panel.value
  if (!element) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  element.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
}

// A different task never inherits the previous task's notices; opening a task is
// also the only moment that scrolls it into view.
watch(key, () => {
  notice.value = ''; cancelRequested.value = false; showTechnical.value = false
  void nextTick(reveal)
}, { flush: 'post', immediate: true })

const displayKind = computed(() => {
  const kind = data.value?.kind
  if (!kind) return ''
  // Unknown kinds stay readable but must not pretend to be a known business type.
  return TASK_LABELS[kind] ?? `其他类型（${kind}）`
})
const inFlight = computed(() => !!data.value && (data.value.state === 'queued' || data.value.state === 'running'))
// `capabilities` is required by TaskSummary, but a partial/older payload must
// degrade to "no actions" rather than throw while rendering.
const capabilities = computed(() => data.value?.capabilities)
const canCancel = computed(() => !!capabilities.value?.cancel && inFlight.value && current.value)
const canRetry = computed(() => !!capabilities.value?.retry && !inFlight.value && current.value)
const readOnly = computed(() => !!props.authorizationReason)
const showActions = computed(() => canCancel.value || canRetry.value || readOnly.value)
const cancellationPendingLabel = computed(() => cancelRequested.value && inFlight.value)
const outcomeLabel = computed(() => {
  if (!data.value?.outcome) return null
  return data.value.kind === 'reconcile'
    ? { complete: '报告目标', partial: '待核实' }
    : { complete: '完整', partial: '部分' }
})
const itemStatus: Record<string, string> = { success: '查询成功', no_record: '完整查询无记录', auth_failed: '授权失败', failed: '查询失败', partial: '部分', not_queried: '未查询', complete: '完整' }
const current = computed(() => data.value?.id === props.id && sourceKey.value === key.value && !failed.value)
const links = computed(() => data.value?.links ?? [])
// The page renders export-specific content in the `content` slot; a payload
// without `export` must simply show nothing there.
const exportSummary = computed(() => data.value?.export ?? null)

function format(iso: string | null | undefined, empty: string) {
  if (!iso) return empty
  return props.dated?.(iso) ?? iso
}

async function act(action: 'cancel' | 'retry') {
  if (!data.value || !capabilities.value || !current.value || pending.value || !capabilities.value[action]) return
  pending.value = true; notice.value = ''
  try {
    const result = await $fetch<{ cancelRequested?: boolean }>(`/api/task-center/${props.id}/${action}`, { method: 'POST', headers: headers() })
    cancelRequested.value = !!result.cancelRequested
    notice.value = result.cancelRequested
      ? '已请求取消，等待服务端检查点；任务尚未进入取消终态。'
      : action === 'retry'
        ? '局部重试已受理；仅补查未完成项，已完成结果保留。'
        : '服务端已处理取消请求。'
    await reload(); emit('changed')
  } catch { notice.value = '操作未受理。请核对管理操作授权，或刷新后再试。' }
  finally { pending.value = false }
}
</script>

<template>
  <section ref="panel" tabindex="-1" aria-labelledby="task-detail-title" class="outline-none scroll-mt-4">
    <Card class="min-w-0 gap-0 py-0">
      <CardHeader class="flex flex-col gap-2">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="flex min-w-0 flex-col gap-1">
            <!-- 这张卡的标题就是它所在区块的 h2（页面 h1 → 列表 h2 / 详情 h2 → 折叠 h3）。 -->
            <CardTitle id="task-detail-title" as="h2">任务详情</CardTitle>
            <CardDescription v-if="data" class="flex flex-wrap items-center gap-2">
              <span class="text-foreground font-medium">{{ displayKind }}</span>
              <!-- The task's own name often restates its kind; show it only when it adds something. -->
              <template v-if="data.label && data.label !== displayKind">
                <span class="text-muted-foreground">·</span>
                <span>{{ data.label }}</span>
              </template>
              <Badge :variant="data.state === 'failed' ? 'destructive' : 'secondary'">{{ TASK_STATES[data.state] }}</Badge>
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" @click="emit('close')">关闭详情</Button>
        </div>
      </CardHeader>
      <CardContent class="flex min-w-0 flex-col gap-4">
        <TableFailureState v-if="failed" title="详情加载失败或任务不存在" :compact="!!data" :pending="loading" description="已保留请求的任务编号。可重试；旧详情不会用于当前任务的操作。" @retry="refresh" />
        <p v-else-if="loading && !data" role="status">正在读取任务详情…</p>

        <template v-if="data">
          <p v-if="!current" role="status" class="text-muted-foreground text-sm">正在读取最新详情，暂时显示上次结果。</p>

          <!-- 业务首屏：进度与下一步 -->
          <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <TaskProgress v-if="data.progress?.stage" :progress="data.progress" />
            <dl v-if="data.export?.counts" class="flex flex-wrap gap-x-6 gap-y-1 text-sm" aria-label="导出口径计数">
              <div class="flex flex-col"><dt class="text-muted-foreground text-xs">有效</dt><dd class="text-lg font-semibold tabular-nums">{{ data.export.counts.eligible }}</dd></div>
              <div class="flex flex-col"><dt class="text-muted-foreground text-xs">待确认</dt><dd class="text-lg font-semibold tabular-nums">{{ data.export.counts.pending }}</dd></div>
              <div class="flex flex-col"><dt class="text-muted-foreground text-xs">排除</dt><dd class="text-lg font-semibold tabular-nums">{{ data.export.counts.excluded }}</dd></div>
            </dl>
          </div>

          <Alert v-if="data.error" variant="destructive"><AlertTitle>任务错误</AlertTitle><AlertDescription>{{ data.error }}</AlertDescription></Alert>

          <template v-if="data.outcome">
            <p class="text-sm" data-testid="task-outcome">
              {{ outcomeLabel?.complete }} {{ data.outcome.complete }} · {{ outcomeLabel?.partial }} {{ data.outcome.partial }} ·
              查询失败 {{ data.outcome.failed }} · 未查询 {{ data.outcome.notQueried }} · 未完成范围 {{ data.outcome.unfinished }}
            </p>
            <p v-if="data.kind === 'platform-query-batch'" class="text-muted-foreground text-sm">
              以上是平台取回的<b>完整性</b>（执行 {{ data.outcome.attempt }} / 10 次），不是业务判断结论；取回事实仅保存在任务结果中，不代表正式入库。
            </p>
            <p v-else class="text-muted-foreground text-sm">查询完整性与核查结论分开核对；任务完成不代表所有差异已有业务结论。</p>
          </template>

          <ul v-if="data.items?.length" class="flex flex-col gap-3 text-sm" aria-label="平台逐项范围">
            <li v-for="item in data.items" :key="item.id" class="flex flex-col gap-1">
              <span class="break-all font-mono text-xs">{{ item.id }}</span>
              <span>{{ itemStatus[item.status] ?? item.status }} · 完整性：{{ itemStatus[item.completeness] ?? item.completeness }}</span>
              <span v-for="(position, index) in item.positions" :key="index" class="text-muted-foreground">未完成：{{ position.source }} / {{ position.rdjb ?? '全部称号' }} / 第 {{ position.page }} 页</span>
            </li>
          </ul>

          <!-- 业务动作 + 页面插槽（导出产物）：同一组，只出现一次 -->
          <div v-if="showActions || $slots.actions" class="flex flex-col gap-3" data-testid="task-actions">
            <div class="flex flex-wrap items-center gap-2">
              <template v-if="canCancel">
                <Button variant="outline" :disabled="pending || cancellationPendingLabel" @click="act('cancel')">
                  {{ cancellationPendingLabel ? '已请求取消' : '请求取消' }}
                </Button>
              </template>
              <Button v-if="canRetry" variant="outline" :disabled="pending" @click="act('retry')">重试未完成项</Button>
              <slot name="actions" :task="data" :current="current" :refresh="refresh" />
            </div>
            <p v-if="readOnly" class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              只读：{{ authorizationReason }}
              <Button variant="link" size="sm" class="h-auto px-0" data-testid="go-authorize" @click="emit('request-authorization')">进入授权</Button>
            </p>
            <p v-else-if="data.capabilities?.reason" class="text-muted-foreground text-sm">{{ data.capabilities.reason }}</p>
          </div>

          <p v-if="notice" role="status" class="text-sm">{{ notice }}</p>

          <div v-if="links.length" class="flex flex-wrap gap-3">
            <NuxtLink v-for="link in links" :key="link.to" :to="link.to" class="text-primary text-sm underline underline-offset-4">{{ link.label }}</NuxtLink>
          </div>

          <Separator />
          <DisclosurePanel v-model:open="showTechnical">
            <template #trigger><span class="text-sm">核对信息</span></template>
            <dl class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt class="text-muted-foreground">类型</dt><dd class="break-all">{{ displayKind }}</dd>
              <dt class="text-muted-foreground">任务编号</dt><dd class="break-all font-mono text-xs">{{ data.id }}</dd>
              <dt class="text-muted-foreground">创建</dt><dd><time :datetime="data.createdAt">{{ format(data.createdAt, '未记录') }}</time></dd>
              <dt class="text-muted-foreground">开始</dt><dd><time v-if="data.startedAt" :datetime="data.startedAt">{{ format(data.startedAt, '') }}</time><template v-else>尚未开始</template></dd>
              <dt class="text-muted-foreground">结束</dt><dd><time v-if="data.finishedAt" :datetime="data.finishedAt">{{ format(data.finishedAt, '') }}</time><template v-else>尚未结束</template></dd>
              <template v-if="data.export">
                <dt class="text-muted-foreground">生成时间</dt><dd>{{ format(data.export.generatedAt, '尚未生成') }}</dd>
                <dt class="text-muted-foreground">快照边界</dt><dd>{{ format(data.export.snapshotStartedAt, '尚未固定') }}</dd>
                <dt class="text-muted-foreground">规则版本</dt><dd class="break-all">{{ data.export.ruleVersion ?? '尚未记录' }}</dd>
                <template v-if="data.export.dataVersion"><dt class="text-muted-foreground">数据版本</dt><dd class="break-all font-mono text-xs">{{ data.export.dataVersion }}</dd></template>
                <template v-if="data.export.artifact"><dt class="text-muted-foreground">SHA-256</dt><dd class="break-all font-mono text-xs">{{ data.export.artifact.sha256 }}</dd></template>
                <template v-if="data.export.regenerateOf"><dt class="text-muted-foreground">重新生成自</dt><dd class="break-all"><NuxtLink :to="{ path: '/tasks', query: { tab: 'export', job: data.export.regenerateOf } }" class="text-primary underline">{{ data.export.regenerateOf }}</NuxtLink></dd></template>
              </template>
            </dl>
          </DisclosurePanel>
          <slot v-if="$slots.content" name="content" :task="data" :export-summary="exportSummary" :current="current" :refresh="refresh" />
          <div class="flex flex-wrap gap-2"><Button variant="outline" :disabled="loading" @click="refresh">刷新详情</Button></div>
        </template>
        <div v-else class="flex flex-wrap gap-2"><Button variant="outline" :disabled="loading" @click="refresh">刷新详情</Button></div>
      </CardContent>
    </Card>
  </section>
</template>
