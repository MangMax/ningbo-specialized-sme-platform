<script setup lang="ts">
import { CURRENT_STATUS_LABELS } from '~~/lib/roster/current-status'
import { useQuery } from '@pinia/colada'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { ReviewAssessment } from '~~/lib/roster/evidence-review-ui'
import EventChip from '@/components/EventChip.vue'
import type { RosterEnterpriseDetail } from '~~/lib/roster/enterprise-roster'
import {
  headerCheckLabel,
  latestQueryTime,
  officialTitlesLabel,
  titleLabel,
} from '~~/lib/roster/review-display'
import { sourceReturnTarget, type OfficialPublishedFact } from '~~/lib/roster/correspondence-view'
import OfficialEvidenceView from '@/components/record-correspondence/OfficialEvidence.vue'
import { eventDecisionText } from '~~/lib/roster/correspondence-view'
import TableFailureState from '@/components/TableFailureState.vue'
import PlatformRecords from '@/components/PlatformRecords.vue'
import TitleBadge from '@/components/TitleBadge.vue'
import { QUALITY_FLAGS, TITLE_ORDER } from '~~/lib/labels'
import { fileUrl, fileNameOf } from '~~/lib/preview'
import {
  hasEvidencePreviewReturn,
  rememberEvidencePreviewReturn,
  shouldNuxtScrollToTop,
  useEvidencePreviewScrollRestore,
} from '~~/lib/roster/evidence-preview-return'
import FilePreviewDialog from '@/components/preview/FilePreviewDialog.vue'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

definePageMeta({ scrollToTop: (to, from) => shouldNuxtScrollToTop(to.fullPath, from.path) })

interface Evidence {
  id?: number
  publishedName?: OfficialPublishedFact
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
  if (typeof route.query.currentBack === 'string') {
    const query: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(route.query.currentBack)) query[key] = value
    return { path: '/current-enterprises', query }
  }
  const comparison = sourceReturnTarget(route.query.returnTo)
  if (comparison) return comparison
  const raw = typeof route.query.back === 'string' ? route.query.back : ''
  if (!raw) return '/'
  const query: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) query[k] = v
  return { path: '/', query }
})

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['roster-enterprise', id.value],
  query: async () => {
    const result = await apiGet<RosterEnterpriseDetail>(`/api/roster/enterprises/${id.value}`)
    if (result.publishedPresentation?.availability === 'unavailable') throw new Error('Official published names unavailable')
    return result
  },
})

const assessments = computed(() => (data.value?.titleAssessments ?? []) as unknown as ReviewAssessment[])
// Presentation only: all eligibility and applicability decisions come from the detail snapshot.
const qualificationRows = computed(() => data.value?.qualificationAssessment?.titles ?? [])
const qualificationGroupLabel = { eligible: '宁波当前可纳入', pending: '宁波当前待核', excluded: '不纳入宁波当前结果' }
const detail = computed<EnterpriseDetail | null>(() => {
  const source = data.value
  if (!source) return null
  const publishedNames = new Map(source.publishedPresentation?.facts.map(fact => [fact.evidenceId, fact]) ?? [])
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
        evidence: source.evidence.filter(item => item.eventId === event.id).map(item => ({ ...item, publishedName: publishedNames.get(item.id) })),
      })),
    })),
  }
})

const confirmedAliasNames = computed(() => data.value?.aliases.filter(alias => alias.verificationStatus === 'confirmed').map(alias => alias.name) ?? [])

function historyYear(event: LedgerEvent): number | null {
  return event.type === 'review' ? event.decidedYear : event.year
}

/** 保留每个事件身份；复核按公布结论年排列，同年以事件身份稳定排列。 */
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
    .sort((a, b) => (historyYear(a) ?? 9999) - (historyYear(b) ?? 9999)
      || a.id - b.id)
})

const historySource = shallowRef('jxj')
const historySources = [{ code: 'jxj', label: '公布资料' }]

/** 来源分别展示；记录即使没有事件，也保留其称号空状态。 */
const sourceHistories = computed(() => historySources.map(source => {
  const present = new Set(detail.value?.records.filter(record => record.source === source.code).map(record => record.titleCode) ?? [])
  const titles = [...TITLE_ORDER.filter(code => present.has(code)), ...[...present].filter(code => !TITLE_ORDER.includes(code))]
  return { ...source, histories: titles.map(code => ({ code, events: ledgerEvents.value.filter(event => event.source === source.code && event.titleCode === code) })) }
}))

/** 资格取自同一详情快照；首次认定与复核安排不推断当前资格。 */
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
      qualification: qualificationRows.value.find(item => item.titleCode === code),
      year: first?.year ?? lifecycle?.firstRecognitionYear ?? null,
      batchSeq: award?.batchSeq ?? null,
      dueYear: lifecycle?.dueYear ?? null,
      needsReview: lifecycle?.needsReview ?? false,
    }
  })
})

const focusedEventId = computed(() => typeof route.query.eventId === 'string' && /^\d+$/.test(route.query.eventId) ? Number(route.query.eventId) : null)
const detailRendered = computed(() => detail.value !== null || error.value != null)
// Cached detail can refresh again after focus restoration; do not steal source-link focus.
let previewReturnEventId = hasEvidencePreviewReturn(route.fullPath) ? focusedEventId.value : null
useEvidencePreviewScrollRestore(detailRendered, undefined, route.fullPath)

/** 公布文件预览返回对应事件及原列表上下文。 */
function previewReturnPath(eventId: number): string {
  const [path, search = ''] = route.fullPath.split('?')
  const query = new URLSearchParams(search.split('#')[0])
  query.set('tab', 'records')
  query.set('eventId', String(eventId))
  return `${path}?${query}`
}
function rememberPagePreviewReturn(eventId: number, event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  rememberEvidencePreviewReturn(previewReturnPath(eventId), event.currentTarget)
}


/**
 * eventId 深链要落在具体那一行：多个事件同在记录页时，仅展开来源不足以说明
 * “到了哪里”。滚动后短暂高亮目标行，再自行褪去。
 */
const highlightedEventId = ref<number | null>(null)
function highlightEvent(eventId: number) {
  highlightedEventId.value = eventId
}
async function arriveAtEvent(eventId: number | null) {
  if (typeof document === 'undefined') return
  if (eventId == null || focusedEventId.value !== eventId) return
  const record = detail.value?.records.find(record => record.events.some(event => event.id === eventId))
  if (!record) return
  const enterpriseId = id.value
  historySource.value = record.source
  await nextTick()
  // Nuxt may still be restoring the page scroll after the route settles; wait two
  // frames and a short delay so the locate is the last scroll, not the first.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  await new Promise<void>(resolve => setTimeout(resolve, 50))
  if (id.value !== enterpriseId || focusedEventId.value !== eventId) return
  const target = document.getElementById(`record-event-${eventId}`)
  target?.scrollIntoView({ block: 'start' })
  target?.focus({ preventScroll: true })
  if (target) highlightEvent(eventId)
}
watch([detail, focusedEventId], ([, eventId]) => {
  if (eventId !== null && eventId === previewReturnEventId) {
    const record = detail.value?.records.find(record => record.events.some(event => event.id === eventId))
    if (record) historySource.value = record.source
    return
  }
  previewReturnEventId = null
  void arriveAtEvent(eventId)
}, { immediate: true })

useHead({
  title: computed(() => (detail.value ? `${detail.value.name} · 企业详情` : '企业详情')),
})
const usccMissing = computed(() => detail.value?.qualityFlags?.includes('uscc_missing') ?? false)
const otherFlags = computed(() => (detail.value?.qualityFlags ?? []).filter((f) => f !== 'uscc_missing'))
const recordCount = computed(() => detail.value?.records.length ?? 0)
const eventCount = computed(() => ledgerEvents.value.length)

const titleNames = computed(() => titleInfo.value.map(item => titleLabel(item.code)))
const lastChecked = computed(() => latestQueryTime(assessments.value))
/**
 * 头部摘要与正文必须来自同一状态事实：
 * - 称号只陈述“正式称号”这一轴；
 * - 查询时间只陈述平台查询时间，不推断核对完成度。
 */
const lastCheckedLabel = computed(() => headerCheckLabel(lastChecked.value))
const titlesLabel = computed(() => officialTitlesLabel(titleNames.value))

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
      <TableFailureState v-if="error" title="企业详情更新失败" description="保留上次成功的企业详情，请重试读取当前状态。" :pending="isLoading" @retry="refetch()" />

      <section class="bg-card min-w-0 space-y-3 rounded-lg border p-4 sm:p-5" aria-label="企业概况">
      <PageHeader :title="detail.name" class="min-w-0 max-w-full [&_h1]:max-w-full [&_h1]:whitespace-normal [&_h1]:[overflow-wrap:anywhere]">
        <template #breadcrumb>
          <NuxtLink :to="backTo" class="hover:text-foreground hover:underline">{{ route.query.currentBack != null ? '优质中小企业查询' : sourceReturnTarget(route.query.returnTo) ? '记录级对比' : '企业列表' }}</NuxtLink>
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

      <p v-if="confirmedAliasNames.length" class="text-muted-foreground border-t pt-3 text-sm leading-6">已确认曾用名：{{ confirmedAliasNames.join('、') }}</p>
      </section>

      <Alert v-if="usccMissing" variant="destructive">
        <AlertTitle>缺统一社会信用代码,记录按企业名称归并</AlertTitle>
        <AlertDescription>
          该企业没有统一社会信用代码,台账按<strong>企业名称</strong>把记录归到一起。
          若与同名企业混同,需回到公布文件人工核对。
        </AlertDescription>
      </Alert>

      <div class="flex min-w-0 flex-col gap-5">
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
                <dd class="grid min-w-0 grid-cols-2 gap-4 text-base leading-6 sm:grid-cols-3">
                  <div class="col-span-2 sm:col-span-1"><p class="text-muted-foreground text-sm">当前资格：</p><p class="mt-1 font-semibold">{{ item.qualification?.effectiveQualification ? CURRENT_STATUS_LABELS[item.qualification.effectiveQualification.status] : item.qualification ? qualificationGroupLabel[item.qualification.group] : '未知（尚无评估结果）' }}</p></div>
                  <div><p class="text-muted-foreground text-sm">首次认定</p><p class="mt-1 font-semibold tabular-nums">{{ item.year ?? '年份待核' }}<span v-if="item.batchSeq != null" class="text-muted-foreground ml-2 text-sm font-normal">第 {{ item.batchSeq }} 批</span></p></div>
                  <div><p class="text-muted-foreground text-sm">下次复核</p><p class="mt-1 font-semibold tabular-nums">{{ item.dueYear ?? '年份待核' }}<span v-if="item.needsReview" class="text-warning ml-2 text-sm font-normal">待核</span></p></div>
                  <p class="text-muted-foreground border-t pt-2 text-sm break-words col-span-2 sm:col-span-3">评估时点：{{ item.qualification ? data?.qualificationAssessment?.asOf ?? '未知' : '未知' }}</p>
                </dd>
              </div>
            </dl>
            <p v-else class="text-muted-foreground px-4 py-6 text-[13px]">尚无正式称号记录。</p>
            <DisclosurePanel v-if="qualificationRows.length" trigger-class="px-4" class="border-t">
              <template #title>资格依据</template>
              <div class="flex min-w-0 flex-col gap-4 px-4 pb-4 text-base leading-6">
                <p class="text-muted-foreground text-sm">评估时点：{{ data?.qualificationAssessment?.asOf }}。下次复核年份用于安排复核，当前资格以下列评估为准。</p>
                <section v-for="item in qualificationRows" :key="item.titleCode" class="flex min-w-0 flex-col gap-2 break-words">
                  <h3 class="flex flex-wrap items-center gap-2"><TitleBadge :code="item.titleCode" /><span>{{ item.effectiveQualification ? CURRENT_STATUS_LABELS[item.effectiveQualification.status] : qualificationGroupLabel[item.group] }}</span></h3>
                  <p v-if="item.effectiveQualification">当前有效状态：{{ CURRENT_STATUS_LABELS[item.effectiveQualification.status] }}</p>
                  <p v-for="basis in item.effectiveQualification?.presentationBasis ?? []" :key="basis">{{ basis }}</p>
                  <template v-if="!item.effectiveQualification?.source">
                    <p>公布资格：{{ item.officialQualification.message }}</p>
                    <p v-for="note in item.officialQualification.notes" :key="note">{{ note }}</p>
                  </template>
                  <p>主体：{{ item.subject.message }}</p>
                  <p>地域：{{ item.region.message }}</p>
                  <p v-for="(cycle, index) in item.cycles" :key="index">原认定周期 {{ cycle.originYear }} 年 · {{ cycle.batchSeq == null ? '原批次未记录，未推断数字批次' : `第 ${cycle.batchSeq} 批` }}（年份精度）</p>
                </section>
              </div>
            </DisclosurePanel>
          </section>

          <PlatformRecords v-if="data" :key="id" :timeline="data.businessTimeline">
            <template #publication="{ title: selectedBusinessTitle }">
          <section class="bg-card overflow-hidden rounded-lg border" aria-label="认定与复核记录">
            <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-3">
              <h2 class="text-sm font-semibold">认定与复核记录</h2>
              <span class="text-muted-foreground text-[13px]">{{ eventCount }} 条</span>
              <span class="text-muted-foreground text-[13px]">正式公布文件与复核结论</span>
            </header>
            <div v-if="recordCount === 0" class="text-muted-foreground py-12 text-center text-sm">
              该企业暂无记录。
            </div>
            <Tabs v-else v-model="historySource" class="min-w-0">
              <TabsList aria-label="记录来源" class="mx-4 my-3">
                <TabsTrigger v-for="source in historySources" :key="source.code" :value="source.code">{{ source.label }}</TabsTrigger>
              </TabsList>
              <TabsContent v-for="source in sourceHistories" :key="source.code" :value="source.code" class="mt-0">
              <section aria-label="记录台账">
              <p v-if="!source.histories.length" class="text-muted-foreground px-4 py-8 text-sm">该来源暂无记录。</p>
              <p class="text-muted-foreground border-b px-4 py-2 text-sm">按已知年份升序；同年及未知时点不表示精确先后。排列不代表当前有效资格。</p>
              <section v-for="history in source.histories.filter(h => selectedBusinessTitle === 'all' || h.code === selectedBusinessTitle)" :key="history.code" :aria-label="`${titleLabel(history.code)}历史`" class="min-w-0 border-b last:border-b-0">
                <header class="bg-muted/40 flex flex-wrap items-baseline gap-3 border-b px-4 py-3">
                  <h3 class="text-sm font-semibold">{{ titleLabel(history.code) }}</h3>
                  <span class="text-muted-foreground text-sm">{{ history.events.length }} 条事件</span>
                </header>
                <p v-if="!history.events.length" class="text-muted-foreground px-4 py-6 text-sm">该称号暂无事件。</p>
                <ol v-else :aria-label="`${titleLabel(history.code)}事件顺序`" class="divide-y">
                  <li v-for="(event, index) in history.events" :key="event.id" class="min-w-0">
                    <p v-if="historyYear(event) == null && (index === 0 || historyYear(history.events[index - 1]!) != null)" class="bg-muted/40 text-muted-foreground border-b px-4 py-2 text-sm">年份待核 · 未知时点</p>
                    <section :id="`record-event-${event.id}`" :data-event-id="event.id" tabindex="-1" class="scroll-mt-20 px-4 py-4 sm:px-5" :data-highlighted="highlightedEventId === event.id ? 'true' : undefined">
                      <p class="flex flex-wrap items-center gap-2"><span class="font-semibold tabular-nums">{{ historyYear(event) ?? '年份待核' }}</span><EventChip :type="event.type" :hide-batch="true" /></p>
                      <p v-if="event.type === 'review'" class="mt-2">{{ eventDecisionText({ eventType: event.type, year: event.year, decidedYear: event.decidedYear, reviewOutcome: event.reviewOutcome }) }}</p>
                      <p v-if="event.seq != null" class="text-muted-foreground mt-1 text-sm">{{ event.type === 'review' ? '原认定批次' : '批次' }}：第 {{ event.seq }} 批</p>
                      <p v-if="event.type === 'nurture'" class="text-muted-foreground mt-1 text-sm">入库培育不表示已持有称号。</p>
                      <section aria-label="正式公布文件" class="mt-3 flex min-w-0 flex-col gap-3">
                        <h4 class="text-sm font-medium">正式出处</h4>
                        <p v-if="!event.evidence.length" class="text-muted-foreground text-sm">此事件未记录公布文件出处。</p>
                        <ul v-else class="grid min-w-0 gap-3 xl:grid-cols-2">
                          <li v-for="(item, index) in event.evidence" :key="item.id ?? index" class="min-w-0">
                            <OfficialEvidenceView :evidence="item" :back="previewReturnPath(event.id)" preview-in-place @preview="openPreview(item)" @page-open="rememberPagePreviewReturn(event.id, $event)" />
                          </li>
                        </ul>
                      </section>
                    </section>
                  </li>
                </ol>
              </section>
              </section>
              </TabsContent>
            </Tabs>
          </section>
            </template>
          </PlatformRecords>

      </div>
    </template>

    <!--
      预览弹窗挂在最外层,不放卡片里:弹窗是 Teleport 到 body 的,
      放在卡片内只是让它跟着卡片重建,没必要。
    -->
    <FilePreviewDialog v-model:open="previewOpen" :src="previewSrc" :name="previewName" />
  </div>
</template>
