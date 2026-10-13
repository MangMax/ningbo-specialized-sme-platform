<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed, ref } from 'vue'
import { watchDebounced } from '@vueuse/core'

interface Rec {
  recordId: number
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

const title = ref('')
const search = ref('')
const q = ref('')
watchDebounced(search, (v) => (q.value = v.trim()), { debounce: 300 })

const page = ref(1)
const pageSize = 25

const params = computed(() => ({
  title: title.value || undefined,
  q: q.value || undefined,
  page: page.value,
  pageSize,
}))

// Cast $fetch to a plain signature: the typed-route inference blows past vue-tsc's
// type-depth limit once query options are involved.
const apiGet = $fetch as unknown as <T>(url: string, opts?: { query?: Record<string, unknown> }) => Promise<T>

const { data, isLoading } = useQuery({
  key: () => ['records', params.value],
  query: () => apiGet<{ rows: Rec[]; total: number }>('/api/records', { query: params.value }),
})

const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)))

function reset() {
  page.value = 1
}
function fmtEvent(e: Rec['events'][number]) {
  const batch = e.year ? `${e.year}${e.seq ? '-' + e.seq : ''}` : '—'
  return `${EVENTS[e.type] ?? e.type} ${batch}`
}
</script>

<template>
  <div class="mx-auto max-w-6xl p-6">
    <header class="mb-5">
      <h1 class="text-2xl font-semibold">专精特新企业称号台账</h1>
      <p class="text-muted-foreground mt-1 text-sm">
        记录 = 企业 × 称号 × 来源 · 共 {{ data?.total ?? 0 }} 条记录
      </p>
    </header>

    <div class="mb-4 flex flex-wrap items-center gap-3">
      <select
        v-model="title"
        class="bg-background border-input h-9 rounded-md border px-3 text-sm"
        @change="reset"
      >
        <option value="">全部称号</option>
        <option v-for="(label, code) in TITLES" :key="code" :value="code">{{ label }}</option>
      </select>
      <input
        v-model="search"
        placeholder="搜索企业名称或统一社会信用代码"
        class="bg-background border-input h-9 w-72 rounded-md border px-3 text-sm"
        @input="reset"
      />
      <span v-if="isLoading" class="text-muted-foreground text-sm">加载中…</span>
    </div>

    <Card>
      <CardContent class="p-0">
        <table class="w-full text-sm">
          <thead class="text-muted-foreground border-b text-left">
            <tr>
              <th class="px-4 py-2.5 font-medium">企业名称</th>
              <th class="px-4 py-2.5 font-medium">统一社会信用代码</th>
              <th class="px-4 py-2.5 font-medium">区县</th>
              <th class="px-4 py-2.5 font-medium">称号</th>
              <th class="px-4 py-2.5 font-medium">来源</th>
              <th class="px-4 py-2.5 font-medium">事件</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data?.rows" :key="r.recordId" class="border-b last:border-0">
              <td class="px-4 py-2.5">{{ r.name }}</td>
              <td class="text-muted-foreground px-4 py-2.5 font-mono text-xs">{{ r.uscc ?? '—' }}</td>
              <td class="px-4 py-2.5">{{ r.district ?? '—' }}</td>
              <td class="px-4 py-2.5">{{ TITLES[r.titleCode] ?? r.titleCode }}</td>
              <td class="px-4 py-2.5">{{ r.source === 'jxj' ? '经信局' : '工信部' }}</td>
              <td class="px-4 py-2.5">
                <span v-for="(e, i) in r.events" :key="i" class="mr-2 whitespace-nowrap">{{ fmtEvent(e) }}</span>
              </td>
            </tr>
            <tr v-if="data && data.rows.length === 0">
              <td colspan="6" class="text-muted-foreground px-4 py-8 text-center">没有匹配的记录</td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>

    <div class="mt-4 flex items-center justify-between">
      <span class="text-muted-foreground text-sm">第 {{ page }} / {{ totalPages }} 页</span>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="page <= 1" @click="page--">上一页</Button>
        <Button variant="outline" size="sm" :disabled="page >= totalPages" @click="page++">下一页</Button>
      </div>
    </div>
  </div>
</template>
