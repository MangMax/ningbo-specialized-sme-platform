<script setup lang="ts">
import { computed, reactive, shallowRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import type { CursorPage, ImpactRow } from '~~/lib/roster/evidence-review-ui'
import { TITLES } from '~~/lib/labels'
import { directionLabel, impactOldDecisionText, titleLabel } from '~~/lib/roster/review-display'
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

const props = defineProps<{ enterpriseId?: number; titleCode?: string; direction?: string }>()

const draft = reactive({
  enterprise: props.enterpriseId ? String(props.enterpriseId) : '',
  title: props.titleCode ?? 'all',
  direction: props.direction ?? 'all',
  event: '',
  view: 'current',
  state: 'pending',
})
const filters = shallowRef<Record<string, string | number>>({
  ...(props.enterpriseId ? { enterpriseId: props.enterpriseId } : {}),
  ...(props.titleCode ? { titleCode: props.titleCode } : {}),
  ...(props.direction ? { direction: props.direction } : {}),
  view: 'current',
  state: 'pending',
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

const params = computed(() => ({ ...filters.value, ...(cursor.value ? { cursor: cursor.value } : {}) }))
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['evidence-impacts', params.value],
  query: async ({ entry }) => {
    const query = entry.key[1] as Record<string, string | number>
    const pageNumber = cursors.value.length + 1
    const page = await $fetch<CursorPage<ImpactRow>>('/api/roster/evidence-impacts', { query })
    return { ...page, request: query, pageNumber }
  },
  placeholderData: previous => previous,
})

const lastSuccess = shallowRef<typeof data.value>()
watch(data, value => { if (value) lastSuccess.value = value }, { immediate: true, flush: 'sync' })
const displayed = computed(() => data.value ?? lastSuccess.value)
const cursorExpired = computed(() => (error.value as { data?: { error?: { code?: string } } })?.data?.error?.code === 'invalid_cursor')
const current = computed(() => !!data.value && JSON.stringify(data.value.request) === JSON.stringify(params.value) && !error.value && !isLoading.value)

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

const reviewState = computed(() => String(displayed.value?.request.state ?? filters.value.state ?? 'pending'))
const queueTitle = computed(() => reviewState.value === 'reviewed'
  ? '已复核记录'
  : reviewState.value === 'all' ? '全部复核记录' : '待复核队列')
const queueDescription = computed(() => reviewState.value === 'reviewed'
  ? '已登记复核的证据变化；保留原始变更分类，不重新标为待复核。'
  : reviewState.value === 'all'
    ? '当前、历史、撤回与归并的复核项；复核状态与原始变更分类分别显示。'
    : '按证据变化逐项核对。清单不代替查询覆盖和业务判断；未完成影响检查的变更可能尚未进入清单。')

const sourceEnterprise = computed(() => {
  const id = displayed.value?.request.enterpriseId
  if (id == null) return '全部'
  return enterpriseName.value && enterpriseName.value === nameFor(Number(id))
    ? `${enterpriseName.value}（#${id}）`
    : `企业 #${id}`
})
const sourceLabel = computed(() => displayed.value
  ? `第 ${displayed.value.pageNumber} 页 · 企业 ${sourceEnterprise.value} · ${TITLES[String(displayed.value.request.titleCode)] ?? '全部称号'} · ${displayed.value.request.direction ? directionLabel(String(displayed.value.request.direction)) : '全部方向'} · 事件 ${displayed.value.request.eventId ?? '全部'}`
  : '')

function apply() {
  if ([draft.enterprise, draft.event].some(value => value && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))))) {
    invalid.value = '企业和事件编号须为正整数。'
    return
  }
  invalid.value = ''
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

function next() { if (current.value && data.value?.nextCursor) { cursors.value = [...cursors.value, cursor.value]; cursor.value = data.value.nextCursor } }
function previous() { if (current.value && cursors.value.length) { cursor.value = cursors.value.at(-1); cursors.value = cursors.value.slice(0, -1) } }
function restart() { cursor.value = undefined; cursors.value = []; void refetch() }

function enterpriseLink(row: ImpactRow) {
  const query = new URLSearchParams({ tab: 'review', titleCode: row.titleCode, direction: row.direction, impactId: String(row.id) })
  if (displayed.value?.request.eventId) query.set('eventId', String(displayed.value.request.eventId))
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
  if (row.lineage !== 'current') return '查看历史项'
  return row.pending ? '处理这一项' : '查看复核项'
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
      <span class="text-muted-foreground text-[13px]">每页最多 25 项</span>
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
      :description="`显示上次成功的第 ${displayed?.pageNumber ?? 1} 页；当前目标读取失败，可重试或从第一页重新读取。`"
      :pending="isLoading"
      @retry="refetch()"
    />
    <p v-if="cursorExpired" role="alert" class="text-[13px] leading-5">
      分页快照已过期或失效。上次成功页仍保留；请点击“从第一页重新读取”获取当前清单。
    </p>
    <Button v-if="error" data-testid="retry-review-page" variant="outline" :disabled="isLoading" @click="refetch()">
      重试读取失败页
    </Button>
    <p v-if="displayed" class="text-muted-foreground text-[13px] leading-5 break-words">
      显示来源：{{ sourceLabel }}
    </p>
    <div v-if="hasUnavailableNames" class="flex flex-wrap items-center gap-2">
      <p class="text-muted-foreground text-[13px] leading-5">部分企业名称未能读取；企业 ID 仍保留。</p>
      <Button variant="outline" size="sm" :disabled="namesLoading" @click="retryNames">重试读取企业名称</Button>
    </div>
    <p v-if="displayed?.projectionReady === false" role="status" class="text-warning text-[13px] leading-5">
      影响检查尚未完成，清单不能代表全部待复核项。
    </p>

    <Empty v-if="displayed && !displayed.rows.length">
      <EmptyHeader>
        <EmptyTitle>本页没有复核项</EmptyTitle>
        <EmptyDescription>清单不代替查询覆盖和业务判断；未完成影响检查的变更可能尚未进入清单。</EmptyDescription>
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
              <AssessmentStatusBadge v-if="row.lineage !== 'current'" kind="lineage" :value="row.lineage" />
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
            :aria-label="`查看复核项 ${row.id}`"
            @click="selected = selected === row.id ? null : row.id"
          >
            {{ selected === row.id ? '收起复核项' : queueActionLabel(row) }}
          </Button>
        </div>
        <EvidenceReviewDetail v-if="selected === row.id" :key="row.id" :impact-id="row.id" @saved="restart" />
      </li>
    </ul>

    <footer class="flex flex-wrap items-center gap-2">
      <span class="text-muted-foreground text-[13px]">每页最多 25 项</span>
      <Button variant="outline" :disabled="!current || !cursors.length" @click="previous">上一页</Button>
      <Button variant="outline" aria-label="下一页复核项" :disabled="!current || !displayed?.nextCursor" @click="next">下一页</Button>
      <Button variant="ghost" :disabled="isLoading" @click="restart">从第一页重新读取</Button>
    </footer>
  </section>
</template>
