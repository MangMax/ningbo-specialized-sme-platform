<script setup lang="ts">
import { clientRequestReference } from '~~/lib/client-logging/request-reference'
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { TaskSummary } from '~~/lib/task-center'
import { TASK_LABELS, TASK_STATES } from '~~/lib/task-center'
import { useTaskPolling } from '~/composables/useTaskPolling'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardDescription, CardContent } from '@/components/ui/card'
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
  dated?: (iso: string | null | undefined) => string
}>()
const router = useRouter()
const emit = defineEmits<{ close: []; changed: [] }>()

const { $clientErrors } = useNuxtApp()
const key = computed(() => props.id)
const headers = { 'x-task-center-browser': '1' }
const { data, sourceKey, loading, failed, refresh: reload } = useTaskPolling(key, signal => $fetch<TaskSummary>(`/api/task-center/${encodeURIComponent(props.id)}`, { headers, signal }))
/** Event handlers and slot consumers get a plain void wrapper so Vue's handler
 *  typing stays simple; the polling promise is this component's business. */
function refresh() { void reload() }

const pending = ref(false)
const cancelRequested = ref(false)
const notice = ref('')
const showTechnical = ref(false)
const snapshotSection = ref<HTMLElement | null>(null)
async function revealResult(to: string) {
  if (!to.endsWith('#snapshot-result')) return
  await nextTick()
  snapshotSection.value?.scrollIntoView({ block: 'start' })
  snapshotSection.value?.focus({ preventScroll: true })
}

// A cancel request is only a request: only the server can say whether the task
// reached the cancelled terminal state. The card's report therefore follows the
// state the server last reported, instead of repeating the moment the request
// was accepted — so it cannot keep saying "not yet cancelled" after the task is
// cancelled, and it cannot claim a cancellation when the task finished first.
const cancelReport = computed(() => {
  if (!cancelRequested.value) return ''
  const state = data.value?.state
  if (state === 'cancelled') return '已取消：任务已进入取消终态。'
  if (state === 'done' || state === 'failed') return `取消请求未在检查点前生效：任务已${TASK_STATES[state]}。`
  return '已请求取消，等待服务端检查点；任务尚未进入取消终态。'
})

watch(key, () => { notice.value = ''; cancelRequested.value = false; showTechnical.value = false })

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
const showActions = computed(() => canCancel.value || canRetry.value)
const cancellationPendingLabel = computed(() => cancelRequested.value && inFlight.value)
const reconcileCollection = computed(() => data.value?.kind === 'reconcile' ? data.value.reconcileCollection : undefined)
const itemStatus: Record<string, string> = { success: '查询成功', no_record: '完整查询无记录', auth_failed: '授权失败', failed: '查询失败', partial: '部分', not_queried: '未查询', complete: '完整' }
const current = computed(() => data.value?.id === props.id && sourceKey.value === key.value && !failed.value)
const links = computed(() => (data.value?.links ?? []).filter(link => !data.value?.discovery || !link.to.startsWith('/enterprises/')))
// The page renders export-specific content in the `content` slot; a payload
// without `export` must simply show nothing there.
const exportSummary = computed(() => data.value?.export ?? null)

function format(iso: string | null | undefined, empty: string) {
  if (!iso) return empty
  return props.dated?.(iso) ?? iso
}

async function continueDiscovery() {
  const scope=data.value?.discovery
  if(!current.value||pending.value||!scope?.titleCode||!scope.nextAfterEventId)return
  pending.value=true;notice.value=''
  try {
    const receipt=await $fetch<{jobId:string}>('/api/roster/correspondences/tasks',{method:'POST',headers,body:{titleCode:scope.titleCode,afterEventId:scope.nextAfterEventId,throughEventId:scope.throughEventId,clientRequestId:`continue:${props.id}:${scope.nextAfterEventId}`}})
    await router.push({path:'/tasks',query:{tab:'platform',job:receipt.jobId}});emit('changed')
  }catch{notice.value='下一片未确认受理，请刷新后显式重试。'}finally{pending.value=false}
}
async function act(action: 'cancel' | 'retry') {
  if (!data.value || !capabilities.value || !current.value || pending.value || !capabilities.value[action]) return
  let relatedRequestId: string | undefined
  pending.value = true; notice.value = ''
  // A new action supersedes the previous report: the cancel fact and the retry
  // report never speak at the same time.
  cancelRequested.value = false
  try {
    const result = await $fetch<{ cancelRequested?: boolean }>(`/api/task-center/${props.id}/${action}`, { method: 'POST', headers, body: {}, onResponse: ({ response }) => { relatedRequestId = clientRequestReference(response.headers.get('x-request-id')) } })
    // Only the server's own answer may claim that a cancellation is pending.
    cancelRequested.value = action === 'cancel' && !!result.cancelRequested
    if (!cancelRequested.value) {
      notice.value = action === 'retry'
        ? '局部重试已受理；仅补查未完成项，已完成结果保留。'
        : '服务端已处理取消请求。'
    }
    await reload(); emit('changed')
  } catch {
    $clientErrors?.reportInteractionFailure(action === 'cancel' ? 'task_cancel' : 'task_retry', relatedRequestId)
    notice.value = '操作未受理。请刷新任务状态后再试。'
  }
  finally { pending.value = false }
}
</script>

<template>
  <section aria-label="任务执行详情" class="min-w-0">
    <Card class="min-w-0 gap-0 border-0 bg-transparent py-0 shadow-none">
      <CardHeader class="flex flex-col gap-2 px-0 pt-0 pb-4">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="flex min-w-0 flex-col gap-1">
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
      <CardContent class="flex min-w-0 flex-col gap-4 px-0 pb-0">
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

          <section v-if="data.snapshot" id="snapshot-result" ref="snapshotSection" tabindex="-1" aria-label="快照结果摘要" class="flex min-w-0 flex-col gap-2 text-sm">
            <h3 class="font-medium">采集范围、计数与未完成位置</h3>
            <p>范围：本任务选定公布企业 · {{ data.snapshot.enterprises ?? '未知' }} 家</p>
            <p>三接口请求 {{ data.snapshot.requests ?? '未知' }} 次 · 已确认完整行数 {{ data.snapshot.rows ?? '未知' }} · 未完成 {{ data.snapshot.unfinished ?? '未知' }} 范围</p>
            <p v-for="source in data.snapshot.sources" :key="source.source">{{ source.source }}：请求 {{ source.requests ?? '未知' }} 次 · 取回 {{ source.rows ?? '未知' }} 行 · 失败请求 {{ source.failed ?? '未知' }} · 未完成 {{ source.unfinished ?? '未知' }} 范围</p>
            <p v-if="data.snapshot.unfinished !== 0" class="text-muted-foreground">未完成范围的行数未知，不代表零记录。已取回内容保留，尚未完成全部采集入库。</p>
            <ul aria-label="快照未完成位置" class="flex flex-col gap-2">
              <li v-for="(position, index) in data.snapshot.positions" :key="index" class="break-words">
                企业 #{{ position.enterpriseId ?? '未知' }} · {{ position.source }} · {{ position.rdjb === null ? '全部称号' : ({'1':'创新型中小企业','2':'专精特新中小企业','3':'专精特新小巨人'} as Record<string,string>)[position.rdjb] }} · 第 {{ position.page ?? '未知' }} 页待续 · 行数 {{ position.rows ?? '未知' }}
              </li>
            </ul>
            <p v-if="data.snapshot.truncated">仅展示前 20 个未完成位置，其余仍计入未完成范围。</p>
          </section>
          <section v-if="data.discovery" aria-label="候选发现结果" class="flex min-w-0 flex-col gap-3 text-sm">
            <p class="break-words">范围：{{ data.discovery.scope }}</p>
            <p>成功 {{ data.discovery.counts.succeeded }} · 待核 {{ data.discovery.counts.needsReview }} · 失败 {{ data.discovery.counts.failed }}</p>
            <p>新增候选 {{ data.discovery.counts.created }} · 保留已有对应 {{ data.discovery.counts.existing }}</p>
            <p class="text-muted-foreground">候选尚需人工核对，任务不会自动确认。进入事件可查看公布出处和平台原行。</p>
            <ul v-if="data.discovery.items.length" class="flex flex-col gap-2" aria-label="逐事件处理结果">
              <li v-for="item in data.discovery.items" :key="item.eventId" class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <NuxtLink v-if="item.enterpriseId" :to="`/enterprises/${item.enterpriseId}?eventId=${item.eventId}`" class="text-primary underline">核对事件 #{{ item.eventId }} 与双方原行</NuxtLink>
                <span v-else>事件 #{{ item.eventId }}</span>
                <span>{{ item.status === 'running' && !inFlight ? '未完成' : ({pending:'未处理',running:'处理中',done:'已处理',failed:'失败'} as Record<string,string>)[item.status] ?? item.status }} · 新增 {{ item.created }} · 保留 {{ item.existing }}</span>
                <span v-if="item.errorCode" class="text-destructive">{{ item.errorCode === 'source_materialization_limit' ? '原档超出单次读取上限，此原行未写入，已完成候选保留，请按原行核对' : item.errorCode === 'event_unavailable' ? '正式事件不可用' : '候选提交失败，可重试' }}</span>
              </li>
            </ul>
            <Button v-if="data.state === 'done' && data.discovery.titleCode && data.discovery.nextAfterEventId" variant="outline" :disabled="!current || pending" @click="continueDiscovery">继续本称号下一片</Button>
          </section>
          <Alert v-if="data.error" variant="destructive"><AlertTitle>任务错误</AlertTitle><AlertDescription>{{ data.error }}</AlertDescription></Alert>

          <template v-if="data.reconcile">
            <p class="text-sm" data-testid="task-outcome">报告目标 {{ data.reconcile.targets ?? '未知' }} · 待核实 {{ data.reconcile.needsReview ?? '未知' }} · 查询失败 {{ data.reconcile.queryFailed ?? '未知' }} · 未查询 {{ data.reconcile.notQueried ?? '未知' }}</p>
            <p class="text-muted-foreground text-sm">查询完整性与核查结论分开核对；任务完成不代表所有差异已有业务结论。</p>
          </template>
          <template v-if="data.outcome">
            <p class="text-sm" data-testid="task-outcome">
              完整 {{ data.outcome.complete }} · 部分 {{ data.outcome.partial }} ·
              查询失败 {{ data.outcome.failed }} · 未查询 {{ data.outcome.notQueried }}
              <template v-if="data.kind !== 'reconcile'"> · 未完成范围 {{ data.outcome.unfinished }}</template>
            </p>
            <p v-if="data.kind === 'platform-query-batch'" class="text-muted-foreground text-sm">
              以上是平台取回的<b>完整性</b>（执行 {{ data.outcome.attempt }} / 10 次），不是业务判断结论；取回事实仅保存在任务结果中，不代表正式入库。
            </p>
            <p v-else class="text-muted-foreground text-sm">查询完整性与核查结论分开核对；任务完成不代表所有差异已有业务结论。</p>
          </template>

          <section v-if="data.kind === 'reconcile'" class="flex flex-col gap-2 text-sm" aria-label="平台采集完整性">
            <template v-if="reconcileCollection && reconcileCollection.complete !== null">
              <p>采集完整性：完整 {{ reconcileCollection.complete }} 槽位 · 部分 {{ reconcileCollection.partial }} 槽位 · 失败 {{ reconcileCollection.failed }} 槽位 · 未知 {{ reconcileCollection.unknown }} 槽位</p>
              <p>未完成 {{ reconcileCollection.unfinished }} 范围</p>
              <ul v-if="reconcileCollection.positions.length" class="flex flex-col gap-1" aria-label="未完成采集范围">
                <li v-for="(position, index) in reconcileCollection.positions" :key="index">
                  {{ position.source }} / {{ position.rdjb === null ? '不分认定级别' : `rdjb=${position.rdjb}` }} / 第 {{ position.page }} 页
                </li>
              </ul>
              <p v-if="reconcileCollection.positionsTruncated" class="text-muted-foreground">仅展示前 {{ reconcileCollection.positions.length }} 个可定位范围；其余请查看原任务报告。</p>
            </template>
            <p v-else>采集完整性未知：本报告未记录采集完整性。未完成范围未知。</p>
          </section>

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
            <p v-if="data.capabilities?.reason" class="text-muted-foreground text-sm">{{ data.capabilities.reason }}</p>
          </div>

          <p v-if="cancelReport || notice" role="status" data-testid="task-notice" class="text-sm">{{ cancelReport || notice }}</p>

          <div class="flex flex-wrap gap-3">
            <NuxtLink v-if="current && data.id" :to="{ path: '/logs', query: { taskId: data.id } }" class="text-primary text-sm underline underline-offset-4">查看关联运行日志</NuxtLink>
            <NuxtLink v-for="link in links" :key="link.to" :to="link.to" @click="revealResult(link.to)" class="text-primary text-sm underline underline-offset-4">{{ link.label }}</NuxtLink>
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
              <template v-if="data.discovery">
                <dt class="text-muted-foreground">规则版本</dt><dd class="break-all">{{ data.discovery.ruleVersion ?? '未记录' }}</dd>
                <dt class="text-muted-foreground">执行次数</dt><dd>{{ data.discovery.attempt }} / 10</dd>
              </template>
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
