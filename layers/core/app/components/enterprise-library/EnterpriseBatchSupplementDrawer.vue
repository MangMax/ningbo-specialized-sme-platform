<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { Badge } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import { Field, FieldError, FieldLabel } from '#core/app/components/ui/field'
import { Input } from '#core/app/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#core/app/components/ui/sheet'
import EnterpriseDictionaryCascade from './EnterpriseDictionaryCascade.vue'
import { describeFetchError } from '#core/lib/file-content-status'
import { normalizeEnterpriseName } from '#core/lib/enterprise-name'
import { normalizeReviewedUscc, usccFormatVerdict } from '#core/lib/enterprise-uscc'
import type { DictionaryEntry } from '#core/lib/dictionaries'
import type {
  BatchCandidateMatchResponse, BatchMatchCandidate, BatchMatchEnterprise, BatchSupplementDecision,
  BatchSupplementRowInput,
} from '#core/lib/core/enterprise-batch-supplement'

const props = withDefaults(defineProps<{
  open: boolean
  title?: string
  description?: string
  rows: BatchSupplementRowInput[]
  submitting?: boolean
  submitError?: string
  submitLabel?: string
  disabled?: boolean
}>(), {
  title: '批量补充企业基础库',
  description: '逐行确认关联企业或核对新增资料。',
  submitLabel: '提交补充',
})

const emit = defineEmits<{
  'update:open': [open: boolean]
  'update:decisions': [decisions: BatchSupplementDecision[], ready: boolean]
  submit: [decisions: BatchSupplementDecision[]]
}>()

type Selection = { parent?: string; child?: string }
const filters = { all: '全部', pending: '待确认', matched: '唯一命中', create: '将新增' } as const
const reasons = { uscc: '信用代码', name: '现用名', alias: '曾用名' }
type Filter = keyof typeof filters
interface Draft {
  row: BatchSupplementRowInput
  candidates: BatchMatchCandidate[]
  selection: BatchMatchEnterprise | 'create' | null
  name: string
  uscc: string
  region?: Selection
  industry: Selection
  needsSourceReview: boolean
  editing: boolean
  searching: boolean
  searchOpen: boolean
  query: string
  searched: boolean
  searchError: string
  results: BatchMatchEnterprise[]
}

const id = useId()
const drafts = ref<Draft[]>([])
const filter = ref<Filter>('all')
const matching = ref(false)
const matchError = ref('')
const busy = computed(() => props.disabled || props.submitting)
const { data: regions, error: regionsError, refetch: retryRegions } = useQuery({
  key: ['enterprise-library', 'regions'],
  enabled: () => props.open,
  query: () => $fetch<DictionaryEntry[]>('/api/core/dictionaries/regions'),
})
const { data: industries, error: industriesError, refetch: retryIndustries } = useQuery({
  key: ['enterprise-library', 'industries'],
  enabled: () => props.open,
  query: () => $fetch<DictionaryEntry[]>('/api/core/dictionaries/industries'),
})

function select(draft: Draft, selection: Draft['selection']) {
  const enterprise = typeof selection === 'object' ? selection : null
  const source = enterprise ?? draft.row
  Object.assign(draft, {
    selection, needsSourceReview: false, name: source.name, uscc: source.uscc ?? '',
    region: enterprise ? { parent: enterprise.districtCode ?? undefined, child: enterprise.townshipCode ?? undefined } : undefined,
    industry: { child: enterprise?.industryCode ?? undefined },
    editing: selection === 'create' && draft.candidates.length > 1,
  })
}

function rowRegion(draft: Draft): Selection {
  if (draft.region) return draft.region
  const matches = regions.value?.filter(item => item.level === 2 && item.name === draft.row.district)
  return { parent: matches?.length === 1 ? matches[0]?.code : undefined }
}

let matchRequest: AbortController | undefined
async function match() {
  matchRequest?.abort()
  const request = new AbortController()
  matchRequest = request
  const rows = props.rows
  if (!props.open || !rows.length) return
  matching.value = true
  matchError.value = ''
  try {
    const response = await $fetch<BatchCandidateMatchResponse>('/api/core/enterprises/match-candidates', {
      method: 'POST', signal: request.signal,
      body: { rows: rows.map(({ key, name, uscc }) => ({ key, name, uscc })) },
    })
    if (request.signal.aborted) return
    const matches = new Map(response.rows.map(row => [row.key, row]))
    drafts.value = rows.map(row => {
      const result = matches.get(row.key)
      const draft: Draft = {
        row, candidates: result?.candidates ?? [], selection: null, name: '', uscc: '',
        industry: {}, needsSourceReview: false, editing: false, searching: false, searchOpen: false, query: row.name || row.uscc || '',
        searched: false, searchError: '', results: [],
      }
      select(draft, result?.status === 'matched' ? result.candidates[0] ?? null : result?.status === 'unmatched' ? 'create' : null)
      const sourceCode = normalizeReviewedUscc(row.uscc ?? '')
      draft.needsSourceReview = result?.status === 'matched' &&
        (!normalizeEnterpriseName(row.name) || (!!sourceCode && usccFormatVerdict(sourceCode) !== 'ok'))
      return draft
    })
  } catch (cause) {
    if (!request.signal.aborted) matchError.value = describeFetchError(cause, '预匹配失败，请重试。')
  } finally {
    if (!request.signal.aborted) matching.value = false
  }
}

watch(() => props.open ? JSON.stringify(props.rows) : null, (current, _previous, onCleanup) => {
  drafts.value = []
  filter.value = 'all'
  matching.value = false
  matchError.value = ''
  if (current !== null) void match()
  onCleanup(() => matchRequest?.abort())
}, { immediate: true })

async function find(draft: Draft) {
  const query = draft.query.trim()
  if (!query || draft.searching || busy.value) return
  draft.searching = true
  draft.searchError = ''
  try {
    const code = normalizeReviewedUscc(query)
    const criteria = /^[A-Z0-9]{18}$/.test(code) ? { uscc: code } : { name: query }
    const result = await $fetch<{ rows: BatchMatchEnterprise[] }>('/api/core/enterprises', { query: { ...criteria, limit: 25 } })
    draft.results = result.rows
    draft.searched = true
  } catch (cause) {
    draft.searchError = describeFetchError(cause, '查询失败，请重试。')
  } finally {
    draft.searching = false
  }
}

function pickResult(draft: Draft, value: unknown) {
  const enterprise = draft.results.find(item => String(item.id) === value)
  if (enterprise) {
    select(draft, enterprise)
    draft.searchOpen = false
  }
}

function review(draft: Draft) {
  const name = draft.name.trim()
  const uscc = normalizeReviewedUscc(draft.uscc) || null
  const invalidName = !normalizeEnterpriseName(name) || name.length > 300 || !name.isWellFormed() || name.includes('\0')
  const invalidUscc = !!uscc && usccFormatVerdict(uscc) !== 'ok'
  const { selection, row } = draft
  let decision: BatchSupplementDecision | undefined
  if (selection && !invalidName && !invalidUscc && !draft.needsSourceReview) {
    const region = rowRegion(draft)
    const fields = {
      name, uscc, districtCode: region.parent ?? null, townshipCode: region.child ?? null,
      industryCode: draft.industry.child ?? null,
    }
    if (selection === 'create') {
      decision = { key: row.key, action: 'create', fields }
    } else {
      decision = { key: row.key, action: 'attach', enterpriseId: selection.id, expectedRevision: selection.revision, fields: {
        name: name === selection.name.trim() ? undefined : name,
        uscc: uscc === (normalizeReviewedUscc(selection.uscc ?? '') || null) ? undefined : uscc,
        districtCode: fields.districtCode === selection.districtCode ? undefined : fields.districtCode,
        townshipCode: fields.townshipCode === selection.townshipCode ? undefined : fields.townshipCode,
        industryCode: fields.industryCode === selection.industryCode ? undefined : fields.industryCode,
      } }
    }
  }
  const category: Exclude<Filter, 'all'> = !decision ? 'pending' : decision.action === 'create' ? 'create' : 'matched'
  const matchReasons = draft.candidates.find(candidate => typeof selection === 'object' && candidate.id === selection?.id)?.matchReasons
  return { draft, decision, category, invalidName, invalidUscc, matchReasons }
}

const reviewed = computed(() => drafts.value.map(review))
const decisions = computed(() => reviewed.value.flatMap(item => item.decision ? [item.decision] : []))
const ready = computed(() => props.open && !matching.value && !matchError.value &&
  props.rows.length > 0 && decisions.value.length === props.rows.length)
const hasDistrictDefaults = computed(() => drafts.value.some(draft =>
  draft.selection === 'create' && !draft.region && draft.row.district))
const readyToSubmit = computed(() => ready.value && (!hasDistrictDefaults.value || !!regions.value))
watch([decisions, readyToSubmit], ([value, complete]) => emit('update:decisions', value, complete), { immediate: true })

function close() {
  if (!props.submitting) emit('update:open', false)
}
</script>

<template>
  <Sheet :open="open" @update:open="value => { if (!value) close() }">
    <SheetContent floating-size="detail" class="gap-0" :show-close-button="!submitting">
      <SheetHeader class="shrink-0 border-b pr-12">
        <SheetTitle>{{ title }}</SheetTitle>
        <SheetDescription>{{ description }}</SheetDescription>
        <slot name="header-extra" />
      </SheetHeader>

      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
        <p v-if="matching" role="status" class="text-sm text-muted-foreground">正在精确匹配企业…</p>
        <div v-else-if="matchError" class="space-y-2">
          <FieldError role="alert">{{ matchError }}</FieldError>
          <Button variant="outline" :disabled="busy" @click="match">重试预匹配</Button>
        </div>
        <p v-else-if="!rows.length" class="text-sm text-muted-foreground">没有待补充的名单行。</p>
        <template v-else>
          <nav aria-label="筛选名单行" class="flex flex-wrap gap-1">
            <Button v-for="(label, value) in filters" :key="value" size="sm"
              :variant="filter === value ? 'secondary' : 'ghost'" :aria-pressed="filter === value"
              @click="filter = value">{{ label }}</Button>
          </nav>
          <div v-if="regionsError || industriesError" class="flex flex-wrap gap-2">
            <Button v-if="regionsError" variant="outline" size="sm" :disabled="busy" @click="retryRegions()">重试加载区划</Button>
            <Button v-if="industriesError" variant="outline" size="sm" :disabled="busy" @click="retryIndustries()">重试加载行业</Button>
          </div>
          <p v-if="!reviewed.some(item => filter === 'all' || item.category === filter)" class="text-sm text-muted-foreground">此筛选下没有名单行。</p>
          <article v-for="({ draft, decision, category, invalidName, invalidUscc, matchReasons }, index) in reviewed" v-show="filter === 'all' || category === filter"
            :key="draft.row.key" class="min-w-0 space-y-3 rounded-lg border p-3">
            <div class="flex items-start justify-between gap-2">
              <h3 class="min-w-0 wrap-anywhere text-sm font-medium">{{ draft.row.label || draft.row.name || '未填写企业名称' }}</h3>
              <Badge class="shrink-0" :variant="category === 'pending' ? 'outline' : 'secondary'">{{ filters[category] }}</Badge>
            </div>
            <p v-for="(detail, detailIndex) in [draft.row.uscc, draft.row.district, draft.row.businessSummary, draft.row.note].filter(Boolean)"
              :key="detailIndex" class="wrap-anywhere text-sm text-muted-foreground">{{ detail }}</p>
            <slot name="row-extra" :row="draft.row" :decision="decision" />

            <fieldset v-if="draft.candidates.length > 1" :disabled="busy" class="min-w-0 space-y-2 text-sm">
              <legend class="mb-1 font-medium">选择匹配企业</legend>
              <label v-for="candidate in draft.candidates" :key="candidate.id" class="flex items-start gap-2">
                <input type="radio" class="mt-1 shrink-0" :name="`${id}-candidate-${index}`"
                  :checked="draft.selection !== 'create' && draft.selection?.id === candidate.id" @change="select(draft, candidate)">
                <span class="min-w-0 wrap-anywhere">{{ candidate.name }} · {{ candidate.uscc || '未登记信用代码' }} ·
                  {{ candidate.matchReasons.map(reason => reasons[reason]).join('、') }}</span>
              </label>
              <label class="flex gap-2">
                <input type="radio" :name="`${id}-candidate-${index}`" :checked="draft.selection === 'create'" @change="select(draft, 'create')">
                都不是，新增企业
              </label>
            </fieldset>

            <div v-if="draft.selection && draft.selection !== 'create'" class="wrap-anywhere text-sm">
              关联 {{ draft.selection.name }} · {{ draft.selection.uscc || '未登记信用代码' }}
              <span v-if="matchReasons" class="text-muted-foreground">
                · {{ matchReasons.map(reason => reasons[reason]).join('、') }}
              </span>
            </div>
            <FieldError v-if="draft.selection && invalidName">请输入有效的企业名称。</FieldError>
            <FieldError v-if="draft.selection && invalidUscc">请输入有效的统一社会信用代码。</FieldError>
            <FieldError v-if="draft.needsSourceReview">来源名称或信用代码需要核对，请确认关联主体。</FieldError>
            <div class="flex flex-wrap gap-2">
              <Button v-if="draft.needsSourceReview" size="sm" variant="outline" :disabled="busy"
                @click="draft.needsSourceReview = false">确认关联</Button>
              <Button v-if="draft.selection === 'create' && draft.candidates.length === 1 && draft.candidates[0]" size="sm" variant="outline"
                :disabled="busy" @click="select(draft, draft.candidates[0])">关联匹配企业</Button>
              <Button v-if="draft.selection" size="sm" variant="outline" :disabled="busy" :aria-expanded="draft.editing"
                @click="draft.editing = !draft.editing">{{ draft.editing ? '收起资料' : '编辑资料' }}</Button>
              <Button v-if="draft.selection !== 'create' && draft.candidates.length <= 1" size="sm" variant="outline" :disabled="busy"
                @click="select(draft, 'create')">新增企业</Button>
              <Button size="sm" variant="outline" :disabled="busy" :aria-expanded="draft.searchOpen"
                @click="draft.searchOpen = !draft.searchOpen">{{ draft.searchOpen ? '收起查询' : '手动查询企业' }}</Button>
            </div>

            <form v-if="draft.searchOpen" class="space-y-2" @submit.prevent="find(draft)">
              <Field>
                <FieldLabel :for="`${id}-query-${index}`">企业名称或统一社会信用代码</FieldLabel>
                <div class="flex gap-2">
                  <Input :id="`${id}-query-${index}`" v-model="draft.query" type="search" :disabled="busy || draft.searching" />
                  <Button type="submit" variant="outline" :disabled="busy || draft.searching || !draft.query.trim()">{{ draft.searching ? '查询中…' : '查询' }}</Button>
                </div>
              </Field>
              <FieldError v-if="draft.searchError" role="alert">{{ draft.searchError }}</FieldError>
              <Field v-if="draft.results.length">
                <FieldLabel :for="`${id}-result-${index}`">查询结果</FieldLabel>
                <Select :disabled="busy || draft.searching" @update:model-value="value => pickResult(draft, value)">
                  <SelectTrigger :id="`${id}-result-${index}`" class="w-full min-w-0"><SelectValue placeholder="选择关联企业" /></SelectTrigger>
                  <SelectContent class="w-(--reka-select-trigger-width) max-w-(--reka-select-content-available-width)">
                    <SelectItem v-for="item in draft.results" :key="item.id" :value="String(item.id)">
                      <span class="wrap-anywhere">{{ item.name }} · {{ item.uscc || '未登记信用代码' }}</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <p v-else-if="draft.searched && !draft.searchError" role="status" class="text-sm text-muted-foreground">未查到企业。</p>
            </form>

            <div v-if="draft.editing" class="grid min-w-0 gap-3 sm:grid-cols-2">
              <Field class="min-w-0 sm:col-span-2">
                <FieldLabel :for="`${id}-name-${index}`">企业名称</FieldLabel>
                <Input :id="`${id}-name-${index}`" v-model="draft.name" :disabled="busy" :aria-invalid="invalidName" maxlength="300" />
              </Field>
              <Field class="min-w-0 sm:col-span-2">
                <FieldLabel :for="`${id}-uscc-${index}`">统一社会信用代码</FieldLabel>
                <Input :id="`${id}-uscc-${index}`" v-model="draft.uscc" :disabled="busy" :aria-invalid="invalidUscc"
                  maxlength="80" autocapitalize="characters" autocorrect="off" :spellcheck="false" />
              </Field>
              <Field class="min-w-0">
                <FieldLabel :for="`${id}-region-${index}`">区划</FieldLabel>
                <EnterpriseDictionaryCascade :id="`${id}-region-${index}`" :model-value="rowRegion(draft)"
                  label="区划" kind="region" :entries="regions" :disabled="busy"
                  empty-label="未登记" parent-label="仅选此区县" @update:model-value="value => draft.region = value" />
              </Field>
              <Field class="min-w-0">
                <FieldLabel :for="`${id}-industry-${index}`">行业</FieldLabel>
                <EnterpriseDictionaryCascade :id="`${id}-industry-${index}`" v-model="draft.industry"
                  label="行业" kind="industry" :entries="industries" :disabled="busy" empty-label="未登记" />
              </Field>
            </div>
          </article>
        </template>
      </div>

      <footer class="shrink-0 space-y-2 border-t bg-surface-sunken/40 px-4 py-3">
        <FieldError v-if="submitError" role="alert">{{ submitError }}</FieldError>
        <slot name="footer-extra" :decisions="decisions" :ready="readyToSubmit" />
        <div class="flex flex-wrap justify-end gap-2">
          <slot name="footer-actions" :decisions="decisions" :ready="readyToSubmit && !disabled" :submitting="submitting">
            <Button variant="outline" :disabled="submitting" @click="close">取消</Button>
            <Button :disabled="busy || !readyToSubmit" @click="emit('submit', decisions)">{{ submitting ? '正在提交…' : submitLabel }}</Button>
          </slot>
        </div>
      </footer>
    </SheetContent>
  </Sheet>
</template>
