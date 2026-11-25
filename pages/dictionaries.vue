<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useQuery, useQueryCache } from '@pinia/colada'
import { ChevronLeft, Plus } from '@lucide/vue'
import DictionaryDirectory from '../app/components/DictionaryDirectory.vue'
import DataTableCard from '#core/app/components/DataTableCard.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import TableLoadingStatus from '#core/app/components/TableLoadingStatus.vue'
import TablePagination from '#core/app/components/TablePagination.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import { Button } from '#core/app/components/ui/button'
import { CardTitle } from '#core/app/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#core/app/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '#core/app/components/ui/field'
import { Input } from '#core/app/components/ui/input'
import { Table, TableBody, TableCaption, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '#core/app/components/ui/table'
import { describeFetchError } from '#core/lib/file-content-status'
import { editableDictionaryKinds, type DictionaryEntry, type EditableDictionaryKind } from '#core/lib/dictionaries'
import type { LeadCatalog } from '../layers/lead-lists/lib/contracts'

const groups = [
  { label: '名单选项', items: [
    { id: 'list-sources', label: '名单来源' },
    { id: 'list-types', label: '名单类型' },
  ] },
  { label: '标准字典', items: [
    { id: 'regions', label: '行政区划' },
    { id: 'industries', label: '行业分类' },
    { id: 'titles', label: '认定称号' },
  ] },
  { label: '业务系列', items: [{ id: 'series', label: '名单系列' }] },
] as const
const kinds = groups.flatMap(group => [...group.items])
const route = useRoute()
const selected = computed(() => kinds.find(kind => kind.id === route.query.kind))
const current = computed(() => selected.value ?? kinds[0]!)
const active = computed(() => current.value.id)
const isNarrow = useMediaQuery('(max-width: 1023px)')
const isCompactPagination = useMediaQuery('(max-width: 1279px)')
const workspace = ref<HTMLElement>()
const optionScroll = ref<HTMLElement>()

watch(selected, (kind, previous) => {
  if (!isNarrow.value || !workspace.value) return
  const target = kind
    ? workspace.value.querySelector<HTMLElement>('#dictionary-detail-title')
    : workspace.value.querySelector<HTMLElement>(`[data-dictionary-link="${previous?.id}"]`)
      ?? workspace.value.querySelector<HTMLElement>('#dictionary-directory-search')
  target?.focus()
}, { flush: 'post' })

const label = computed(() => current.value.label)
const directorySearch = ref('')
const editable = computed(() => editableDictionaryKinds.some(kind => kind === active.value))
const hierarchical = computed(() => active.value === 'regions' || active.value === 'industries')
const hasCode = computed(() => hierarchical.value || active.value === 'titles')
const search = ref('')
const page = ref(1)
const pageSize = ref(25)
watch([active, search, pageSize], () => { page.value = 1 })
watch([active, search, page], () => {
  if (optionScroll.value) optionScroll.value.scrollTop = 0
}, { flush: 'post' })

const queryCache = useQueryCache()
const list = useQuery({
  key: () => ['dictionary', active.value] as const,
  staleTime: 0,
  query: async ({ entry }): Promise<DictionaryEntry[]> => {
    const kind = entry.key[1]
    if (kind === 'titles') return $fetch<DictionaryEntry[]>('/api/roster/dictionaries/titles')
    if (kind !== 'series') return $fetch<DictionaryEntry[]>(`/api/core/dictionaries/${kind}`)
    const { versions } = await $fetch<LeadCatalog>('/api/lead-lists/versions')
    const series = new Map<string, DictionaryEntry>()
    for (const version of versions) {
      if (!series.has(version.series)) {
        series.set(version.series, { code: String(version.id), name: version.series, detail: version.acquiredOn })
      }
    }
    return [...series.values()]
  },
})
const filtered = computed(() => {
  const term = search.value.trim().normalize('NFKC').toLowerCase()
  return (list.data.value ?? []).filter(entry =>
    !term || [entry.name, hasCode.value ? entry.code : '', entry.detail ?? ''].some(text => text.normalize('NFKC').toLowerCase().includes(term)),
  )
})
const visible = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))

const editing = ref<{ kind: EditableDictionaryKind; label: string; entry?: DictionaryEntry }>()
const name = ref('')
const saving = ref(false)
const error = ref('')
const saved = ref('')
watch(active, () => {
  search.value = ''
  saved.value = ''
})
function edit(entry?: DictionaryEntry) {
  const kind = editableDictionaryKinds.find(kind => kind === active.value)
  if (!kind) return
  name.value = entry?.name ?? ''
  error.value = ''
  saved.value = ''
  editing.value = { kind, label: label.value, entry }
}

async function save() {
  const draft = editing.value
  if (!draft || saving.value) return
  const trimmed = name.value.trim()
  if (!trimmed) {
    error.value = '请输入名称。'
    return
  }
  error.value = ''
  saving.value = true
  try {
    const result = await $fetch<DictionaryEntry>(`/api/core/dictionaries/${draft.kind}`, {
      method: 'POST',
      headers: { 'x-dictionary-browser': '1' },
      body: draft.entry ? { code: draft.entry.code, previousName: draft.entry.name, name: trimmed } : { name: trimmed },
    })
    const cached = list.data.value ?? []
    queryCache.setQueryData(['dictionary', draft.kind], [...cached.filter(entry => entry.code !== result.code), result])
    editing.value = undefined
    search.value = result.name
    saved.value = '已保存。'
    await Promise.allSettled([
      list.refetch(),
      queryCache.invalidateQueries({ key: ['lead-lists', 'versions'] }),
    ])
  } catch (cause) {
    error.value = describeFetchError(cause, '保存失败，请重试。')
  } finally {
    saving.value = false
  }
}
useHead({ title: '字典管理' })
</script>

<template>
  <WorkspacePage title="字典管理">
    <div ref="workspace" class="workspace-list-body grid flex-1 min-w-0 grid-rows-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)]">
      <DictionaryDirectory v-model="directorySearch" :groups="groups" :active="isNarrow ? selected?.id : active"
        :class="{ 'hidden lg:block': selected }" />

      <DataTableCard class="min-w-0" :class="{ 'hidden lg:flex': !selected }" toolbar-class="gap-3">
        <template #toolbar>
          <Button as-child variant="ghost" size="sm" class="-ml-2 w-fit lg:hidden">
            <NuxtLink to="/dictionaries"><ChevronLeft aria-hidden="true" />返回字典目录</NuxtLink>
          </Button>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <CardTitle id="dictionary-detail-title" as="h2" tabindex="-1" class="text-lg">{{ label }}</CardTitle>
            <Button v-if="editable" size="sm" :disabled="saving || !list.data.value" @click="edit()"><Plus aria-hidden="true" />新增选项</Button>
            <Button v-else-if="active === 'series'" as-child variant="outline" size="sm"><NuxtLink to="/lead-lists">线索名单</NuxtLink></Button>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Input v-model="search" type="search" size="sm" :aria-label="`搜索${label}条目`"
              :placeholder="hasCode ? '搜索条目名称或编码' : '搜索条目名称'" class="min-w-32 flex-1 sm:max-w-xs" />
            <span v-if="saved" role="status" class="text-sm">{{ saved }}</span>
          </div>
        </template>

        <template #status>
          <TableLoadingStatus kind="ledger" :loading="list.isLoading.value" :label="`正在读取${label}…`" />
        </template>

        <TableFailureState v-if="list.error.value" :title="`${label}加载失败`" :compact="Boolean(list.data.value)"
          :pending="list.isLoading.value" @retry="list.refetch()" />
        <div v-if="list.data.value" ref="optionScroll" role="region" aria-label="字典条目" tabindex="0" class="data-table-scroll">
          <Table class="data-table table-fixed">
            <TableCaption class="sr-only">{{ label }}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">名称</TableHead>
                <TableHead v-if="hasCode" scope="col" class="w-24 sm:w-40">编码</TableHead>
                <TableHead v-if="hierarchical" scope="col" class="w-28 sm:w-1/3">上级</TableHead>
                <TableHead v-if="active === 'series'" scope="col" class="w-32 sm:w-1/3">最近获取</TableHead>
                <TableHead v-if="editable" scope="col" class="w-24 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="entry in visible" :key="entry.code">
                <TableCell class="whitespace-normal wrap-anywhere">
                  <Button v-if="active === 'series'" as-child variant="link" class="h-auto max-w-full justify-start p-0 text-left whitespace-normal">
                    <NuxtLink :to="{ path: '/lead-lists', query: { version: entry.code } }">{{ entry.name }}</NuxtLink>
                  </Button>
                  <template v-else>{{ entry.name }}</template>
                </TableCell>
                <TableCell v-if="hasCode" class="font-mono whitespace-normal wrap-anywhere">{{ entry.code }}</TableCell>
                <TableCell v-if="hierarchical || active === 'series'" class="whitespace-normal wrap-anywhere">{{ entry.detail ?? '—' }}</TableCell>
                <TableCell v-if="editable" class="text-right">
                  <Button v-if="entry.code !== 'direct'" variant="ghost" size="sm" :aria-label="`编辑${entry.name}`"
                    :disabled="saving" @click="edit(entry)">编辑</Button>
                  <span v-else class="text-muted-foreground">系统项</span>
                </TableCell>
              </TableRow>
              <TableEmpty v-if="!visible.length" :colspan="1 + Number(hasCode) + Number(hierarchical || active === 'series') + Number(editable)">
                {{ search.trim() ? '没有匹配的选项' : '暂无字典项' }}
              </TableEmpty>
            </TableBody>
          </Table>
        </div>

        <template #footer>
          <TablePagination v-if="filtered.length > 25" v-model:page="page" v-model:page-size="pageSize" in-card :compact="isCompactPagination" unit="项" :total="filtered.length" />
        </template>
      </DataTableCard>
    </div>

    <Dialog :open="Boolean(editing)" @update:open="value => { if (!value && !saving) editing = undefined }">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ editing?.entry ? '编辑' : '新增' }}{{ editing?.label }}</DialogTitle>
          <DialogDescription v-if="editing?.entry">更新名称后，已有记录将显示新名称。</DialogDescription>
          <DialogDescription v-else class="sr-only">输入选项名称并保存。</DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-4" @submit.prevent="save">
          <Field class="gap-1.5" :data-invalid="Boolean(error)">
            <FieldLabel for="dictionary-entry-name">名称</FieldLabel>
            <Input id="dictionary-entry-name" v-model="name" maxlength="120" :disabled="saving" :aria-invalid="Boolean(error)"
              :aria-describedby="error ? 'dictionary-entry-error' : undefined" @update:model-value="error = ''" />
            <FieldError v-if="error" id="dictionary-entry-error">{{ error }}</FieldError>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" :disabled="saving" @click="editing = undefined">取消</Button>
            <Button type="submit" :disabled="saving">{{ saving ? '正在保存…' : '保存' }}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </WorkspacePage>
</template>
