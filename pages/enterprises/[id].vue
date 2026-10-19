<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, nextTick, onMounted, provide, ref, shallowRef, watch } from 'vue'
import type { RosterEnterpriseDetail } from '~~/lib/roster/enterprise-roster'
import type { CursorPage, ImpactRow, ReviewAssessment, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import {
  headerCheckLabel,
  impactOldDecisionText,
  impactScopeLabel,
  latestQueryTime,
  officialTitlesLabel,
  titleLabel,
} from '~~/lib/roster/review-display'
import { sourceReturnTarget } from '~~/lib/roster/correspondence-view'
import RecordEventRow from '@/components/record-correspondence/RecordEventRow.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import AssessmentStatusBadge from '@/components/evidence-review/AssessmentStatusBadge.vue'
import EnterpriseExplanations from '@/components/evidence-review/EnterpriseExplanations.vue'
import PlatformRecords from '@/components/PlatformRecords.vue'
import TitleBadge from '@/components/TitleBadge.vue'
import { QUALITY_FLAGS, TITLE_ORDER } from '~~/lib/labels'
import { fileUrl, fileNameOf } from '~~/lib/preview'
import {
  rememberEvidencePreviewReturn,
  shouldNuxtScrollToTop,
  useEvidencePreviewScrollRestore,
} from '~~/lib/roster/evidence-preview-return'
import { useEnterpriseCorrespondences } from '~/composables/useEnterpriseCorrespondences'
import FilePreviewDialog from '@/components/preview/FilePreviewDialog.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

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
  lifecycle: { firstRecognitionYear: number | null; dueYear: number | null; needsReview: boolean }
  events: DetailEvent[]
}
interface EnterpriseDetail {
  id: number
  name: string
  uscc: string | null
  district: string | null
  titles: string[]
  qualityFlags: string[]
  records: DetailRecord[]
  firstRecognition: { titleCode: string; year: number | null }[]
  awards: { titleCode: string; year: number | null; batchSeq: number | null }[]
}
interface LedgerEvent extends DetailEvent {
  recordId: number
  titleCode: string
  source: string
  district: string | null
}

type DetailTab = 'records' | 'review'

const route = useRoute()
const router = useRouter()
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

const explanationTitle = computed(() => typeof route.query.titleCode === 'string' ? route.query.titleCode : undefined)
const explanationDirection = computed(() => typeof route.query.direction === 'string' ? route.query.direction : undefined)
const impactId = computed(() => typeof route.query.impactId === 'string' && /^[1-9]\d*$/.test(route.query.impactId) && Number.isSafeInteger(Number(route.query.impactId)) ? Number(route.query.impactId) : undefined)

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['roster-enterprise', id.value],
  query: () => apiGet<RosterEnterpriseDetail>(`/api/roster/enterprises/${id.value}`),
})

/**
 * 待复核清单只用来回答“现在有没有要处理的事”和给出第一项的入口。
 * 读取失败时保持未知，不把 0 当作结论。
 */
const pendingParams = computed(() => ({ enterpriseId: Number(id.value), view: 'current', state: 'pending', limit: 25 }))
const {
  data: pendingData,
  isLoading: pendingLoading,
  error: pendingError,
  refetch: refetchPending,
} = useQuery({
  key: () => ['evidence-impacts', pendingParams.value],
  query: ({ entry }) => $fetch<CursorPage<ImpactRow>>('/api/roster/evidence-impacts', { query: entry.key[1] as Record<string, string | number> }),
  placeholderData: previous => previous,
})

const assessments = computed<(ReviewAssessment & ReviewScope)[]>(() => (data.value?.titleAssessments ?? []) as unknown as (ReviewAssessment & ReviewScope)[])
const pendingRows = computed(() => pendingData.value?.rows ?? [])
const pendingHasMore = computed(() => !!pendingData.value?.nextCursor)
const focusedImpactId = ref<number | undefined>()
const openScopeRequest = ref<{ titleCode: string; direction: string } | null>(null)

function onOpenImpact(row: ImpactRow) {
  focusedImpactId.value = row.id
  syncReviewDeepLink(row.titleCode, row.direction, row.id)
}
function onOpenScope(assessment: ReviewAssessment & ReviewScope) {
  openScopeRequest.value = { titleCode: assessment.titleCode, direction: assessment.direction }
  syncReviewDeepLink(assessment.titleCode, assessment.direction)
}

const detail = computed<EnterpriseDetail | null>(() => {
  const source = data.value
  if (!source) return null
  return {
    id: source.enterprise.enterpriseId,
    name: source.enterprise.name,
    uscc: source.enterprise.uscc,
    district: source.enterprise.district,
    titles: source.enterprise.titles ?? [],
    qualityFlags: source.enterprise.uscc ? [] : ['uscc_missing'],
    firstRecognition: source.enterprise.firstRecognition ?? [],
    awards: source.enterprise.awards ?? [],
    records: source.records.map(record => ({
      id: record.id,
      titleCode: record.titleCode,
      source: record.source,
      district: record.district,
      lifecycle: {
        firstRecognitionYear: record.lifecycle?.firstRecognitionYear ?? null,
        dueYear: record.lifecycle?.dueYear ?? null,
        needsReview: record.lifecycle?.needsReview ?? false,
      },
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

/** 称号与复核安排：只陈述首次认定、批次和下一次复核，不复制核对矩阵。 */
const titleInfo = computed(() => {
  const source = detail.value
  if (!source) return []
  const present = new Set(source.titles)
  const ordered = TITLE_ORDER.filter(code => present.has(code))
  return (ordered.length ? ordered : [...present]).map(code => {
    const first = source.firstRecognition.find(item => item.titleCode === code)
    const award = source.awards.find(item => item.titleCode === code)
    const lifecycle = source.records.find(item => item.titleCode === code)?.lifecycle
    return {
      code,
      year: first?.year ?? lifecycle?.firstRecognitionYear ?? null,
      batchSeq: award?.batchSeq ?? null,
      dueYear: lifecycle?.dueYear ?? null,
      needsReview: lifecycle?.needsReview ?? false,
    }
  })
})

const focusedEventId = computed(() => typeof route.query.eventId === 'string' && /^\d+$/.test(route.query.eventId) ? Number(route.query.eventId) : null)

/* ------------------------------------------------------------------ *
 * 两个承载页：认定信息与记录（默认）/ 称号核对。
 *
 * 核对矩阵不再压在企业详情首屏：从台账来看企业的人先读认定与记录；
 * 需要逐项判断时再进核对页。抽屉只保留摘要与入口，不重复矩阵。
 * ------------------------------------------------------------------ */
const routeTab = computed<DetailTab>(() => {
  // 事件深链优先落在记录页：它要求展开并定位具体事件。
  if (focusedEventId.value != null) return 'records'
  if (route.query.tab === 'review' || route.query.tab === 'records') return route.query.tab
  if (explanationTitle.value || explanationDirection.value || impactId.value) return 'review'
  return 'records'
})
const tab = ref<DetailTab>(routeTab.value)
watch(routeTab, value => { tab.value = value })

const {
  rows: correspondenceRows,
  loading: correspondenceLoading,
  error: correspondenceError,
  reload: reloadCorrespondences,
} = useEnterpriseCorrespondences(computed(() => tab.value === 'records' ? detail.value?.id ?? null : null))

// 原行摘要与展开的出处会改变页面高度，等它们成功或失败后再恢复预览前位置。
const detailRendered = computed(() => (detail.value !== null || error.value != null) && !correspondenceLoading.value)
useEvidencePreviewScrollRestore(detailRendered)

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


/** 核对面板内的未提交草稿由 EvidenceReviewForm 写入；切页前先确认，不静默丢弃。 */
const reviewDraft = shallowRef(false)
provide('enterprise-review-draft', reviewDraft)
const pendingTab = ref<DetailTab | null>(null)

function requestTab(next: DetailTab) {
  if (next === tab.value) return
  if (tab.value === 'review' && reviewDraft.value) {
    pendingTab.value = next
    return
  }
  applyTab(next)
}

function applyTab(next: DetailTab) {
  pendingTab.value = null
  tab.value = next
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(route.query)) {
    if (typeof value !== 'string') continue
    if (key === 'titleCode' || key === 'direction' || key === 'impactId' || key === 'eventId') continue
    query[key] = value
  }
  query.tab = next
  void router.replace({ path: route.path, query })
}

async function arriveAtEvent(eventId: number | null) {
  if (typeof document === 'undefined') return
  if (!detail.value || eventId == null || !detail.value.records.some(record => record.events.some(event => event.id === eventId))) return
  const enterpriseId = id.value
  tab.value = 'records'
  setEvidenceDisclosureOpen(evidenceDisclosureKey(eventId), true)
  await nextTick()
  if (id.value !== enterpriseId || focusedEventId.value !== eventId) return
  document.getElementById(`record-event-${eventId}`)?.scrollIntoView({ block: 'start' })
}
watch([detail, focusedEventId], ([, eventId]) => arriveAtEvent(eventId), { immediate: true })

useHead({
  title: computed(() => (detail.value ? `${detail.value.name} · 企业详情` : '企业详情')),
})
const usccMissing = computed(() => detail.value?.qualityFlags?.includes('uscc_missing') ?? false)
const otherFlags = computed(() => (detail.value?.qualityFlags ?? []).filter((f) => f !== 'uscc_missing'))
const recordCount = computed(() => detail.value?.records.length ?? 0)
const eventCount = computed(() => ledgerEvents.value.length)
const platformRowCount = computed(() => data.value?.platform.relations.length ?? 0)

const titleNames = computed(() => titleInfo.value.map(item => titleLabel(item.code)))
const lastChecked = computed(() => latestQueryTime(assessments.value))
/**
 * 头部摘要与正文必须来自同一状态事实：
 * - 称号只陈述“正式称号”这一轴；
 * - 查询时间只陈述平台查询时间，不推断核对完成度。
 */
const lastCheckedLabel = computed(() => headerCheckLabel(lastChecked.value))
const titlesLabel = computed(() => officialTitlesLabel(titleNames.value))

async function onReviewSaved() {
  await Promise.all([refetch(), refetchPending()])
}

function flagLabel(f: string) {
  return QUALITY_FLAGS[f] ?? f
}

function syncReviewDeepLink(titleCode: string, direction: string, impact?: number) {
  if (tab.value !== 'review') tab.value = 'review'
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(route.query)) {
    if (typeof value === 'string') query[key] = value
  }
  query.tab = 'review'
  query.titleCode = titleCode
  query.direction = direction
  if (impact != null) query.impactId = String(impact)
  else delete query.impactId
  void router.replace({ path: route.path, query })
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
    <template v-if="isLoading && !detail">
      <div class="flex flex-col gap-2">
        <Skeleton class="h-3 w-24" />
        <Skeleton class="h-7 w-72" />
        <Skeleton class="h-4 w-96" />
      </div>
      <div class="bg-card rounded-lg border p-5">
        <Skeleton class="h-6 w-56" />
        <Skeleton class="mt-3 h-4 w-full max-w-xl" />
      </div>
    </template>

    <!-- 加载失败 -->
    <Alert v-else-if="error && !detail" variant="destructive">
      <AlertTitle>未能加载企业详情</AlertTitle>
      <AlertDescription class="flex flex-wrap items-center gap-2">
        请重试读取，或返回台账重新选择。
        <Button variant="outline" size="sm" @click="refetch()">重新读取企业详情</Button>
      </AlertDescription>
    </Alert>

    <template v-else-if="detail">
      <TableFailureState v-if="error" title="企业详情更新失败" description="保留上次成功的企业详情和决定，请重试读取当前状态。" :pending="isLoading" @retry="refetch()" />

      <PageHeader :title="detail.name">
        <template #breadcrumb>
          <NuxtLink :to="backTo" class="hover:text-foreground hover:underline">{{ sourceReturnTarget(route.query.returnTo) ? '记录级对比' : '企业列表' }}</NuxtLink>
          <span class="mx-1.5">/</span>
          <span>企业详情</span>
        </template>
        <template #description>
          <span>{{ detail.district ?? '属地未知' }}</span>
          <span class="mx-1.5">·</span><span>{{ titlesLabel }}</span>
          <span class="mx-1.5">·</span><span class="whitespace-nowrap">{{ lastCheckedLabel }}</span>
          <span class="mx-1.5">·</span><span class="font-mono text-xs whitespace-nowrap">{{ detail.uscc ?? '无统一社会信用代码' }}</span>
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

      <Tabs :model-value="tab" class="gap-4" @update:model-value="requestTab($event as DetailTab)">
        <TabsList class="h-auto w-full justify-start gap-1 sm:w-fit" aria-label="企业详情内容">
          <TabsTrigger value="records" class="h-8 flex-none px-3 text-[13px]">
            认定信息与记录
            <span class="text-muted-foreground tabular-nums">{{ eventCount }}</span>
          </TabsTrigger>
          <TabsTrigger value="review" class="h-8 flex-none px-3 text-[13px]">
            称号核对
            <span
              v-if="pendingRows.length"
              class="bg-warning/15 text-warning inline-flex min-w-4 items-center justify-center rounded-sm px-1 text-xs tabular-nums"
            >{{ pendingRows.length }}{{ pendingHasMore ? '+' : '' }}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="records" class="flex min-w-0 flex-col gap-5">
          <!-- 称号与复核安排：只保留首屏需要的事实，不重复核对状态矩阵。 -->
          <section class="bg-card overflow-hidden rounded-lg border" aria-label="称号与复核安排">
            <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-3">
              <h2 class="text-sm font-semibold">称号与复核安排</h2>
              <span class="text-muted-foreground text-[13px]">{{ titleInfo.length }} 个正式称号</span>
            </header>
            <dl v-if="titleInfo.length" class="divide-y">
              <div
                v-for="item in titleInfo"
                :key="item.code"
                class="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-baseline"
              >
                <dt class="min-w-0"><TitleBadge :code="item.code" /></dt>
                <dd class="text-[13px] leading-5">
                  <span>首次认定 {{ item.year ?? '年份待核' }}<template v-if="item.batchSeq != null"> · 第 {{ item.batchSeq }} 批</template></span>
                  <span class="text-muted-foreground"> · </span>
                  <span>下次复核 {{ item.dueYear ?? '年份待核' }}</span>
                  <span v-if="item.needsReview" class="text-warning"> · 待核</span>
                </dd>
              </div>
            </dl>
            <p v-else class="text-muted-foreground px-4 py-6 text-[13px]">尚无正式称号记录。</p>
          </section>

          <section class="bg-card overflow-hidden rounded-lg border" aria-label="认定与复核记录">
            <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-3">
              <h2 class="text-sm font-semibold">认定与复核记录</h2>
              <span class="text-muted-foreground text-[13px]">{{ eventCount }} 条</span>
              <span class="text-muted-foreground text-[13px]">正式公布文件与复核结论</span>
            </header>
            <div v-if="recordCount === 0" class="text-muted-foreground py-12 text-center text-sm">
              该企业暂无记录。
            </div>
            <section v-else aria-label="记录台账">
              <header class="bg-muted/40 text-muted-foreground hidden border-b px-5 py-2 text-xs sm:grid sm:grid-cols-[6.5rem_minmax(0,1fr)_18rem_auto] sm:gap-4">
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
          </section>

          <p v-if="correspondenceLoading" class="text-muted-foreground text-[13px]">正在读取每条记录的平台接口出处…</p>
          <Alert v-else-if="correspondenceError" variant="destructive">
            <AlertTitle>平台接口出处暂未读取</AlertTitle>
            <AlertDescription class="flex flex-wrap items-center gap-2">
              上方公布文件仍保留；已登记的接口对应暂时无法显示。
              <Button variant="outline" size="sm" :disabled="correspondenceLoading" @click="reloadCorrespondences">重试读取</Button>
            </AlertDescription>
          </Alert>

          <!-- 平台原行是辅助区，默认收起；它不参与上面的出处判定。 -->
          <DisclosurePanel keep-mounted content-class="pb-0" trigger-class="px-4" class="bg-card overflow-hidden rounded-lg border">
            <template #trigger>
              <span class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span class="text-sm font-medium">平台记录</span>
                <span class="text-muted-foreground text-[13px]">{{ platformRowCount }} 条</span>
              </span>
            </template>
            <div class="min-w-0 border-t p-4">
              <PlatformRecords
                :queries="data?.platform.queries ?? []"
                :relations="data?.platform.relations ?? []"
                :return-to="sourceReturnTarget(route.query.returnTo)"
                @event-navigate="arriveAtEvent"
              />
            </div>
          </DisclosurePanel>
        </TabsContent>

        <TabsContent value="review" class="flex min-w-0 flex-col gap-5">
          <!-- 待处理是核对页的入口摘要，不是企业结论卡；不使用彩色单侧边线。 -->
          <section v-if="pendingRows.length || pendingError" class="bg-card overflow-hidden rounded-lg border" aria-label="待处理证据变化">
            <header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-4 py-3">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h2 class="text-sm font-semibold">待处理证据变化</h2>
                <span class="text-muted-foreground text-[13px]">{{ pendingRows.length }}{{ pendingHasMore ? '+' : '' }} 项</span>
              </div>
              <p class="text-muted-foreground max-w-[46ch] text-[13px] leading-5">原决定保留；核对后明确维持或更正。</p>
            </header>
            <ul v-if="pendingRows.length" class="divide-y">
              <li
                v-for="row in pendingRows.slice(0, 3)"
                :key="row.id"
                class="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-sm font-medium">{{ impactScopeLabel(row) }}</span>
                    <AssessmentStatusBadge kind="impact" :value="row.classification" />
                    <span class="text-muted-foreground text-[13px]">{{ row.pending ? '待复核' : '已登记复核' }}</span>
                  </div>
                  <p class="text-muted-foreground mt-0.5 text-[13px] leading-5">{{ impactOldDecisionText(row) }}</p>
                </div>
                <Button variant="outline" size="sm" class="shrink-0 self-start sm:self-center" @click="onOpenImpact(row)">
                  核对这一项
                </Button>
              </li>
            </ul>
            <p v-if="pendingHasMore" class="text-muted-foreground border-t px-4 py-2 text-[13px]">
              另有未显示的待处理项，可在复核队列中查看。
            </p>
            <p v-if="pendingError" class="text-destructive border-t px-4 py-2 text-[13px] leading-5">
              待复核清单读取失败；这不代表没有待处理项。
            </p>
          </section>

          <EnterpriseExplanations
            :key="detail.id"
            :enterprise-id="detail.id"
            :assessments="assessments"
            :title-code="explanationTitle"
            :direction="explanationDirection"
            :impact-id="focusedImpactId ?? impactId"
            :open-scope-request="openScopeRequest"
            :pending="pendingRows"
            :locate="focusedEventId == null && !correspondenceLoading"
            @saved="onReviewSaved"
          />
        </TabsContent>
      </Tabs>
    </template>

    <!--
      预览弹窗挂在最外层,不放卡片里:弹窗是 Teleport 到 body 的,
      放在卡片内只是让它跟着卡片重建,没必要。
    -->
    <FilePreviewDialog v-model:open="previewOpen" :src="previewSrc" :name="previewName" />

    <Dialog :open="pendingTab !== null" @update:open="value => { if (!value) pendingTab = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>切换会关闭核对面板</DialogTitle>
          <DialogDescription>
            已填写的复核信息尚未提交；切换后这些内容会丢失。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="pendingTab = null">留在此页</Button>
          <Button @click="pendingTab && applyTab(pendingTab)">仍然切换</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
