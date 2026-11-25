<script setup lang="ts">
import { ROSTER_LEDGER_PATH } from '#sme-roster/lib/sme-roster/routes'
import { CURRENT_STATUS_LABELS } from '#sme-roster/lib/roster/current-status'
import { useQuery } from '@pinia/colada'
import { computed, nextTick, ref, watch } from 'vue'
import RosterEventChip from '#sme-roster/app/components/EventChip.vue'
import type { RosterEnterpriseDetail } from '#sme-roster/lib/roster/enterprise-roster'
import { titleLabel } from '#sme-roster/lib/roster/review-display'
import OfficialEvidenceView from '#sme-roster/app/components/OfficialEvidence.vue'
import { eventDecisionText, type OfficialPublishedFact } from '#sme-roster/lib/roster/official-evidence-display'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import RosterPlatformRecords from '#sme-roster/app/components/PlatformRecords.vue'
import RosterTitleBadge from '#sme-roster/app/components/TitleBadge.vue'
import { CURRENT_ENTERPRISES_TITLE, ENTERPRISE_LIST_TITLE, TITLE_ORDER } from '#sme-roster/lib/labels'
import { fileUrl, fileNameOf } from '#core/lib/preview'
import {
  hasEvidencePreviewReturn,
  rememberEvidencePreviewReturn,
  shouldNuxtScrollToTop,
  useEvidencePreviewScrollRestore,
} from '#sme-roster/lib/roster/evidence-preview-return'
import FilePreviewDialog from '#core/app/components/preview/FilePreviewDialog.vue'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import SectionCard from '#core/app/components/SectionCard.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import { Alert, AlertDescription, AlertTitle } from '#core/app/components/ui/alert'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '#core/app/components/ui/breadcrumb'
import { Button } from '#core/app/components/ui/button'
import { Skeleton } from '#core/app/components/ui/skeleton'

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
const backLabel = computed(() => typeof route.query.currentBack === 'string' ? CURRENT_ENTERPRISES_TITLE : ENTERPRISE_LIST_TITLE)

/**
 * 返回名录台账。
 *
 * 台账把「全部筛选 + 页码」都放在地址栏里,所以进企业详情时把那份筛选串
 * 作为 `back` 带过来(见 `EnterpriseDrawer` 的「完整企业页」链接)。
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
  const raw = typeof route.query.back === 'string' ? route.query.back : ''
  if (!raw) return ROSTER_LEDGER_PATH
  const query: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) query[k] = v
  return { path: ROSTER_LEDGER_PATH, query }
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

// Presentation only: all eligibility and applicability decisions come from the detail snapshot.
const qualificationRows = computed(() => data.value?.qualificationAssessment?.titles ?? [])
const assessmentTime = computed(() => data.value?.qualificationAssessment?.asOf)
const assessmentDateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZone: 'Asia/Shanghai',
})
const assessmentTimeLabel = computed(() => {
  const value = Date.parse(assessmentTime.value ?? '')
  return Number.isFinite(value) ? assessmentDateFormat.format(value).replace(/\//g, '-') : null
})
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

/** 公布记录即使没有事件，也保留其称号空状态。 */
const publicationHistories = computed(() => {
  const present = new Set(detail.value?.records.filter(record => record.source === 'jxj').map(record => record.titleCode) ?? [])
  const titles = [...TITLE_ORDER.filter(code => present.has(code)), ...[...present].filter(code => !TITLE_ORDER.includes(code))]
  return titles.map(code => ({ code, events: ledgerEvents.value.filter(event => event.source === 'jxj' && event.titleCode === code) }))
})

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
  const queryStart = route.fullPath.indexOf('?')
  const search = queryStart < 0 ? '' : route.fullPath.slice(queryStart + 1)
  const query = new URLSearchParams(search.split('#')[0])
  query.set('tab', 'records')
  query.set('eventId', String(eventId))
  return `${route.path}?${query}`
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
  if (record?.source !== 'jxj') return
  const enterpriseId = id.value
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
  if (eventId !== null && eventId === previewReturnEventId) return
  previewReturnEventId = null
  void arriveAtEvent(eventId)
}, { immediate: true })

useHead({
  title: computed(() => (detail.value ? `${detail.value.name} · 企业详情` : '企业详情')),
})

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
    <WorkspacePage
      mode="scroll"
      :title="detail?.name ?? '企业详情'"
      :busy="isLoading && !detail"
      class="gap-5"
      header-class="min-w-0 max-w-full [&_h1]:max-w-full [&_h1]:whitespace-normal [&_h1]:[overflow-wrap:anywhere]"
    >
      <template #breadcrumb>
        <Breadcrumb aria-label="当前位置">
          <BreadcrumbList>
            <BreadcrumbItem><BreadcrumbLink as-child><NuxtLink :to="backTo">{{ backLabel }}</NuxtLink></BreadcrumbLink></BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage>企业详情</BreadcrumbPage></BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </template>
      <template v-if="detail" #description>
        <span>{{ detail.district ?? '属地未知' }}</span>
        <template v-if="detail.uscc"><span class="mx-1.5">·</span><span class="font-mono text-xs break-all">{{ detail.uscc }}</span></template>
      </template>

      <!-- 加载中 -->
      <template v-if="isLoading && !detail">
        <div class="bg-card rounded-lg border p-5">
          <Skeleton class="h-6 w-56" />
          <Skeleton class="mt-3 h-4 w-full max-w-xl" />
        </div>
      </template>

      <!-- 加载失败 -->
      <Alert v-else-if="error && !detail" variant="destructive">
        <AlertTitle>未能加载企业详情</AlertTitle>
        <AlertDescription class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" @click="refetch()">重新读取企业详情</Button>
          <Button as-child variant="ghost" size="sm"><NuxtLink :to="backTo">返回{{ backLabel }}</NuxtLink></Button>
        </AlertDescription>
      </Alert>

      <template v-else-if="detail">
        <TableFailureState v-if="error" title="企业详情更新失败" description="保留上次成功的企业详情，请重试读取当前状态。" :pending="isLoading" @retry="refetch()" />

        <section v-if="confirmedAliasNames.length" aria-label="企业概况" class="min-w-0">
          <p class="text-muted-foreground text-sm leading-6">已确认曾用名：{{ confirmedAliasNames.join('、') }}</p>
        </section>

        <Alert v-if="!detail.uscc" variant="destructive">
          <AlertTitle>缺少统一社会信用代码</AlertTitle>
          <AlertDescription>记录按企业名称归并。同名企业需查阅公布名单原件核对。</AlertDescription>
        </Alert>

        <div class="flex min-w-0 flex-col gap-5">
          <!-- 称号与复核安排：只保留首屏需要的事实，不重复核对状态矩阵。 -->
          <SectionCard :padded="false" aria-label="称号与复核安排">
            <template #header>
              <h2 class="text-sm font-semibold">称号与复核安排</h2>
              <span class="text-muted-foreground text-table">评估时点：<time v-if="assessmentTimeLabel" :datetime="assessmentTime">{{ assessmentTimeLabel }}</time><span v-else>未知</span></span>
            </template>
            <dl v-if="titleInfo.length" class="divide-y">
              <div
                v-for="item in titleInfo"
                :key="item.code"
                class="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-baseline"
              >
                <dt class="min-w-0"><RosterTitleBadge :code="item.code" /></dt>
                <dd class="grid min-w-0 grid-cols-2 gap-4 text-base leading-6 sm:grid-cols-3">
                  <div class="col-span-2 sm:col-span-1"><p class="text-muted-foreground text-sm">当前资格：</p><p class="mt-1 font-semibold">{{ item.qualification?.effectiveQualification ? CURRENT_STATUS_LABELS[item.qualification.effectiveQualification.status] : item.qualification ? qualificationGroupLabel[item.qualification.group] : '未知（尚无评估结果）' }}</p></div>
                  <div><p class="text-muted-foreground text-sm">首次认定</p><p class="mt-1 font-semibold tabular-nums">{{ item.year ?? '年份待核' }}<span v-if="item.batchSeq != null" class="text-muted-foreground ml-2 text-sm font-normal">第 {{ item.batchSeq }} 批</span></p></div>
                  <div><p class="text-muted-foreground text-sm">下次复核</p><p class="mt-1 font-semibold tabular-nums">{{ item.dueYear ?? '年份待核' }}<span v-if="item.needsReview" class="text-warning ml-2 text-sm font-normal">待核</span></p></div>
                </dd>
              </div>
            </dl>
            <p v-else class="text-muted-foreground px-4 py-6 text-table">尚无正式称号记录。</p>
            <DisclosurePanel v-if="qualificationRows.length" trigger-class="px-4" class="border-t">
              <template #title>资格依据</template>
              <div class="divide-y px-4 pb-3">
                <section v-for="item in qualificationRows" :key="item.titleCode" class="py-3.5 first:pt-1 last:pb-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <RosterTitleBadge :code="item.titleCode" />
                    <span class="text-sm font-semibold">
                      {{ item.effectiveQualification ? CURRENT_STATUS_LABELS[item.effectiveQualification.status] : qualificationGroupLabel[item.group] }}
                    </span>
                  </div>
                  <dl class="mt-2.5 grid grid-cols-1 gap-x-4 gap-y-2 text-sm leading-5 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
                    <template v-if="item.effectiveQualification?.presentationBasis?.length">
                      <dt class="text-muted-foreground text-xs leading-5 sm:pt-0.5">资格依据</dt>
                      <dd class="min-w-0 space-y-1 wrap-anywhere">
                        <p v-for="basis in item.effectiveQualification.presentationBasis" :key="basis">{{ basis }}</p>
                      </dd>
                    </template>
                    <template v-if="!item.effectiveQualification?.source">
                      <dt class="text-muted-foreground text-xs leading-5 sm:pt-0.5">公布资格</dt>
                      <dd class="min-w-0 space-y-1 wrap-anywhere">
                        <p>{{ item.officialQualification.message }}</p>
                        <p v-for="note in item.officialQualification.notes" :key="note" class="text-muted-foreground text-xs leading-5">{{ note }}</p>
                      </dd>
                    </template>
                    <dt class="text-muted-foreground text-xs leading-5 sm:pt-0.5">主体</dt>
                    <dd class="min-w-0 wrap-anywhere">{{ item.subject.message }}</dd>
                    <dt class="text-muted-foreground text-xs leading-5 sm:pt-0.5">地域</dt>
                    <dd class="min-w-0 wrap-anywhere">{{ item.region.message }}</dd>
                    <template v-if="item.cycles.length">
                      <dt class="text-muted-foreground text-xs leading-5 sm:pt-0.5">原认定周期</dt>
                      <dd class="min-w-0 space-y-1 tabular-nums wrap-anywhere">
                        <p v-for="(cycle, index) in item.cycles" :key="index">
                          {{ cycle.originYear }} 年 · {{ cycle.batchSeq == null ? '原批次未记录，未推断数字批次' : `第 ${cycle.batchSeq} 批` }}<span class="text-muted-foreground text-xs">（年份精度）</span>
                        </p>
                      </dd>
                    </template>
                  </dl>
                </section>
              </div>
            </DisclosurePanel>
          </SectionCard>

          <RosterPlatformRecords v-if="data" :key="id" :timeline="data.businessTimeline">
            <template #publication="{ title: selectedBusinessTitle }">
              <section aria-label="认定与复核记录" class="min-w-0">
                <h2 class="sr-only">认定与复核记录</h2>
                <div v-if="!publicationHistories.length" class="text-muted-foreground py-8 text-center text-sm">
                  暂无公布记录。
                </div>
                <div v-else class="divide-y">
                  <p v-if="selectedBusinessTitle !== 'all' && !publicationHistories.some(history => history.code === selectedBusinessTitle)" class="text-muted-foreground py-8 text-center text-sm">该称号暂无公布记录。</p>
                  <section v-for="history in publicationHistories.filter(h => selectedBusinessTitle === 'all' || h.code === selectedBusinessTitle)" :key="history.code" :aria-label="`${titleLabel(history.code)}历史`" class="min-w-0">
                    <header class="bg-muted/35 flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
                      <h3 class="text-sm font-semibold">{{ titleLabel(history.code) }}</h3>
                      <span class="text-muted-foreground text-xs tabular-nums">{{ history.events.length }} 条事件</span>
                    </header>
                    <p v-if="!history.events.length" class="text-muted-foreground px-4 py-6 text-sm">该称号暂无事件。</p>
                    <ol v-else :aria-label="`${titleLabel(history.code)}事件顺序`" class="divide-y">
                      <li v-for="(event, index) in history.events" :key="event.id" class="min-w-0">
                        <p v-if="historyYear(event) == null && (index === 0 || historyYear(history.events[index - 1]!) != null)" class="bg-muted/30 text-muted-foreground border-b px-4 py-1.5 text-xs">年份待核 · 未知时点</p>
                        <section :id="`record-event-${event.id}`" :data-event-id="event.id" tabindex="-1" class="scroll-mt-20 px-4 py-3.5" :data-highlighted="highlightedEventId === event.id ? 'true' : undefined">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-sm font-semibold tabular-nums">{{ historyYear(event) ?? '年份待核' }}</span>
                            <RosterEventChip :type="event.type" :hide-batch="true" />
                            <span v-if="event.seq != null" class="text-muted-foreground text-xs">{{ event.type === 'review' ? '原认定批次' : '批次' }}：第 {{ event.seq }} 批</span>
                          </div>
                          <p v-if="event.type === 'review'" class="mt-1.5 text-sm leading-5">{{ eventDecisionText({ eventType: event.type, year: event.year, decidedYear: event.decidedYear, reviewOutcome: event.reviewOutcome }) }}</p>
                          <p v-if="event.type === 'nurture'" class="text-muted-foreground mt-1 text-xs">入库培育不表示已持有称号。</p>
                          <section aria-label="公布名单" class="mt-2.5 min-w-0">
                            <h4 class="sr-only">正式出处</h4>
                            <p v-if="!event.evidence.length" class="text-muted-foreground text-xs">此事件未记录公布名单出处。</p>
                            <ul v-else class="grid min-w-0 gap-2.5 xl:grid-cols-2">
                              <li v-for="(item, index) in event.evidence" :key="item.id ?? index" class="min-w-0">
                                <OfficialEvidenceView :evidence="item" :back="previewReturnPath(event.id)" @preview="openPreview(item)" @page-open="rememberPagePreviewReturn(event.id, $event)" />
                              </li>
                            </ul>
                          </section>
                        </section>
                      </li>
                    </ol>
                  </section>
                </div>
              </section>
            </template>
          </RosterPlatformRecords>
        </div>
      </template>
    </WorkspacePage>

    <!--
      预览弹窗挂在最外层,不放卡片里:弹窗是 Teleport 到 body 的,
      放在卡片内只是让它跟着卡片重建,没必要。
    -->
    <FilePreviewDialog v-model:open="previewOpen" :src="previewSrc" :name="previewName" />
  </div>
</template>
