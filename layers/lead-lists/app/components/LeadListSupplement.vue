<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import { Button } from '#core/app/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#core/app/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '#core/app/components/ui/field'
import { Input } from '#core/app/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'
import EnterpriseDictionaryCascade from '#core/app/components/enterprise-library/EnterpriseDictionaryCascade.vue'
import { describeFetchError } from '#core/lib/file-content-status'
import { normalizeReviewedUscc, usccFormatVerdict } from '#core/lib/enterprise-uscc'
import type { EnterpriseLibraryDetails } from '#core/lib/core/enterprise-library'
import type { DictionaryEntry } from '#core/lib/dictionaries'
import type { LeadRow } from '../../lib/contracts'

const props = defineProps<{ row: LeadRow | null; versionId?: number }>()
const emit = defineEmits<{ close: []; saved: [] }>()
type CascadeSelection = { parent?: string; child?: string }

const queryCache = useQueryCache()
const action = ref('attach')
const query = ref('')
const results = ref<EnterpriseLibraryDetails[]>([])
const matchedQuery = ref('')
const enterpriseId = ref('')
const selected = computed(() => results.value.find(item => String(item.id) === enterpriseId.value))
const endpoint = computed(() => `/api/lead-lists/versions/${props.versionId}/supplement`)
const name = ref('')
const uscc = ref('')
const region = ref<CascadeSelection>({})
const industry = ref<CascadeSelection>({})
const searching = ref(false)
const saving = ref(false)
const searchError = ref('')
const error = ref('')
const invalidUscc = ref(false)
const { data: regions, error: regionsError, refetch: retryRegions } = useQuery({
  key: ['enterprise-library', 'regions'],
  enabled: () => Boolean(props.row),
  query: () => $fetch<DictionaryEntry[]>('/api/core/dictionaries/regions'),
})
const { data: industries, error: industriesError, refetch: retryIndustries } = useQuery({
  key: ['enterprise-library', 'industries'],
  enabled: () => Boolean(props.row),
  query: () => $fetch<DictionaryEntry[]>('/api/core/dictionaries/industries'),
})

function resetFields() {
  const source = action.value === 'attach' ? selected.value : props.row
  name.value = source?.name ?? ''
  uscc.value = source?.uscc ?? ''
  region.value = { parent: selected.value?.districtCode ?? undefined, child: selected.value?.townshipCode ?? undefined }
  industry.value = { child: selected.value?.industryCode ?? undefined }
  if (action.value === 'create') {
    const matches = regions.value?.filter(item => item.level === 2 && item.name === props.row?.district)
    region.value = { parent: matches?.length === 1 ? matches[0]?.code : undefined }
    industry.value = {}
  }
  error.value = ''
  invalidUscc.value = false
}

watch(() => props.row, row => {
  action.value = 'attach'
  query.value = row?.name ?? ''
  enterpriseId.value = matchedQuery.value = searchError.value = ''
  results.value = []
  resetFields()
})
watch([action, selected], resetFields)
async function find() {
  const text = query.value.trim()
  if (!props.row || !text || searching.value || saving.value) return
  const rowId = props.row.id
  searching.value = true
  searchError.value = ''
  error.value = ''
  try {
    const code = normalizeReviewedUscc(text)
    const filter = /^[A-Z0-9]{18}$/.test(code) ? { uscc: code } : { name: text }
    const response = await $fetch<{ rows: EnterpriseLibraryDetails[] }>('/api/core/enterprises', { query: { ...filter, limit: 25 } })
    if (props.row?.id !== rowId || text !== query.value.trim()) return
    results.value = response.rows
    matchedQuery.value = text
    enterpriseId.value = ''
  } catch (cause) {
    searchError.value = describeFetchError(cause, '查询失败，请重试。')
  } finally {
    searching.value = false
  }
}

function searchOnEnter(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  void find()
}

function fieldValues() {
  const existing = action.value === 'attach' ? selected.value : undefined
  const reviewedCode = normalizeReviewedUscc(uscc.value) || null
  return {
    name: name.value.trim() === existing?.name ? undefined : name.value.trim(),
    uscc: reviewedCode === (existing?.uscc ? normalizeReviewedUscc(existing.uscc) : null) ? undefined : reviewedCode,
    districtCode: (region.value.parent ?? null) === (existing?.districtCode ?? null) ? undefined : region.value.parent ?? null,
    townshipCode: (region.value.child ?? null) === (existing?.townshipCode ?? null) ? undefined : region.value.child ?? null,
    industryCode: (industry.value.child ?? null) === (existing?.industryCode ?? null) ? undefined : industry.value.child ?? null,
  }
}

async function save() {
  if (saving.value || searching.value || !props.row || !props.versionId) return
  const fields = fieldValues()
  if (fields.uscc && usccFormatVerdict(fields.uscc) !== 'ok') {
    invalidUscc.value = true
    await nextTick()
    document.getElementById('lead-enterprise-uscc')?.focus()
    return
  }
  const existing = selected.value
  const decision = action.value === 'create'
    ? { action: 'create', rowId: props.row.id, fields }
    : existing && { action: 'attach', rowId: props.row.id, enterpriseId: existing.id, expectedRevision: existing.revision, fields }
  if (!decision) {
    error.value = '请选择要关联的企业。'
    return
  }
  error.value = ''
  saving.value = true
  try {
    const result = await $fetch<{ rows: { enterpriseId: number }[] }>(endpoint.value, {
      method: 'POST', headers: { 'X-Lead-List-Browser': '1' }, body: { decisions: [decision] },
    })
    const id = result.rows[0]?.enterpriseId
    void queryCache.invalidateQueries({ key: ['enterprise-library', 'results'] })
    if (id !== undefined) {
      void queryCache.invalidateQueries({ key: ['enterprise-library', 'sources', id] })
      void queryCache.invalidateQueries({ key: ['enterprise-library', 'details', id] })
    }
    emit('saved')
  } catch (cause) {
    const code = (cause as { data?: { data?: { code?: string } } })?.data?.data?.code
    const messages: Record<string, string> = {
      existing_subject: '该企业已在基础库，请切换到「关联已有企业」。',
      enterprise_changed: '企业资料已变更，请重新查询后再提交。',
      uscc_taken: '该信用代码已由另一家企业使用，请核对后重试。',
      identity_conflict: '该企业名称已由另一家企业使用，请核对后重试。',
    }
    error.value = (code && messages[code]) || describeFetchError(cause, '补充失败，请重试。')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog :open="Boolean(row)" @update:open="value => { if (!value && !saving) emit('close') }">
    <DialogContent class="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl" :show-close-button="!saving">
      <DialogHeader class="shrink-0 border-b px-4 py-4 pr-12 text-left sm:px-6 sm:pr-12">
        <DialogTitle>补充企业基础库</DialogTitle>
        <DialogDescription class="wrap-anywhere">{{ row?.name }}</DialogDescription>
      </DialogHeader>
      <form :action="endpoint" method="post" aria-label="补充企业基础库" class="flex min-h-0 flex-col" @submit.prevent="save">
        <div class="min-h-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          <Tabs v-model="action">
            <TabsList class="grid w-full grid-cols-2" aria-label="补充方式">
              <TabsTrigger value="attach" :disabled="saving">关联已有企业</TabsTrigger>
              <TabsTrigger value="create" :disabled="saving">新增企业</TabsTrigger>
            </TabsList>
            <TabsContent :key="action" :value="action" class="min-w-0">
              <FieldGroup v-if="action === 'attach'" class="gap-3 pt-3">
                <Field class="gap-1.5">
                  <FieldLabel for="lead-enterprise-query">企业名称或统一社会信用代码</FieldLabel>
                  <div class="flex items-center gap-2">
                    <Input id="lead-enterprise-query" v-model="query" name="query" type="search" :disabled="saving || searching" @keydown.enter="searchOnEnter" />
                    <Button type="button" variant="outline" :disabled="!query.trim() || saving || searching" @click="find">{{ searching ? '查询中…' : '查询' }}</Button>
                  </div>
                  <FieldError v-if="searchError" role="alert">{{ searchError }}</FieldError>
                </Field>
                <Field v-if="results.length" class="gap-1.5">
                  <FieldLabel for="lead-enterprise-result">选择企业</FieldLabel>
                  <Select v-model="enterpriseId" name="enterpriseId" :disabled="saving || searching">
                    <SelectTrigger id="lead-enterprise-result" class="w-full min-w-0 *:data-[slot=select-value]:min-w-0"><SelectValue placeholder="从查询结果选择" /></SelectTrigger>
                    <SelectContent class="w-(--reka-select-trigger-width) max-w-(--reka-select-content-available-width)">
                      <SelectGroup>
                        <SelectItem v-for="item in results" :key="item.id" :value="String(item.id)">
                          <span class="min-w-0 wrap-anywhere">{{ item.name }}<span v-if="item.uscc"> · {{ item.uscc }}</span></span>
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <p v-else-if="matchedQuery && !searchError" class="text-muted-foreground text-sm" role="status">未查到匹配企业，可切换到「新增企业」。</p>
              </FieldGroup>
              <FieldGroup v-if="action === 'create' || selected" class="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <Field class="gap-1.5 sm:col-span-2">
                  <FieldLabel for="lead-enterprise-name">企业名称</FieldLabel>
                  <Input id="lead-enterprise-name" v-model="name" name="name" required :maxlength="300" :disabled="saving || searching" />
                </Field>
                <Field class="gap-1.5 sm:col-span-2">
                  <FieldLabel for="lead-enterprise-uscc">统一社会信用代码</FieldLabel>
                  <Input
                    id="lead-enterprise-uscc" v-model="uscc" name="uscc" :maxlength="80" :disabled="saving || searching"
                    autocapitalize="characters" autocorrect="off" :spellcheck="false"
                    :aria-invalid="invalidUscc || undefined" :aria-describedby="invalidUscc ? 'lead-uscc-error' : undefined"
                    @update:model-value="invalidUscc = false"
                  />
                  <FieldError v-if="invalidUscc" id="lead-uscc-error" role="alert">请输入有效的统一社会信用代码。</FieldError>
                </Field>
                <Field class="min-w-0 gap-1.5">
                  <FieldLabel for="lead-enterprise-region">区划</FieldLabel>
                  <EnterpriseDictionaryCascade
                    id="lead-enterprise-region" v-model="region" label="区划" kind="region" :entries="regions"
                    empty-label="未登记" parent-label="仅选此区县" :disabled="saving || searching"
                  />
                  <Button v-if="regionsError" type="button" variant="outline" size="sm" @click="retryRegions()">重试加载区划</Button>
                </Field>
                <Field class="min-w-0 gap-1.5">
                  <FieldLabel for="lead-enterprise-industry">行业</FieldLabel>
                  <EnterpriseDictionaryCascade
                    id="lead-enterprise-industry" v-model="industry" label="行业" kind="industry" :entries="industries"
                    empty-label="未登记" :disabled="saving || searching"
                  />
                  <Button v-if="industriesError" type="button" variant="outline" size="sm" @click="retryIndustries()">重试加载行业</Button>
                </Field>
              </FieldGroup>
            </TabsContent>
          </Tabs>
          <FieldError v-if="error" class="mt-3" role="alert">{{ error }}</FieldError>
        </div>
        <DialogFooter class="shrink-0 flex-row justify-end border-t px-4 py-3 sm:px-6">
          <Button type="button" variant="outline" :disabled="saving" @click="emit('close')">取消</Button>
          <Button type="submit" :disabled="saving || searching">{{ saving ? '正在保存…' : action === 'create' ? '新增并关联' : '保存并关联' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
