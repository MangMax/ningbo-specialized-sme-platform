<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { useQuery } from '@pinia/colada'
import { Search } from '@lucide/vue'
import { TITLES } from '~~/lib/labels'
import { CURRENT_TITLES, type CurrentTitle } from '~~/lib/roster/current-titles'
import type { CurrentRow } from '~~/lib/roster/current-qualification'
import { NINGBO_DISTRICTS, NINGBO_INDEPENDENT_ZONES } from '~~/lib/domain'
import { captureQueryRequest, useRetainedQuerySnapshot } from '~/composables/useRetainedQuerySnapshot'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import PageHeader from '@/components/PageHeader.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import TablePagination from '@/components/TablePagination.vue'

const route = useRoute(), router = useRouter()
const one = (value: unknown) => typeof value === 'string' ? value : ''
const positive = (value: unknown, fallback: number) => /^\d+$/.test(one(value)) && Number(one(value)) >= 1 ? Number(one(value)) : fallback
const title = computed<CurrentTitle>(() => CURRENT_TITLES.find(code => code === route.query.titleCode) ?? 'little_giant')
const q = computed(() => one(route.query.q))
const district = computed(() => one(route.query.district))
const sort = computed(() => ['id_asc', 'name_asc', 'name_desc'].includes(one(route.query.sort)) ? one(route.query.sort) as 'id_asc' | 'name_asc' | 'name_desc' : 'id_asc')
const page = computed(() => positive(route.query.page, 1))
const pageSize = computed(() => Math.min(200, positive(route.query.pageSize, 25)))
const search = shallowRef(q.value)
watch(q, value => { search.value = value })
watchDebounced(search, value => { if (value.trim() !== q.value) update({ q: value.trim() || undefined, page: undefined }) }, { debounce: 300 })

function update(changes: Record<string, string | undefined>) {
  const next: Record<string, string | undefined> = Object.fromEntries(Object.entries(route.query).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
  Object.assign(next, { titleCode: title.value }, changes)
  for (const [key, value] of Object.entries(next)) if (value == null || value === '') delete next[key]
  void router.replace({ path: route.path, query: next })
}
const titleModel = computed({ get: () => title.value, set: (value: string) => update({ titleCode: value, page: undefined }) })
const districtModel = computed({ get: () => district.value || 'all', set: (value: string) => update({ district: value === 'all' ? undefined : value, page: undefined }) })
const sortModel = computed({ get: () => sort.value, set: (value: string) => update({ sort: value === 'id_asc' ? undefined : value, page: undefined }) })
const params = computed(() => ({ titleCode: title.value, q: q.value || undefined, district: district.value || undefined, sort: sort.value, page: page.value, pageSize: pageSize.value }))
const activeRequest = computed(() => captureQueryRequest('current-qualified', params.value))
type Result = { rows: CurrentRow[]; total: number; page: number; pageSize: number; request: typeof activeRequest.value }
const { data, isLoading, error, refetch } = useQuery<Result>({
  key: () => ['current-qualified', params.value],
  query: async ({ entry }) => {
    const request = captureQueryRequest('current-qualified', entry.key[1] as typeof params.value)
    const response = await $fetch<Omit<Result, 'request'>>('/api/roster/current-enterprises', { query: request.params })
    return { ...response, request }
  },
  placeholderData: previous => previous,
})
const { displayed, paginationDisabled, failureDescription } = useRetainedQuerySnapshot(data, isLoading, error, activeRequest)
const rows = computed(() => displayed.value?.rows ?? [])
const allDistricts = [...new Set([...NINGBO_DISTRICTS, ...NINGBO_INDEPENDENT_ZONES])]
const detailUrl = (id: number) => ({ path: `/enterprises/${id}`, query: { currentBack: new URLSearchParams(Object.entries(route.query).filter((pair): pair is [string, string] => typeof pair[1] === 'string')).toString() } })
function clearFilters() { search.value = ''; update({ q: undefined, district: undefined, page: undefined }) }
useHead({ title: '优质中小企业查询' })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <PageHeader title="优质中小企业查询" description="按称号查看本库当前有效的认定企业。" />
    <Tabs v-model="titleModel">
      <TabsList class="max-w-full flex-wrap">
        <TabsTrigger v-for="code in CURRENT_TITLES" :key="code" :value="code">{{ TITLES[code] }}</TabsTrigger>
      </TabsList>
    </Tabs>
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative w-full sm:w-72">
        <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
        <Input v-model="search" class="bg-card h-8 pl-8 shadow-none" placeholder="企业名称、曾用名或统代" aria-label="搜索企业名称、已确认曾用名或统一社会信用代码" />
      </div>
      <Select v-model="districtModel">
        <SelectTrigger size="sm" class="bg-card w-32 shadow-none" aria-label="按区县筛选"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="all">全部区县</SelectItem><SelectItem v-for="place in allDistricts" :key="place" :value="place">{{ place }}</SelectItem></SelectGroup></SelectContent>
      </Select>
      <Select v-model="sortModel">
        <SelectTrigger size="sm" class="bg-card w-36 shadow-none" aria-label="排序方式"><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem value="id_asc">稳定企业标识</SelectItem><SelectItem value="name_asc">企业名称升序</SelectItem><SelectItem value="name_desc">企业名称降序</SelectItem></SelectGroup></SelectContent>
      </Select>
      <Button v-if="q || district" variant="ghost" size="sm" @click="clearFilters">清除筛选</Button>
    </div>
    <Card class="gap-0 overflow-hidden py-0 shadow-none">
      <CardContent class="relative p-0">
        <TableLoadingStatus kind="ledger" :loading="isLoading" label="正在查询当前有效企业…" />
        <TableFailureState v-if="error" title="当前有效企业查询失败" :compact="rows.length > 0" :pending="isLoading" :description="failureDescription" @retry="refetch()" />
        <div v-if="!error || rows.length" class="data-table-scroll [&_[data-slot=table-container]]:overflow-visible">
          <Table class="data-table min-w-[850px] table-fixed">
            <TableHeader><TableRow class="hover:bg-transparent">
              <TableHead class="bg-muted w-[24%]">企业名称</TableHead><TableHead class="bg-muted w-[19%]">统一社会信用代码</TableHead><TableHead class="bg-muted w-[12%]">区县</TableHead><TableHead class="bg-muted w-[31%]">认定与资格依据</TableHead><TableHead class="bg-muted w-[14%]">详情与出处</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="row in rows" :key="row.enterpriseId">
                <TableCell class="align-top break-words"><span class="font-medium">{{ row.name }}</span><span v-if="row.aliases.length" class="text-muted-foreground mt-1 block text-xs">曾用名：{{ row.aliases.join('、') }}</span></TableCell>
                <TableCell class="align-top break-all font-mono text-xs">{{ row.uscc ?? '未记录' }}</TableCell>
                <TableCell class="align-top">{{ row.district ?? '未记录' }}</TableCell>
                <TableCell class="align-top break-words text-xs leading-5">
                  <p>首次认定：{{ row.firstYear == null ? '未记录' : `${row.firstYear} 年` }}</p>
                  <p>{{ row.publication }}</p>
                  <p v-if="row.publishedNames.length" class="text-muted-foreground">公布名：{{ row.publishedNames.join('、') }}</p>
                  <p v-if="row.basis" class="whitespace-pre-line">{{ row.basis }}</p>
                  <p v-if="row.reviews" class="whitespace-pre-line">{{ row.reviews }}</p>
                  <p v-if="row.notes.length" class="text-muted-foreground">{{ row.notes.join('；') }}</p>
                </TableCell>
                <TableCell class="align-top"><Button as-child variant="outline" size="sm"><NuxtLink :to="detailUrl(row.enterpriseId)">查看详情与出处</NuxtLink></Button></TableCell>
              </TableRow>
              <TableRow v-if="isLoading"><TableCell v-for="n in 5" :key="n"><Skeleton class="h-3 w-full" /></TableCell></TableRow>
              <TableRow v-if="!isLoading && !error && !rows.length"><TableCell colspan="5" class="p-0"><Empty class="border-0"><EmptyHeader><EmptyTitle>没有符合条件的当前有效企业</EmptyTitle></EmptyHeader></Empty></TableCell></TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
    <TablePagination v-if="!error || rows.length" :page="displayed?.request.page ?? page" :page-size="displayed?.request.pageSize ?? pageSize" :total="displayed?.total ?? 0" :loading="paginationDisabled" unit="家企业" @update:page="update({ page: $event === 1 ? undefined : String($event) })" @update:page-size="update({ pageSize: String($event), page: undefined })" />
  </div>
</template>
