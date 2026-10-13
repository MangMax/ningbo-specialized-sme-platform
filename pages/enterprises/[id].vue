<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import { computed } from 'vue'

interface Evidence {
  sourceFile: string
  attachment: string | null
  listNo: number | null
}
interface DetailEvent {
  type: string
  year: number | null
  seq: number | null
  evidence: Evidence[]
}
interface DetailRecord {
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

const TITLES: Record<string, string> = {
  little_giant: '专精特新“小巨人”',
  specialized_sme: '专精特新中小企业',
  innovative_sme: '创新型中小企业',
}
const TITLE_ORDER = ['little_giant', 'specialized_sme', 'innovative_sme']
const SOURCES: Record<string, string> = { jxj: '经信局', miit: '工信部' }
const SOURCE_ORDER = ['jxj', 'miit']
const EVENTS: Record<string, string> = {
  award: '认定',
  review: '复核',
  maintain: '维护',
  nurture: '入库培育',
}
const FLAGS: Record<string, string> = {
  uscc_missing: '无统一社会信用代码',
  name_ambiguous: '重名待核',
  non_ningbo: '非宁波',
  deregistered: '已注销 / 吊销',
  attachment_unparsed: '附件未解析',
}
const EVENT_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  award: 'secondary',
  review: 'outline',
  maintain: 'outline',
  nurture: 'outline',
}

const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id ?? ''))

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data, isLoading, error } = useQuery({
  key: () => ['enterprise', id.value],
  query: () => apiGet<EnterpriseDetail>(`/api/enterprises/${id.value}`),
})

const detail = computed(() => data.value ?? null)
const usccMissing = computed(() => detail.value?.qualityFlags?.includes('uscc_missing') ?? false)
const otherFlags = computed(() => (detail.value?.qualityFlags ?? []).filter((f) => f !== 'uscc_missing'))
const recordCount = computed(() => detail.value?.records.length ?? 0)

interface TitleGroup {
  titleCode: string
  titleName: string
  records: DetailRecord[]
  summary: string
  dual: boolean
}

const groups = computed<TitleGroup[]>(() => {
  const records = detail.value?.records ?? []
  const byTitle = new Map<string, DetailRecord[]>()
  for (const r of records) {
    const arr = byTitle.get(r.titleCode)
    if (arr) arr.push(r)
    else byTitle.set(r.titleCode, [r])
  }
  return [...byTitle.entries()]
    .sort(([a], [b]) => rankOf(a) - rankOf(b))
    .map(([titleCode, recs]) => {
      const sorted = [...recs].sort((a, b) => sourceRank(a.source) - sourceRank(b.source))
      const counts = new Map<string, number>()
      for (const r of sorted) counts.set(r.source, (counts.get(r.source) ?? 0) + 1)
      const summary = [...counts.entries()]
        .map(([s, n]) => (n > 1 ? `${SOURCES[s] ?? s} ${n} 条` : (SOURCES[s] ?? s)))
        .join(' / ')
      return {
        titleCode,
        titleName: TITLES[titleCode] ?? titleCode,
        records: sorted,
        summary,
        dual: counts.size > 1,
      }
    })
})

function rankOf(code: string) {
  const i = TITLE_ORDER.indexOf(code)
  return i === -1 ? 99 : i
}
function sourceRank(code: string) {
  const i = SOURCE_ORDER.indexOf(code)
  return i === -1 ? 99 : i
}
function fmtTime(ev: DetailEvent) {
  if (ev.year == null) return '—'
  return ev.seq ? `${ev.year}-${ev.seq}` : String(ev.year)
}
function flagLabel(f: string) {
  return FLAGS[f] ?? f
}
function goBack() {
  if (typeof window !== 'undefined' && window.history.length > 1) router.back()
  else router.push('/')
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <Button variant="ghost" size="sm" class="-ml-2" @click="goBack">← 返回台账</Button>
    </div>

    <!-- 加载中 -->
    <Card v-if="isLoading">
      <CardHeader>
        <CardTitle><Skeleton class="h-6 w-64" /></CardTitle>
        <CardDescription><Skeleton class="h-4 w-40" /></CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-3/4" />
        <Skeleton class="h-24 w-full" />
      </CardContent>
    </Card>

    <!-- 加载失败 -->
    <Alert v-else-if="error" variant="destructive">
      <AlertTitle>未能加载企业详情</AlertTitle>
      <AlertDescription>该企业不存在或已被移除。请返回台账重新选择。</AlertDescription>
    </Alert>

    <template v-else-if="detail">
      <!-- 企业身份 -->
      <Card>
        <CardHeader>
          <CardTitle class="text-xl">{{ detail.name }}</CardTitle>
          <CardDescription>企业全部记录与事件 · 共 {{ recordCount }} 条记录</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="outline" class="font-normal">
              统一社会信用代码:<span class="font-mono">{{ detail.uscc ?? '—' }}</span>
            </Badge>
            <Badge variant="outline" class="font-normal">区县:{{ detail.district ?? '—' }}</Badge>
            <Badge v-for="f in otherFlags" :key="f" variant="destructive">{{ flagLabel(f) }}</Badge>
          </div>

          <Alert v-if="usccMissing" variant="destructive">
            <AlertTitle>缺失统一社会信用代码(uscc_missing)</AlertTitle>
            <AlertDescription>
              该企业无统一社会信用代码,记录按<strong>企业名称</strong>归并。若与其他同名企业混同,请人工核对原始公布文件。
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <!-- 无记录 -->
      <Card v-if="recordCount === 0">
        <CardContent class="text-muted-foreground py-10 text-center">该企业暂无记录。</CardContent>
      </Card>

      <!-- 称号 × 来源 分组 -->
      <Card v-for="g in groups" :key="g.titleCode">
        <CardHeader>
          <div class="flex items-center gap-2">
            <CardTitle>{{ g.titleName }}</CardTitle>
            <Badge v-if="g.dual" variant="secondary">并列来源</Badge>
          </div>
          <CardDescription>
            来源:{{ g.summary }}<span v-if="g.dual"> · 同一称号的两侧来源各成一条记录</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div :class="g.records.length > 1 ? 'grid gap-4 md:grid-cols-2' : 'grid gap-4'">
            <div v-for="rec in g.records" :key="rec.source" class="min-w-0 space-y-3 rounded-lg border p-4">
              <div class="flex flex-wrap items-center gap-2">
                <Badge :variant="rec.source === 'jxj' ? 'secondary' : 'outline'">
                  {{ SOURCES[rec.source] ?? rec.source }}
                </Badge>
                <span class="text-muted-foreground text-xs">属地:{{ rec.district ?? '—' }}</span>
                <Badge variant="outline" class="ml-auto font-normal">{{ rec.events.length }} 个事件</Badge>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-24">事件</TableHead>
                    <TableHead class="w-24">年份-批次</TableHead>
                    <TableHead>出处</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-if="rec.events.length === 0">
                    <TableCell :colspan="3" class="text-muted-foreground text-center">无事件</TableCell>
                  </TableRow>
                  <TableRow v-for="(ev, i) in rec.events" v-else :key="i">
                    <TableCell>
                      <Badge :variant="EVENT_VARIANT[ev.type] ?? 'outline'">
                        {{ EVENTS[ev.type] ?? ev.type }}
                      </Badge>
                    </TableCell>
                    <TableCell class="text-sm tabular-nums">{{ fmtTime(ev) }}</TableCell>
                    <TableCell class="whitespace-normal">
                      <Collapsible v-if="ev.evidence.length" v-slot="{ open }">
                        <CollapsibleTrigger as-child>
                          <Button variant="ghost" size="sm" class="-ml-2 h-7">
                            {{ open ? '收起出处' : `查看出处 · ${ev.evidence.length}` }}
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent class="mt-2 space-y-1">
                          <div
                            v-for="(e, j) in ev.evidence"
                            :key="j"
                            class="bg-muted/40 space-y-0.5 rounded border p-2 text-xs"
                          >
                            <div>
                              <span class="text-muted-foreground">文件:</span>
                              <span class="font-mono break-all">{{ e.sourceFile }}</span>
                            </div>
                            <div v-if="e.attachment">
                              <span class="text-muted-foreground">附件:</span>{{ e.attachment }}
                            </div>
                            <div v-if="e.listNo != null">
                              <span class="text-muted-foreground">序号:</span>{{ e.listNo }}
                            </div>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                      <span v-else class="text-muted-foreground text-xs">—</span>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>
    </template>
  </div>
</template>
