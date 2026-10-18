<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ChevronDown } from '@lucide/vue'
import type { RosterEnterpriseDetail } from '~~/lib/roster/enterprise-roster'
import { sourceReturnTarget } from '~~/lib/roster/correspondence-view'
import RecordEventRow from '@/components/record-correspondence/RecordEventRow.vue'
import PlatformRecords from '@/components/PlatformRecords.vue'
import { QUALITY_FLAGS } from '~~/lib/labels'
import { fileUrl, fileNameOf } from '~~/lib/preview'
import {
  rememberEvidencePreviewReturn,
  shouldNuxtScrollToTop,
  useEvidencePreviewScrollRestore,
} from '~~/lib/roster/evidence-preview-return'
import { useEnterpriseCorrespondences } from '~/composables/useEnterpriseCorrespondences'
import FilePreviewDialog from '@/components/preview/FilePreviewDialog.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'

definePageMeta({ scrollToTop: (to, from) => shouldNuxtScrollToTop(to.fullPath, from.path) })

interface Evidence {
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}
interface DetailEvent {
  id: number
  type: string
  year: number | null
  seq: number | null
  decidedYear: number | null
  reviewOutcome: string | null
  evidence: Evidence[]
}
interface DetailRecord {
  id: number
  titleCode: string
  source: string
  district: string | null
  events: DetailEvent[]
}
interface EnterpriseDetail {
  id: number
  name: string
  uscc: string | null
  district: string | null
  qualityFlags: string[]
  records: DetailRecord[]
}
interface LedgerEvent extends DetailEvent {
  recordId: number
  titleCode: string
  source: string
  district: string | null
}

const route = useRoute()
const id = computed(() => String(route.params.id ?? ''))

/**
 * 返回名录台账。
 *
 * 台账把「视图 + 全部筛选 + 页码」都放在地址栏里,所以进企业详情时把那份筛选串
 * 作为 `back` 带过来(见 `RosterEnterprisePanel` / `RosterTitleTable` 的链接)。
 * 没有 `back`(直接输 URL、从别处进来)就退回台账首页。
 *
 * 只接受**查询串**形状(`a=1&b=2`),兑成 query 对象再交给 router —— 不直接拼进 `to`,
 * 免得把一个来路不明的字符串当路径用。
 */
const backTo = computed(() => {
  const comparison = sourceReturnTarget(route.query.returnTo)
  if (comparison) return comparison
  const raw = typeof route.query.back === 'string' ? route.query.back : ''
  if (!raw) return '/'
  const query: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) query[k] = v
  return { path: '/', query }
})

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading, error } = useQuery({
  key: () => ['roster-enterprise', id.value],
  query: () => apiGet<RosterEnterpriseDetail>(`/api/roster/enterprises/${id.value}`),
})

const detail = computed<EnterpriseDetail | null>(() => {
  const source = data.value
  if (!source) return null
  return {
    id: source.enterprise.enterpriseId,
    name: source.enterprise.name,
    uscc: source.enterprise.uscc,
    district: source.enterprise.district,
    qualityFlags: source.enterprise.uscc ? [] : ['uscc_missing'],
    records: source.records.map(record => ({
      id: record.id,
      titleCode: record.titleCode,
      source: record.source,
      district: record.district,
      events: source.events.filter(event => event.recordId === record.id).map(event => ({
        id: event.id,
        type: event.eventType,
        year: event.year,
        seq: event.batchSeq,
        decidedYear: event.decidedYear,
        reviewOutcome: event.reviewOutcome,
        evidence: source.evidence.filter(item => item.eventId === event.id),
      })),
    })),
  }
})
const detailRendered = computed(() => detail.value !== null || error.value != null)
useEvidencePreviewScrollRestore(detailRendered)

const EVENT_TYPE_ORDER: Record<string, number> = { award: 0, review: 1, maintain: 2, nurture: 3 }

/** 全部认定 / 复核记录摊平成同一张台账：年份是主序，称号与来源只是行内标签。 */
const ledgerEvents = computed<LedgerEvent[]>(() => {
  const source = detail.value
  if (!source) return []
  return source.records
    .flatMap(record => record.events.map(event => ({
      ...event,
      recordId: record.id,
      titleCode: record.titleCode,
      source: record.source,
      district: record.district,
    })))
    .sort((a, b) => ((a.type === 'review' ? a.decidedYear : a.year) ?? 9999) - ((b.type === 'review' ? b.decidedYear : b.year) ?? 9999)
      || (EVENT_TYPE_ORDER[a.type] ?? 9) - (EVENT_TYPE_ORDER[b.type] ?? 9)
      || a.id - b.id)
})

const {
  rows: correspondenceRows,
  loading: correspondenceLoading,
  error: correspondenceError,
  reload: reloadCorrespondences,
} = useEnterpriseCorrespondences(computed(() => detail.value?.id ?? null))

function edgesFor(eventId: number) {
  return correspondenceRows.value.filter(edge => edge.eventId === eventId && edge.type !== 'later_process')
}

const EVIDENCE_DISCLOSURE_RETURN_KEY = 'roster:enterprise-detail-open-evidence'
const openEvidenceKeys = ref<string[]>([])

function evidenceDisclosureKey(eventId: number): string {
  return JSON.stringify([id.value, eventId])
}

function evidenceDisclosureOpen(key: string): boolean {
  return openEvidenceKeys.value.includes(key)
}

function setEvidenceDisclosureOpen(key: string, open: boolean): void {
  const next = new Set(openEvidenceKeys.value)
  if (open) next.add(key)
  else next.delete(key)
  openEvidenceKeys.value = [...next]
}

onMounted(() => {
  try {
    const raw = window.sessionStorage.getItem(EVIDENCE_DISCLOSURE_RETURN_KEY)
    window.sessionStorage.removeItem(EVIDENCE_DISCLOSURE_RETURN_KEY)
    if (!raw) return
    const state: unknown = JSON.parse(raw)
    if (!state || typeof state !== 'object') return
    const candidate = state as { back?: unknown; keys?: unknown }
    if (
      candidate.back === route.fullPath &&
      Array.isArray(candidate.keys) &&
      candidate.keys.every((key) => typeof key === 'string')
    ) {
      openEvidenceKeys.value = candidate.keys
    }
  } catch {
    // Storage may be unavailable; the page remains usable without disclosure restoration.
  }
})

/**
 * 出处页链接要记住「这次是从哪条事件打开的」。回到详情页时据此重新展开同一条出处，
 * 再把页面滚动恢复到原来的位置。
 */
function rememberPagePreviewReturn(eventId: number, event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const keys = new Set(openEvidenceKeys.value)
  keys.add(evidenceDisclosureKey(eventId))
  try {
    window.sessionStorage.setItem(EVIDENCE_DISCLOSURE_RETURN_KEY, JSON.stringify({ back: route.fullPath, keys: [...keys] }))
  } catch {
    // Storage may be unavailable; ordinary preview navigation still works.
  }
  rememberEvidencePreviewReturn(route.fullPath, event.currentTarget)
}

const focusedEventId = computed(() => typeof route.query.eventId === 'string' && /^\d+$/.test(route.query.eventId) ? Number(route.query.eventId) : null)
async function arriveAtEvent(eventId: number | null) {
  if (typeof document === 'undefined') return
  if (!detail.value || eventId == null || !detail.value.records.some(record => record.events.some(event => event.id === eventId))) return
  const enterpriseId = id.value
  setEvidenceDisclosureOpen(evidenceDisclosureKey(eventId), true)
  await nextTick()
  if (id.value !== enterpriseId || focusedEventId.value !== eventId) return
  document.getElementById(`record-event-${eventId}`)?.scrollIntoView({ block: 'start' })
}
watch([detail, focusedEventId], ([, eventId]) => arriveAtEvent(eventId), { immediate: true })

/**
 * 页面标题(RL-17 收尾):企业名 + 页面名。详情是异步取的,所以先给一个不含名字的兜底,
 * 拿到之后自动换成企业名 —— 空白标题在历史记录里完全认不出是哪个企业。
 */
useHead({
  title: computed(() => (detail.value ? `${detail.value.name} · 企业详情` : '企业详情')),
})
const usccMissing = computed(() => detail.value?.qualityFlags?.includes('uscc_missing') ?? false)
const otherFlags = computed(() => (detail.value?.qualityFlags ?? []).filter((f) => f !== 'uscc_missing'))
const recordCount = computed(() => detail.value?.records.length ?? 0)
const eventCount = computed(() => ledgerEvents.value.length)
const platformRowCount = computed(() => data.value?.platform.relations.length ?? 0)

function flagLabel(f: string) {
  return QUALITY_FLAGS[f] ?? f
}

/**
 * 出处预览弹窗的状态。
 *
 * `previewSrc` **关闭时不清空**:留着上一次的值,弹窗关闭的动画才还有内容可放,
 * 不会在动画途中闪成空白。下次打开展示的就是新值。
 */
const previewSrc = ref('')
const previewName = ref('')
const previewOpen = ref(false)

function openPreview(e: Evidence) {
  previewSrc.value = fileUrl(e.sourceFile)
  previewName.value = fileNameOf(e.sourceFile)
  previewOpen.value = true
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- 加载中 -->
    <template v-if="isLoading">
      <div class="flex flex-col gap-2">
        <Skeleton class="h-3 w-24" />
        <Skeleton class="h-7 w-72" />
        <Skeleton class="h-4 w-96" />
      </div>
      <Card v-for="i in 2" :key="i" class="gap-0 py-0">
        <CardContent class="flex flex-col gap-3 p-5">
          <Skeleton class="h-5 w-48" />
          <Skeleton class="h-24 w-full" />
        </CardContent>
      </Card>
    </template>

    <!-- 加载失败 -->
    <Alert v-else-if="error" variant="destructive">
      <AlertTitle>未能加载企业详情</AlertTitle>
      <AlertDescription>该企业不存在或已被移除。请返回台账重新选择。</AlertDescription>
    </Alert>

    <template v-else-if="detail">
      <PageHeader :title="detail.name">
        <template #breadcrumb>
          <NuxtLink :to="backTo" class="hover:text-foreground hover:underline">{{ sourceReturnTarget(route.query.returnTo) ? '记录级对比' : '企业列表' }}</NuxtLink>
          <span class="mx-1.5">/</span>
          <span>企业详情</span>
        </template>
        <template #description>
          <span class="font-mono">{{ detail.uscc ?? '无统一社会信用代码' }}</span>
          <span class="mx-1.5">·</span>{{ detail.district ?? '属地未知' }}
          <span class="mx-1.5">·</span>共 {{ recordCount }} 条记录 / {{ eventCount }} 条认定与复核记录
        </template>
        <template #actions>
          <Badge v-for="f in otherFlags" :key="f" variant="destructive">{{ flagLabel(f) }}</Badge>
        </template>
      </PageHeader>

      <Alert v-if="usccMissing" variant="destructive">
        <AlertTitle>缺统一社会信用代码,记录按企业名称归并</AlertTitle>
        <AlertDescription>
          该企业没有统一社会信用代码,台账按<strong>企业名称</strong>把记录归到一起。
          若与同名企业混同,需回到公布文件人工核对。
        </AlertDescription>
      </Alert>

      <Card v-if="recordCount === 0" class="gap-0 py-0">
        <CardContent class="text-muted-foreground py-12 text-center text-sm">
          该企业暂无记录。
        </CardContent>
      </Card>

      <!--
        记录台账：每条认定 / 复核一行，出处就在同一行右列。
        点击「查看出处」才展开文件与接口的原始出处，不再套多层卡片。
      -->
      <section v-else aria-label="记录台账" class="overflow-hidden rounded-lg border bg-card">
        <header class="hidden border-b bg-muted/40 px-5 py-2 text-xs text-muted-foreground sm:grid sm:grid-cols-[6.5rem_minmax(0,1fr)_18rem_auto] sm:gap-4">
          <span>年度 / 事项</span>
          <span>结论</span>
          <span>出处</span>
          <span class="sr-only">展开</span>
        </header>
        <ul class="divide-y">
          <li v-for="event in ledgerEvents" :key="event.id">
            <RecordEventRow
              :event="event"
              :evidence="event.evidence"
              :edges="edgesFor(event.id)"
              :back="route.fullPath"
              :return-to="sourceReturnTarget(route.query.returnTo)"
              :open="evidenceDisclosureOpen(evidenceDisclosureKey(event.id))"
              @update:open="setEvidenceDisclosureOpen(evidenceDisclosureKey(event.id), $event)"
              @preview="openPreview"
              @event-navigate="arriveAtEvent"
              @page-open="rememberPagePreviewReturn"
            />
          </li>
        </ul>
      </section>

      <p v-if="correspondenceLoading" class="text-muted-foreground text-[13px]">正在读取每条记录的平台接口出处…</p>
      <Alert v-else-if="correspondenceError" variant="destructive">
        <AlertTitle>平台接口出处暂未读取</AlertTitle>
        <AlertDescription class="flex flex-wrap items-center gap-2">
          上方公布文件仍保留；已登记的接口对应暂时无法显示。
          <Button variant="outline" size="sm" :disabled="correspondenceLoading" @click="reloadCorrespondences">重试读取</Button>
        </AlertDescription>
      </Alert>

      <!--
        平台原行是辅助区：默认折叠，保留全部查询记录可查；它不参与上面的出处判定。
      -->
      <Collapsible v-slot="{ open }" class="overflow-hidden rounded-lg border bg-card">
        <CollapsibleTrigger as-child>
          <Button variant="ghost" class="h-auto w-full justify-between gap-3 px-4 py-3 text-left">
            <span class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span class="text-sm font-medium">全部平台记录</span>
              <span class="text-muted-foreground text-[13px]">{{ platformRowCount }} 条</span>
            </span>
            <ChevronDown class="size-4 shrink-0 transition-transform duration-150" :class="!open && '-rotate-90'" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent force-mount :class="!open && 'hidden'">
          <div class="min-w-0 border-t p-4">
            <PlatformRecords
              :queries="data?.platform.queries ?? []"
              :relations="data?.platform.relations ?? []"
              :return-to="sourceReturnTarget(route.query.returnTo)"
              @event-navigate="arriveAtEvent"
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </template>

    <!--
      预览弹窗挂在最外层,不放卡片里:弹窗是 Teleport 到 body 的,
      放在卡片内只是让它跟着卡片重建,没必要。
    -->
    <FilePreviewDialog v-model:open="previewOpen" :src="previewSrc" :name="previewName" />
  </div>
</template>
