<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, ref } from 'vue'
import { watchDebounced } from '@vueuse/core'

interface Rec {
  recordId: number
  enterpriseId: number
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  source: string
  events: { type: string; year: number | null; seq: number | null }[]
}

const TITLES: Record<string, string> = {
  little_giant: '小巨人',
  specialized_sme: '专精特新中小企业',
  innovative_sme: '创新型中小企业',
}
const EVENTS: Record<string, string> = {
  award: '认定',
  review: '复核',
  maintain: '维护',
  nurture: '入库培育',
}

const apiGet = $fetch as unknown as <T>(url: string, opts?: { query?: Record<string, unknown> }) => Promise<T>

const title = ref('all')
const search = ref('')
const q = ref('')
watchDebounced(search, (v) => {
  q.value = v.trim()
  page.value = 1
}, { debounce: 300 })

const page = ref(1)
const pageSize = 25

const params = computed(() => ({
  title: title.value === 'all' ? undefined : title.value,
  q: q.value || undefined,
  page: page.value,
  pageSize,
}))

const { data, isLoading } = useQuery({
  key: () => ['records', params.value],
  query: () => apiGet<{ rows: Rec[]; total: number }>('/api/records', { query: params.value }),
})

const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)))
const onTitleChange = () => (page.value = 1)
const exportUrl = computed(() => {
  const p = new URLSearchParams()
  if (title.value !== 'all') p.set('title', title.value)
  if (q.value) p.set('q', q.value)
  return `/api/export?${p.toString()}`
})
function fmt(e: Rec['events'][number]) {
  return `${EVENTS[e.type] ?? e.type} ${e.year ? `${e.year}${e.seq ? '-' + e.seq : ''}` : '—'}`
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="text-xl font-semibold">记录台账</h1>
      <p class="text-muted-foreground text-sm">记录 = 企业 × 称号 × 来源 · 共 {{ data?.total ?? 0 }} 条</p>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <Select v-model="title" @update:model-value="onTitleChange">
        <SelectTrigger class="w-44">
          <SelectValue placeholder="全部称号" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部称号</SelectItem>
          <SelectItem value="little_giant">小巨人</SelectItem>
          <SelectItem value="specialized_sme">专精特新中小企业</SelectItem>
          <SelectItem value="innovative_sme">创新型中小企业</SelectItem>
        </SelectContent>
      </Select>

      <Input v-model="search" placeholder="搜索企业名称或统一社会信用代码" class="w-72" />

      <Button as-child variant="outline" size="sm" class="ml-auto">
        <a :href="exportUrl">导出当前结果</a>
      </Button>
    </div>

    <Card>
      <CardContent class="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企业名称</TableHead>
              <TableHead>统一社会信用代码</TableHead>
              <TableHead>区县</TableHead>
              <TableHead>称号</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>事件</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-if="isLoading">
              <TableCell :colspan="6"><Skeleton class="h-4 w-full" /></TableCell>
            </TableRow>
            <TableRow v-for="r in data?.rows" v-else :key="r.recordId">
              <TableCell class="font-medium">
                <NuxtLink :to="`/enterprises/${r.enterpriseId}`" class="hover:underline">{{ r.name }}</NuxtLink>
              </TableCell>
              <TableCell class="text-muted-foreground font-mono text-xs">{{ r.uscc ?? '—' }}</TableCell>
              <TableCell>{{ r.district ?? '—' }}</TableCell>
              <TableCell>{{ TITLES[r.titleCode] ?? r.titleCode }}</TableCell>
              <TableCell>
                <Badge :variant="r.source === 'jxj' ? 'secondary' : 'outline'">
                  {{ r.source === 'jxj' ? '经信局' : '工信部' }}
                </Badge>
              </TableCell>
              <TableCell class="space-x-1">
                <Badge v-for="(e, i) in r.events" :key="i" variant="outline">{{ fmt(e) }}</Badge>
              </TableCell>
            </TableRow>
            <TableRow v-if="!isLoading && data && data.rows.length === 0">
              <TableCell :colspan="6" class="text-muted-foreground h-24 text-center">没有匹配的记录</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <div class="flex items-center justify-between">
      <span class="text-muted-foreground text-sm">第 {{ page }} / {{ totalPages }} 页</span>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="page <= 1" @click="page--">上一页</Button>
        <Button variant="outline" size="sm" :disabled="page >= totalPages" @click="page++">下一页</Button>
      </div>
    </div>
  </div>
</template>
