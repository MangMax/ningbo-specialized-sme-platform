<script setup lang="ts">
import { computed, inject, provide, reactive, shallowRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import type { CursorPage, ImpactRow } from '~~/lib/roster/evidence-review-ui'
import { TITLES } from '~~/lib/labels'
import { directionLabel, impactEffectiveLineage, impactOldDecisionText, titleLabel } from '~~/lib/roster/review-display'
import { REVIEW_DRAFTS_KEY, useReviewDrafts, type ReviewDraftStore } from '~/composables/useReviewDrafts'
import { useEnterpriseNames } from '~/composables/useEnterpriseNames'
import EvidenceReviewDetail from './EvidenceReviewDetail.vue'
import AssessmentStatusBadge from './AssessmentStatusBadge.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import DisclosurePanel from '@/components/DisclosurePanel.vue'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps<{
  enterpriseId?: number
  titleCode?: string
  direction?: string
  /** 企业详情内嵌清单默认列出全部当前与历史记录。 */
  defaultState?: 'pending' | 'reviewed' | 'all'
  defaultView?: 'current' | 'historical' | 'all'
}>()
const emit = defineEmits<{ 'guard-open': [open: boolean] }>()

/**
 * 草稿由最近一层宿主（企业详情页 / 全部复核记录父级 / 本清单）持有。
 * 结构性卸载只断开视图；明确的丢弃才清空。
 */
const injectedDrafts = inject<ReviewDraftStore | null>(REVIEW_DRAFTS_KEY, null)
const draftStore = injectedDrafts ?? useReviewDrafts()
provide(REVIEW_DRAFTS_KEY, draftStore)

const initialEnterprise = props.enterpriseId
const initialTitle = props.titleCode
const initialDirection = props.direction
const initialState = props.defaultState ?? (props.enterpriseId != null ? 'all' : 'pending')
const initialView = props.defaultView ?? (props.enterpriseId != null ? 'all' : 'current')

const draft = reactive({
  enterprise: initialEnterprise ? String(initialEnterprise) : '',
  title: initialTitle ?? 'all',
  direction: initialDirection ?? 'all',
  event: '',
  view: initialView,
  state: initialState,
})
const filters = shallowRef<Record<string, string | number>>({
  ...(initialEnterprise ? { enterpriseId: initialEnterprise } : {}),
  ...(initialTitle ? { titleCode: initialTitle } : {}),
  ...(initialDirection ? { direction: initialDirection } : {}),
  view: initialView,
  state: initialState,
  limit: 25,
})
const cursor = shallowRef<string | undefined>()
const cursors = shallowRef<(string | undefined)[]>([])
const selected = shallowRef<number | null>(null)
const invalid = shallowRef('')

const lookupTerm = shallowRef('')
const lookupResults = shallowRef<{ enterpriseId: number; name: string }[]>([])
const lookupPending = shallowRef(false)
const lookupError = shallowRef('')
const enterpriseName = shallowRef('')

const successfulReads = shallowRef(0)
const params = computed(() => ({ ...filters.value, ...(cursor.value ? { cursor: cursor.value } : {}) }))
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['evidence-impacts', params.value],
  query: async ({ entry }) => {
    const query = entry.key[1] as Record<string, string | number>
    const pageNumber = cursors.value.length + 1
    const page = await $fetch<CursorPage<ImpactRow>>('/api/roster/evidence-impacts', { query })
    successfulReads.value += 1
    return { ...page, request: query, pageNumber }
  },
  placeholderData: previous => previous,
})

const lastSuccess = shallowRef<typeof data.value>()
watch(data, value => { if (value) lastSuccess.value = value }, { immediate: true, flush: 'sync' })
const displayed = computed(() => data.value ?? lastSuccess.value)
/** 共享缓存键的页面预取也写 request；仍对旧缓存形状做只读回退，避免整块清单空白。 */
const pageRequest = computed<Record<string, string | number>>(() => displayed.value?.request ?? filters.value)
const cursorExpired = computed(() => (error.value as { data?: { error?: { code?: string } } })?.data?.error?.code === 'invalid_cursor')
const current = computed(() => !!data.value?.request && JSON.stringify(data.value.request) === JSON.stringify(params.value) && !error.value && !isLoading.value)

/**
 * 名称补全只覆盖当前显示页：去重、每页最多 25 个、并发有界，
 * 翻页时旧页的异步结果会被 generation 丢弃。
 */
const queueRows = computed(() => displayed.value?.rows ?? [])
const {
  loading: namesLoading,
  nameFor,
  unavailableFor,
  retry: retryNames,
} = useEnterpriseNames(queueRows)
const hasUnavailableNames = computed(() =>
  queueRows.value.some(row => row.lineage !== 'merged' && unavailableFor(row.enterpriseId)))

const reviewState = computed(() => String(pageRequest.value.state ?? 'pending'))
const queueTitle = computed(() => reviewState.value === 'reviewed'
  ? '已复核记录'
  : reviewState.value === 'all' ? '全部复核记录' : '待复核队列')
const queueDescription = computed(() => reviewState.value === 'reviewed'
  ? '已登记复核的证据变化；保留原始变更分类，不重新标为待复核。'
  : reviewState.value === 'all'
    ? '当前、历史、撤回与归并的复核项；复核状态与原始变更分类分别显示。'
    : '按证据变化逐项核对。清单不代替查询覆盖和业务判断；未完成影响检查的变更可能尚未进入清单。')
/**
 * 空态只说当前实际查询范围：
 * - 企业 all/all、无称号/方向/事件筛选、第 1 页、无 nextCursor、成功且投影就绪，
 *   才能说“该企业没有复核记录”；
 * - 有筛选 -> 当前筛选空；
 * - 非第 1 页 / 有 nextCursor / 保留旧页 -> 本页空；
 * - 读取失败、仍是旧页或投影未就绪 -> 尚不能确认。
 * 不用 rows.length<25 推断末页；nextCursor 才是继续翻页的依据。
 */
type ReviewEmptyScope = 'enterprise' | 'filtered' | 'page' | 'uncertain'
const hasExplicitFilter = computed(() => pageRequest.value.titleCode != null
  || pageRequest.value.direction != null
  || pageRequest.value.eventId != null)
const defaultAllScope = computed(() => pageRequest.value.state === 'all' && pageRequest.value.view === 'all')
const emptyScope = computed<ReviewEmptyScope>(() => {
  if (!current.value || error.value) return 'uncertain'
  if (displayed.value?.projectionReady === false) return 'uncertain'
  if ((displayed.value?.pageNumber ?? 1) > 1 || cursors.value.length > 0 || displayed.value?.nextCursor) return 'page'
  if (hasExplicitFilter.value || !defaultAllScope.value) return 'filtered'
  return 'enterprise'
})
const emptyTitle = computed(() => ({
  enterprise: '该企业没有复核记录',
  filtered: '当前筛选下没有复核项',
  page: '本页没有复核项',
  uncertain: '复核记录尚不能确认',
})[emptyScope.value])
const incomplete = computed(() => current.value && displayed.value?.projectionReady === false)
const readFeedback = computed(() => {
  if (isLoading.value) return displayed.value
    ? '正在重新读取清单；保留上次成功读取的内容。'
    : '正在读取复核清单。'
  if (error.value || !current.value) return ''
  const readCount = successfulReads.value ? `（第 ${successfulReads.value} 次成功读取）` : ''
  return incomplete.value
    ? `已读取清单${readCount}，${successfulReads.value > 1 ? '影响检查仍未完成' : '影响检查尚未完成'}。`
    : `已读取清单${readCount}。`
})
const incompleteDescription = '清单完整性暂不能确认；检查条件可能超出当前企业范围，不能据此认定当前企业有待处理项。请联系有权限的维护人员处理影响检查；重新读取只刷新状态，不会启动检查。'
const failureDescription = computed(() => displayed.value
  ? `保留上次成功读取的内容（第 ${displayed.value.pageNumber ?? 1} 页）；当前目标读取失败，可重试或从第一页重新读取。`
  : '尚无成功读取的清单；当前目标读取失败，请重试。')
const emptyDescription = computed(() => incomplete.value ? incompleteDescription : ({
  enterprise: '当前、历史、撤回与归并均未返回记录；未完成影响检查的变更可能尚未进入清单。',
  filtered: '当前称号、方向、复核状态或事件范围内没有记录；这不代表该企业没有其他复核历史。',
  page: '当前页没有返回记录；这不代表全企业都没有复核历史。可返回上一页或继续下一页。',
  uncertain: '当前筛选或分页尚未成功读取，或仍显示上次成功的页；不能据此判断企业的完整复核历史。',
})[emptyScope.value])

const showPager = computed(() => !!error.value
  || cursorExpired.value
  || isLoading.value
  || (displayed.value?.pageNumber ?? 1) > 1
  || cursors.value.length > 0
  || !!displayed.value?.nextCursor)

const sourceEnterprise = computed(() => {
  const id = pageRequest.value.enterpriseId
  if (id == null) return '全部企业'
  return enterpriseName.value && enterpriseName.value === nameFor(Number(id))
    ? `${enterpriseName.value}（#${id}）`
    : `企业 #${id}`
})
const sourceLabel = computed(() => displayed.value
  ? `第 ${displayed.value.pageNumber ?? 1} 页 · ${sourceEnterprise.value} · ${TITLES[String(pageRequest.value.titleCode)] ?? '全部称号'} · ${pageRequest.value.direction ? directionLabel(String(pageRequest.value.direction)) : '全部方向'} · 事件 ${pageRequest.value.eventId ?? '全部'}`
  : '')

function apply() {
  if ([draft.enterprise, draft.event].some(value => value && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))))) {
    invalid.value = '企业和事件编号须为正整数。'
    return
  }
  invalid.value = ''
  withDraftGuard(applyFilters, {
    title: '更改筛选会丢弃未提交内容',
    description: '复核依据或更正内容还没提交；收起后会丢失。',
    discardLabel: '应用筛选并丢弃',
  })
}

watch(() => [props.enterpriseId, props.titleCode, props.direction], () => {
  draft.enterprise = props.enterpriseId ? String(props.enterpriseId) : ''
  draft.title = props.titleCode ?? 'all'
  draft.direction = props.direction ?? 'all'
  apply()
})

/** 名称定位只调用现有企业总表读接口；不把名称猜测成别的企业。 */
async function lookupEnterprise() {
  const q = lookupTerm.value.trim()
  if (!q) return
  lookupPending.value = true
  lookupError.value = ''
  lookupResults.value = []
  try {
    const result = await $fetch<{ rows: { enterpriseId: number; name: string }[] }>('/api/roster/enterprises', { query: { q, pageSize: 5 } })
    lookupResults.value = result.rows ?? []
    if (!lookupResults.value.length) lookupError.value = '没有匹配的企业名称。'
  } catch {
    lookupError.value = '企业名称查找失败；可以直接填写企业 ID。'
  } finally {
    lookupPending.value = false
  }
}

function chooseEnterprise(row: { enterpriseId: number; name: string }) {
  draft.enterprise = String(row.enterpriseId)
  enterpriseName.value = row.name
  lookupTerm.value = row.name
  lookupResults.value = []
}

function guardPage(run: () => void, discardLabel: string, action: 'turn' | 'restart') {
  withDraftGuard(run, action === 'restart'
    ? {
        title: '重新读取会丢弃未提交内容',
        description: '复核依据或更正内容还没提交；收起后会丢失。',
        discardLabel,
      }
    : {
        title: '翻页会丢弃未提交内容',
        description: '复核依据或更正内容还没提交；收起后会丢失。',
        discardLabel,
      })
}
function next() { guardPage(nextPage, '下一页并丢弃', 'turn') }
function previous() { guardPage(previousPage, '上一页并丢弃', 'turn') }
function restart() { guardPage(restartPage, '重新读取并丢弃', 'restart') }

function enterpriseLink(row: ImpactRow) {
  const query = new URLSearchParams({ tab: 'review', titleCode: row.titleCode, direction: row.direction, impactId: String(row.id) })
  const eventId = pageRequest.value.eventId
  if (eventId != null) query.set('eventId', String(eventId))
  return `/enterprises/${row.enterpriseId}?${query}`
}

function queueEnterpriseLabel(row: ImpactRow): string {
  if (row.lineage === 'merged') return `原企业 #${row.enterpriseId}（归并前坐标）`
  return nameFor(row.enterpriseId) ?? `企业 #${row.enterpriseId}`
}

/** 名称读取中 / 失败的明确状态；不把 ID 冒充成企业名称。 */
function queueNameStatus(row: ImpactRow): string {
  if (row.lineage === 'merged' || nameFor(row.enterpriseId)) return ''
  return unavailableFor(row.enterpriseId) ? '名称未读取' : '名称读取中…'
}

function queueActionLabel(row: ImpactRow): string {
  if (impactEffectiveLineage(row) !== 'current') return '查看历史项'
  return row.pending ? '处理这一项' : '查看复核项'
}

function rowActionLabel(row: ImpactRow): string {
  return selected.value === row.id ? '收起复核项' : queueActionLabel(row)
}

function rowAriaLabel(row: ImpactRow): string {
  return `${rowActionLabel(row)} ${row.id}`
}

/** 收起/重选/筛选/翻页都先确认；继续填写保持原条目、原筛选、原页。 */
type DraftGuard = { title: string; description: string; discardLabel: string; run: () => void }
const pendingGuard = shallowRef<DraftGuard | null>(null)
/** 父级（route 组件）的路由离开守卫据此避让，不同时叠两个确认框。 */
watch(pendingGuard, guard => emit('guard-open', guard !== null), { immediate: true })
function withDraftGuard(run: () => void, copy: Omit<DraftGuard, 'run'>) {
  if (draftStore.hasDirty.value) {
    pendingGuard.value = { ...copy, run }
    return
  }
  run()
}
function continueDraft() { pendingGuard.value = null }
function discardDraftAndRun() {
  const guard = pendingGuard.value
  pendingGuard.value = null
  draftStore.discardAll()
  guard?.run()
}

function toggleRow(row: ImpactRow) {
  if (selected.value === row.id) {
    withDraftGuard(() => {
      selected.value = null
      draftStore.discard(row.id)
    }, {
      title: '收起会丢弃未提交内容',
      description: '复核依据或更正内容还没提交；收起后会丢失。',
      discardLabel: '收起并丢弃',
    })
    return
  }
  withDraftGuard(() => {
    if (selected.value != null) draftStore.discard(selected.value)
    selected.value = row.id
  }, {
    title: '切换复核项会丢弃未提交内容',
    description: '复核依据或更正内容还没提交；收起后会丢失。',
    discardLabel: '切换并丢弃',
  })
}

function applyFilters() {
  cursor.value = undefined
  cursors.value = []
  selected.value = null
  filters.value = {
    ...(draft.enterprise ? { enterpriseId: Number(draft.enterprise) } : {}),
    ...(draft.title !== 'all' ? { titleCode: draft.title } : {}),
    ...(draft.direction !== 'all' ? { direction: draft.direction } : {}),
    ...(draft.event ? { eventId: Number(draft.event) } : {}),
    view: draft.view,
    state: draft.state,
    limit: 25,
  }
}

function nextPage() {
  if (current.value && data.value?.nextCursor) {
    cursors.value = [...cursors.value, cursor.value]
    cursor.value = data.value.nextCursor
  }
}
function previousPage() {
  if (current.value && cursors.value.length) {
    cursor.value = cursors.value.at(-1)
    cursors.value = cursors.value.slice(0, -1)
  }
}
function restartPage() {
  cursor.value = undefined
  cursors.value = []
  // 用户明确丢弃后重新读取：先收起当前详情，避免旧表单值还留在屏上。
  selected.value = null
  void refetch()
}
/** 提交成功后的刷新只重建清单，不关闭当前详情，成功回执仍可见。 */
function refreshAfterSave() {
  cursor.value = undefined
  cursors.value = []
  void refetch()
}
</script>

<template>
  <section class="relative flex min-w-0 flex-col gap-3" aria-label="解释复核清单">
    <header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
      <div class="min-w-0">
        <h3 class="text-base font-semibold">{{ queueTitle }}</h3>
        <p class="text-muted-foreground text-[13px] leading-5">
          {{ queueDescription }}
        </p>
      </div>
    </header>

    <form class="bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-3 [&_[data-slot=native-select-wrapper]]:max-w-full" @submit.prevent="apply">
      <div class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label class="flex min-w-0 flex-col gap-1 text-[13px]">
          称号
          <Select v-model="draft.title">
            <SelectTrigger class="w-full" aria-label="称号筛选"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部称号</SelectItem>
                <SelectItem v-for="(name, code) in TITLES" :key="code" :value="code">{{ name }}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        <label class="flex min-w-0 flex-col gap-1 text-[13px]">
          方向
          <Select v-model="draft.direction">
            <SelectTrigger class="w-full" aria-label="方向筛选"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部方向</SelectItem>
                <SelectItem value="missing_in_miit">应纳未纳</SelectItem>
                <SelectItem value="extra_in_miit">平台多出</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        <label class="flex min-w-0 flex-col gap-1 text-[13px]">
          复核状态
          <Select v-model="draft.state">
            <SelectTrigger class="w-full" aria-label="复核状态"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="pending">待复核</SelectItem>
                <SelectItem value="reviewed">已复核</SelectItem>
                <SelectItem value="all">全部</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        <div class="flex min-w-0 items-end">
          <Button type="submit" variant="outline" class="w-full sm:w-auto">应用筛选</Button>
        </div>
      </div>

      <DisclosurePanel compact content-class="pb-0" class="text-[13px]">
        <template #trigger><span class="text-muted-foreground">更多筛选与名称定位</span></template>
        <div class="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label class="flex min-w-0 flex-col gap-1 text-[13px]">
            企业 ID
            <Input v-model="draft.enterprise" aria-label="企业 ID" inputmode="numeric" :disabled="enterpriseId != null" />
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-[13px]">
            事件 ID
            <Input v-model="draft.event" aria-label="事件 ID" inputmode="numeric" />
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-[13px]">
            决定范围
            <Select v-model="draft.view">
              <SelectTrigger class="w-full" aria-label="决定范围"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="current">当前决定</SelectItem>
                  <SelectItem value="historical">历史 / 撤回 / 归并</SelectItem>
                  <SelectItem value="all">全部决定</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
        </div>

        <div class="mt-3 flex min-w-0 flex-col gap-1">
          <span class="text-muted-foreground">按企业名称定位</span>
          <div class="flex min-w-0 flex-wrap gap-2">
            <Input
              v-model="lookupTerm"
              aria-label="企业名称定位"
              placeholder="输入企业名称，查找后选择"
              class="min-w-0 flex-1"
              @keydown.enter.prevent="lookupEnterprise"
            />
            <Button type="button" variant="outline" :disabled="lookupPending" @click="lookupEnterprise">
              {{ lookupPending ? '查找中…' : '查找' }}
            </Button>
          </div>
          <p v-if="lookupError" role="alert" class="text-destructive text-[13px]">{{ lookupError }}</p>
          <div v-if="lookupResults.length" class="flex flex-wrap gap-1">
            <Button
              v-for="row in lookupResults"
              :key="row.enterpriseId"
              type="button"
              size="sm"
              variant="outline"
              @click="chooseEnterprise(row)"
            >
              {{ row.name }} <span class="text-muted-foreground">#{{ row.enterpriseId }}</span>
            </Button>
          </div>
          <p v-if="enterpriseName" class="text-muted-foreground text-[13px]">
            当前企业：{{ enterpriseName }}（#{{ draft.enterprise }}）
          </p>
        </div>
      </DisclosurePanel>

      <p v-if="invalid" role="alert" class="text-destructive text-[13px]">{{ invalid }}</p>
    </form>

    <TableLoadingStatus :loading="isLoading" kind="comparison" label="正在读取复核清单" />
    <TableFailureState
      v-if="error"
      title="复核清单读取失败"
      :description="failureDescription"
      :pending="isLoading"
      @retry="refetch()"
    />
    <p v-if="cursorExpired" role="alert" class="text-[13px] leading-5">
      分页快照已过期或失效。上次成功页仍保留；请点击“从第一页重新读取”获取当前清单。
    </p>
    <Button v-if="error" data-testid="retry-review-page" variant="outline" :disabled="isLoading" @click="refetch()">
      {{ isLoading ? '正在重新读取清单…' : '重试读取失败页' }}
    </Button>
    <p v-if="displayed" class="text-muted-foreground text-[13px] leading-5 break-words">
      显示来源：{{ sourceLabel }}
    </p>
    <div v-if="hasUnavailableNames" class="flex flex-wrap items-center gap-2">
      <p class="text-muted-foreground text-[13px] leading-5">部分企业名称未能读取；企业 ID 仍保留。</p>
      <Button variant="outline" size="sm" :disabled="namesLoading" @click="retryNames">重试读取企业名称</Button>
    </div>
    <p v-if="readFeedback" role="status" aria-live="polite" aria-atomic="true" class="text-muted-foreground text-[13px] leading-5" data-testid="review-read-feedback">
      {{ readFeedback }}
    </p>
    <p v-if="incomplete && displayed?.rows.length" class="text-warning text-[13px] leading-5">
      {{ incompleteDescription }}
    </p>

    <Empty v-if="displayed && !displayed.rows.length" data-testid="review-empty">
      <EmptyHeader>
        <EmptyTitle>{{ emptyTitle }}</EmptyTitle>
        <EmptyDescription>{{ emptyDescription }}</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <ul v-else class="flex flex-col gap-2">
      <li
        v-for="row in displayed?.rows ?? []"
        :key="row.id"
        class="bg-card min-w-0 overflow-hidden rounded-lg border"
        data-testid="review-queue-item"
      >
        <div class="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5">
              <NuxtLink
                v-if="row.lineage !== 'merged'"
                :to="enterpriseLink(row)"
                data-testid="review-enterprise-link"
                class="text-primary text-sm leading-5 font-semibold break-words hover:underline"
              >
                {{ queueEnterpriseLabel(row) }}
              </NuxtLink>
              <span v-else class="text-sm leading-5 font-semibold">{{ queueEnterpriseLabel(row) }}</span>
              <!-- ID 是次要标识：名称读取成功时跟在名称后面，不替代名称。 -->
              <span
                v-if="row.lineage !== 'merged' && nameFor(row.enterpriseId)"
                class="text-muted-foreground text-[13px] font-normal"
              >#{{ row.enterpriseId }}</span>
              <!-- 复核状态是主状态；证据变化是事件类型，作为次 chip。 -->
              <AssessmentStatusBadge kind="review" :value="row.pending ? 'pending' : 'reviewed'" />
              <AssessmentStatusBadge kind="impact" :value="row.classification" />
              <span v-if="queueNameStatus(row)" class="text-muted-foreground text-[13px]">{{ queueNameStatus(row) }}</span>
              <AssessmentStatusBadge v-if="impactEffectiveLineage(row) !== 'current'" kind="lineage" :value="impactEffectiveLineage(row)" />
              <span v-else class="text-muted-foreground text-[13px]">当前决定</span>
            </div>
            <p class="mt-1 text-sm leading-5 font-medium">
              {{ titleLabel(row.titleCode) }} · {{ directionLabel(row.direction) }}
            </p>
            <p class="text-muted-foreground mt-0.5 text-[13px] leading-5">{{ impactOldDecisionText(row) }}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            class="shrink-0 self-start"
            :aria-label="rowAriaLabel(row)"
            :aria-expanded="selected === row.id"
            :aria-controls="selected === row.id ? `review-detail-${row.id}` : undefined"
            @click="toggleRow(row)"
          >
            {{ rowActionLabel(row) }}
          </Button>
        </div>
        <!--
          展开区与上方 summary 的 p-3 对齐；内边距放在嵌入侧而不是详情根节点，
          Sheet 已有 px-5，避免同一组件在抽屉里被加两层。
        -->
        <div v-if="selected === row.id" class="px-3 pb-3">
          <EvidenceReviewDetail
            :id="`review-detail-${row.id}`"
            :key="row.id"
            :impact-id="row.id"
            @saved="refreshAfterSave"
          />
        </div>
      </li>
    </ul>

    <!--
      单页、无前后页且读取成功时不再占一排翻页控件；失败、真多页或非首页
      才保留完整的上一页/下一页/重新读取。页大小说明只在这里出现一次。
    -->
    <footer v-if="showPager" class="flex flex-wrap items-center gap-2">
      <span class="text-muted-foreground text-[13px]">每页最多 25 项</span>
      <Button variant="outline" aria-label="上一页复核项" :disabled="!current || !cursors.length" @click="previous">上一页</Button>
      <Button variant="outline" aria-label="下一页复核项" :disabled="!current || !displayed?.nextCursor" @click="next">下一页</Button>
      <Button variant="ghost" :disabled="isLoading" @click="restart">{{ isLoading ? '正在重新读取清单…' : '从第一页重新读取' }}</Button>
    </footer>
    <div v-else-if="displayed" class="flex">
      <Button variant="ghost" size="sm" :disabled="isLoading" @click="restart">{{ isLoading ? '正在重新读取清单…' : '重新读取清单' }}</Button>
    </div>

    <Dialog :open="pendingGuard !== null" @update:open="value => { if (!value) pendingGuard = null }">
      <DialogContent data-testid="review-draft-dialog" class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ pendingGuard?.title }}</DialogTitle>
          <DialogDescription>{{ pendingGuard?.description }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="continueDraft">继续填写</Button>
          <Button @click="discardDraftAndRun">{{ pendingGuard?.discardLabel }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
