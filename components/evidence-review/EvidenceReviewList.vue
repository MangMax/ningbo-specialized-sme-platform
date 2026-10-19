<script setup lang="ts">
import { computed, reactive, shallowRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import type { CursorPage, ImpactRow } from '~~/lib/roster/evidence-review-ui'
import { impactClassificationLabels, lineageLabels } from '~~/lib/roster/evidence-review-ui'
import { TITLES, comparisonDirectionLabel } from '~~/lib/labels'
import EvidenceReviewDetail from './EvidenceReviewDetail.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
const props = defineProps<{ enterpriseId?: number; titleCode?: string; direction?: string }>()
const draft = reactive({ enterprise: props.enterpriseId ? String(props.enterpriseId) : '', title: props.titleCode ?? '', direction: props.direction ?? '', event: '', view: 'current', state: 'pending' })
const filters = shallowRef<Record<string, string | number>>({ ...(props.enterpriseId ? { enterpriseId: props.enterpriseId } : {}), ...(props.titleCode ? { titleCode: props.titleCode } : {}), ...(props.direction ? { direction: props.direction } : {}), view: 'current', state: 'pending', limit: 25 })
const cursor = shallowRef<string | undefined>()
const cursors = shallowRef<(string | undefined)[]>([])
const selected = shallowRef<number | null>(null)
const invalid = shallowRef('')
const params = computed(() => ({ ...filters.value, ...(cursor.value ? { cursor: cursor.value } : {}) }))
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['evidence-impacts', params.value],
  query: async ({ entry }) => {
    const query = entry.key[1] as Record<string, string | number>
    const pageNumber = cursors.value.length + 1
    const page = await $fetch<CursorPage<ImpactRow>>('/api/roster/evidence-impacts', { query })
    return { ...page, request: query, pageNumber }
  }, placeholderData: previous => previous,
})
const lastSuccess = shallowRef<typeof data.value>()
watch(data, value => { if (value) lastSuccess.value = value }, { immediate: true, flush: 'sync' })
const displayed = computed(() => data.value ?? lastSuccess.value)
const cursorExpired = computed(() => (error.value as { data?: { error?: { code?: string } } })?.data?.error?.code === 'invalid_cursor')
const current = computed(() => !!data.value && JSON.stringify(data.value.request) === JSON.stringify(params.value) && !error.value && !isLoading.value)
const sourceLabel = computed(() => displayed.value ? `第 ${displayed.value.pageNumber} 页 · 企业 ${displayed.value.request.enterpriseId ?? '全部'} · ${TITLES[String(displayed.value.request.titleCode)] ?? '全部称号'} · ${displayed.value.request.direction ? comparisonDirectionLabel(String(displayed.value.request.direction)) : '全部方向'} · 事件 ${displayed.value.request.eventId ?? '全部'}` : '')
function apply() {
  if ([draft.enterprise, draft.event].some(v => v && (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))))) { invalid.value = '企业和事件 ID 须为正整数。'; return }
  invalid.value = ''; cursor.value = undefined; cursors.value = []; selected.value = null
  filters.value = { ...(draft.enterprise ? { enterpriseId: Number(draft.enterprise) } : {}), ...(draft.title ? { titleCode: draft.title } : {}), ...(draft.direction ? { direction: draft.direction } : {}), ...(draft.event ? { eventId: Number(draft.event) } : {}), view: draft.view, state: draft.state, limit: 25 }
}
watch(() => [props.enterpriseId, props.titleCode, props.direction], () => {
  draft.enterprise = props.enterpriseId ? String(props.enterpriseId) : ''; draft.title = props.titleCode ?? ''; draft.direction = props.direction ?? ''; apply()
})
function next() { if (current.value && data.value?.nextCursor) { cursors.value = [...cursors.value, cursor.value]; cursor.value = data.value.nextCursor } }
function previous() { if (current.value && cursors.value.length) { cursor.value = cursors.value.at(-1); cursors.value = cursors.value.slice(0, -1) } }
function restart() { cursor.value = undefined; cursors.value = []; void refetch() }
function enterpriseLink(row: ImpactRow) {
  const query = new URLSearchParams({ titleCode: row.titleCode, direction: row.direction, impactId: String(row.id) })
  if (displayed.value?.request.eventId) query.set('eventId', String(displayed.value.request.eventId))
  return `/enterprises/${row.enterpriseId}?${query}`
}
</script>
<template>
  <section class="relative flex min-w-0 flex-col gap-3" aria-label="解释复核清单">
    <h3 class="text-sm font-medium">解释复核清单</h3>
    <form class="flex flex-wrap items-end gap-2 [&_[data-slot=native-select-wrapper]]:max-w-full" @submit.prevent="apply">
      <label class="flex min-w-0 flex-col gap-1 text-[13px]">企业 ID<Input v-model="draft.enterprise" aria-label="企业 ID" inputmode="numeric" :disabled="enterpriseId != null" /></label>
      <label class="flex min-w-0 flex-col gap-1 text-[13px]">称号<NativeSelect v-model="draft.title" aria-label="称号筛选"><NativeSelectOption value="">全部称号</NativeSelectOption><NativeSelectOption v-for="(name, code) in TITLES" :key="code" :value="code">{{ name }}</NativeSelectOption></NativeSelect></label>
      <label class="flex min-w-0 flex-col gap-1 text-[13px]">方向<NativeSelect v-model="draft.direction" aria-label="方向筛选"><NativeSelectOption value="">全部方向</NativeSelectOption><NativeSelectOption value="missing_in_miit">应纳未纳</NativeSelectOption><NativeSelectOption value="extra_in_miit">平台多出</NativeSelectOption></NativeSelect></label>
      <label class="flex min-w-0 flex-col gap-1 text-[13px]">事件 ID<Input v-model="draft.event" aria-label="事件 ID" inputmode="numeric" /></label>
      <label class="flex min-w-0 flex-col gap-1 text-[13px]">复核状态<NativeSelect v-model="draft.state" aria-label="复核状态"><NativeSelectOption value="pending">待复核</NativeSelectOption><NativeSelectOption value="reviewed">已复核</NativeSelectOption><NativeSelectOption value="all">全部</NativeSelectOption></NativeSelect></label>
      <label class="flex min-w-0 flex-col gap-1 text-[13px]">决定范围<NativeSelect v-model="draft.view" aria-label="决定范围"><NativeSelectOption value="current">当前决定</NativeSelectOption><NativeSelectOption value="historical">历史 / 撤回 / 归并</NativeSelectOption><NativeSelectOption value="all">全部决定</NativeSelectOption></NativeSelect></label>
      <Button type="submit" variant="outline">筛选复核项</Button>
    </form>
    <p v-if="invalid" role="alert" class="text-destructive text-[13px]">{{ invalid }}</p>
    <TableLoadingStatus :loading="isLoading" kind="comparison" label="正在读取复核清单" />
    <TableFailureState v-if="error" title="复核清单读取失败" description="保留上次成功结果及其筛选范围；当前目标读取失败，可重试或从第一页重新读取。" :pending="isLoading" @retry="refetch()" />
    <p v-if="cursorExpired" role="alert" class="text-[13px]">分页快照已过期或失效。上次成功页仍保留；请点击“从第一页重新读取”获取当前清单。</p>
    <Button v-if="error" data-testid="retry-review-page" variant="outline" :disabled="isLoading" @click="refetch()">重试读取失败页</Button>
    <p v-if="displayed" class="text-muted-foreground break-words text-[13px]">显示来源：{{ sourceLabel }}</p>
    <p v-if="displayed?.projectionReady === false" role="status" class="text-[13px]">影响检查尚未完成，清单不能代表全部待复核项。</p>
    <Empty v-if="displayed && !displayed.rows.length"><EmptyHeader><EmptyTitle>本页没有复核项</EmptyTitle><EmptyDescription>清单不代替查询覆盖和业务判断；未完成影响检查的变更可能尚未进入清单。</EmptyDescription></EmptyHeader></Empty>
    <ul v-else class="flex flex-col gap-3">
      <li v-for="row in displayed?.rows ?? []" :key="row.id" class="flex min-w-0 flex-col gap-1 rounded-md border p-3 text-[13px]">
        <p v-if="row.lineage === 'merged'" class="break-words">原企业 #{{ row.enterpriseId }} · {{ TITLES[row.titleCode] ?? row.titleCode }} · {{ comparisonDirectionLabel(row.direction) }}（归并前坐标）</p>
        <NuxtLink v-else :to="enterpriseLink(row)" data-testid="review-enterprise-link" class="break-words text-primary hover:underline">企业 #{{ row.enterpriseId }} · {{ TITLES[row.titleCode] ?? row.titleCode }} · {{ comparisonDirectionLabel(row.direction) }}</NuxtLink>
        <p>{{ row.pending ? '待复核' : '已复核' }} · {{ impactClassificationLabels[row.classification] ?? row.classification }} · {{ lineageLabels[row.lineage] ?? row.lineage }} · 原决定 #{{ row.decisionId }}</p>
        <p v-if="row.oldDecision?.reasonNote" class="break-words">原决定依据：{{ row.oldDecision.reasonNote }}</p>
        <p v-if="!row.oldDecision">历史决定原文不可用；原坐标和来源仍保留。</p>
        <Button variant="outline" size="sm" class="self-start" :aria-label="`查看复核项 ${row.id}`" @click="selected = selected === row.id ? null : row.id">{{ selected === row.id ? '收起复核项' : '查看决定、来源与复核' }}</Button>
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
