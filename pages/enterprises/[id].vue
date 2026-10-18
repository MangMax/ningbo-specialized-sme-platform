<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { groupBy, orderBy, uniq } from 'es-toolkit'
import { ChevronRight, Eye } from '@lucide/vue'
import type { RosterEnterpriseDetail } from '~~/lib/roster/enterprise-roster'
import { eventDecisionText, sourceReturnTarget } from '~~/lib/roster/correspondence-view'
import RecordSourceReader from '@/components/record-correspondence/SourceReader.vue'
import EnterpriseLaterProcesses from '@/components/record-correspondence/EnterpriseLaterProcesses.vue'
import PlatformRecords from '@/components/PlatformRecords.vue'
import { TITLES, TITLE_ORDER, SOURCE_ORDER, QUALITY_FLAGS } from '~~/lib/labels'
import { fileUrl, fileNameOf, isPreviewable } from '~~/lib/preview'
import {
  EVIDENCE_PAGE_WORDS,
  evidencePageState,
  evidencePreviewHref,
  type EvidencePageState,
} from '~~/lib/roster/evidence-page'
import {
  rememberEvidencePreviewReturn,
  shouldNuxtScrollToTop,
  useEvidencePreviewScrollRestore,
} from '~~/lib/roster/evidence-preview-return'
import FilePreviewDialog from '@/components/preview/FilePreviewDialog.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
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

const focusedEventId = computed(() => typeof route.query.eventId === 'string' && /^\d+$/.test(route.query.eventId) ? Number(route.query.eventId) : null)
async function arriveAtEvent(eventId: number | null) {
  if (typeof document === 'undefined') return
  if (!detail.value || eventId == null || !detail.value.records.some(record => record.events.some(event => event.id === eventId))) return
  const enterpriseId = id.value
  setEvidenceDisclosureOpen(evidenceDisclosureKey(eventId), true)
  await nextTick()
  if (id.value !== enterpriseId || focusedEventId.value !== eventId) return
  document.getElementById(`record-event-${eventId}`)?.scrollIntoView({ block: 'center' })
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

interface TitleGroup {
  titleCode: string
  titleName: string
  records: DetailRecord[]
  /** 两个来源都有这个称号 —— 页面据此标「并列来源」并排成两列。 */
  dual: boolean
}

/** 按称号分组,组内按来源固定顺序:同一条记录的两种来源并排可比。 */
const groups = computed<TitleGroup[]>(() => {
  const records = detail.value?.records ?? []
  const byTitle = groupBy(records, (r) => r.titleCode)
  return orderBy(Object.entries(byTitle), [([code]) => rankOf(code)], ['asc']).map(
    ([titleCode, recs]) => {
      const sorted = orderBy(recs, [(r) => sourceRank(r.source)], ['asc'])
      return {
        titleCode,
        titleName: TITLES[titleCode] ?? titleCode,
        records: sorted,
        dual: uniq(sorted.map((r) => r.source)).length > 1,
      }
    },
  )
})

function rankOf(code: string) {
  const i = TITLE_ORDER.indexOf(code)
  return i === -1 ? 99 : i
}
function sourceRank(code: string) {
  const i = SOURCE_ORDER.indexOf(code)
  return i === -1 ? 99 : i
}
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

const pageStateOf = (e: Evidence): EvidencePageState => evidencePageState(e.sourceFile, e.page)

function pageWordOf(e: Evidence): string {
  const state = pageStateOf(e)
  return state === 'assigned' ? '' : EVIDENCE_PAGE_WORDS[state]
}

function pageHref(e: Evidence): string {
  return evidencePreviewHref({ sourceFile: e.sourceFile, page: e.page, back: route.fullPath })
}

function rememberPagePreviewReturn(event: MouseEvent, key: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const keys = new Set(openEvidenceKeys.value)
  keys.add(key)
  try {
    window.sessionStorage.setItem(
      EVIDENCE_DISCLOSURE_RETURN_KEY,
      JSON.stringify({ back: route.fullPath, keys: [...keys] }),
    )
  } catch {
    // Storage may be unavailable; ordinary preview navigation still works.
  }
  rememberEvidencePreviewReturn(route.fullPath, event.currentTarget)
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
          <span class="mx-1.5">·</span>共 {{ recordCount }} 条记录
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

      <!-- 称号 × 来源 -->
      <Card
        v-for="g in groups"
        :key="g.titleCode"
        class="gap-0 overflow-hidden py-0"
      >
        <CardHeader class="gap-1.5 border-b px-5 py-4">
          <!-- 来源不再写成一行文字:下面每个来源自己带方标,写两遍是重复。 -->
          <div class="flex flex-wrap items-center gap-2">
            <TitleBadge :code="g.titleCode" class="text-sm" />
            <Badge v-if="g.dual" variant="quiet">并列来源</Badge>
          </div>
        </CardHeader>
        <CardContent class="p-0">
          <!--
            并列来源要并排看:同一称号的经信局记录和工信部记录放在同一行两列,
            一眼比得出两边的事件和年份对不对得上。只有一条时占满整宽。
            两列之间只画一条竖线 —— 每个来源下面再套一层带边框的面板,
            就变成用户抱怨的「卡片套卡片」了。
          -->
          <div :class="g.records.length > 1 ? 'grid lg:grid-cols-2' : 'grid'">
            <section
              v-for="(rec, ri) in g.records"
              :key="rec.source"
              class="flex flex-col px-5 py-4"
              :class="[
                ri > 0 && 'border-t',
                ri > 0 && g.records.length > 1 && 'lg:border-t-0 lg:border-l',
              ]"
            >
            <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
              <SourceChip :code="rec.source" />
              <span class="text-muted-foreground text-xs">属地 {{ rec.district ?? '—' }}</span>
              <span class="text-muted-foreground ml-auto text-xs tabular-nums">
                {{ rec.events.length }} 个事件
              </span>
            </header>

            <ul v-if="rec.events.length" class="mt-3 flex flex-col gap-2">
              <li v-for="ev in rec.events" :id="`record-event-${ev.id}`" :key="ev.id" class="scroll-mt-20">
                <Collapsible
                  :open="evidenceDisclosureOpen(evidenceDisclosureKey(ev.id))"
                  @update:open="setEvidenceDisclosureOpen(evidenceDisclosureKey(ev.id), $event)"
                  v-slot="{ open }"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <EventChip :type="ev.type" :year="ev.year" :seq="ev.seq" :hide-batch="ev.type === 'review'" />
                    <span class="text-muted-foreground text-xs">{{ eventDecisionText({ eventType: ev.type, year: ev.year, decidedYear: ev.decidedYear, reviewOutcome: ev.reviewOutcome }) }}</span>
                    <CollapsibleTrigger as-child>
                      <Button
                        variant="ghost"
                        size="sm"
                        class="text-muted-foreground h-6 gap-1 px-1.5 text-xs"
                      >
                        <ChevronRight
                          class="size-3.5 transition-transform duration-150"
                          :class="open && 'rotate-90'"
                        />
                        {{ open ? '收起出处' : `对应事件/出处 · 文件 ${ev.evidence.length}` }}
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent class="mt-2 flex flex-col gap-1.5">
                    <h4 class="text-muted-foreground text-xs font-medium">正式公布文件</h4>
                    <p v-if="!ev.evidence.length" class="text-muted-foreground text-xs">此事件未记录文件出处。</p>
                    <div
                      v-for="(e, j) in ev.evidence"
                      :key="j"
                      class="bg-muted/60 flex flex-col gap-0.5 rounded-sm p-2 text-xs"
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="flex min-w-0 gap-2">
                          <span class="text-muted-foreground w-14 shrink-0">公布文件</span>
                          <span class="font-mono break-all">{{ e.sourceFile }}</span>
                        </div>
                        <!--
                          能预览的才给按钮。旧版 .doc 之类读不到,硬放一个按钮
                          点开只会看到「格式打不开」,不如不给。
                        -->
                        <Button
                          v-if="isPreviewable(e.sourceFile)"
                          variant="outline"
                          size="sm"
                          class="h-6 shrink-0 gap-1 px-1.5 text-xs"
                          @click="openPreview(e)"
                        >
                          <Eye class="size-3.5" />
                          预览
                        </Button>
                      </div>
                      <div v-if="e.attachment" class="flex gap-2">
                        <span class="text-muted-foreground w-14 shrink-0">附件</span>
                        <span>{{ e.attachment }}</span>
                      </div>
                      <div v-if="e.listNo != null" class="flex gap-2">
                        <span class="text-muted-foreground w-14 shrink-0">序号</span>
                        <span class="tabular-nums">{{ e.listNo }}</span>
                      </div>
                      <div class="flex gap-2">
                        <span class="text-muted-foreground w-14 shrink-0">页码</span>
                        <NuxtLink
                          v-if="pageStateOf(e) === 'assigned'"
                          :to="pageHref(e)"
                          class="text-primary tabular-nums underline underline-offset-2 hover:no-underline"
                          @click="rememberPagePreviewReturn($event, evidenceDisclosureKey(ev.id))"
                        >
                          第 {{ e.page }} 页
                        </NuxtLink>
                        <span v-else class="text-muted-foreground/70">{{ pageWordOf(e) }}</span>
                      </div>
                    </div>
                    <RecordSourceReader :kind="'event'" :id="ev.id" :return-to="sourceReturnTarget(route.query.returnTo)" />
                  </CollapsibleContent>
                </Collapsible>
              </li>
            </ul>
            <p v-else class="text-muted-foreground mt-3 text-xs">这条记录下没有事件。</p>
          </section>
          </div>
        </CardContent>
      </Card>
      <EnterpriseLaterProcesses :enterprise-id="detail.id" :return-to="sourceReturnTarget(route.query.returnTo)" />
      <Card class="gap-0 py-0">
        <CardHeader class="border-b px-5 py-4"><h2 class="text-sm font-medium">平台接口原行与反向对应</h2></CardHeader>
        <CardContent class="min-w-0 p-5"><PlatformRecords :queries="data?.platform.queries ?? []" :relations="data?.platform.relations ?? []" :return-to="sourceReturnTarget(route.query.returnTo)" @event-navigate="arriveAtEvent" /></CardContent>
      </Card>
    </template>

    <!--
      预览弹窗挂在最外层,不放卡片里:弹窗是 Teleport 到 body 的,
      放在卡片内只是让它跟着卡片重建,没必要。
    -->
    <FilePreviewDialog v-model:open="previewOpen" :src="previewSrc" :name="previewName" />
  </div>
</template>
