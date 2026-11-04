<script setup lang="ts">
import { ref, watch } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import TableFailureState from '@/components/TableFailureState.vue'
import RecordSourceReader from '@/components/record-correspondence/SourceReader.vue'
import type { RecognizedDirectoryDetail } from '~~/lib/platform/recognized-directory'
import { PLATFORM_HISTORY_STATES } from '~~/lib/roster/platform-records'
import { PLATFORM_RDJBS } from '~~/lib/labels'
import { formatFetchTime } from '~~/lib/reconcile-time'

const props = defineProps<{ recordId: number | null; open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const data = ref<RecognizedDirectoryDetail>()
const loading = ref(false)
const error = ref('')
const sourceRelationId = ref<number | null>(null)
let generation = 0

async function load(id: number) {
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await $fetch<RecognizedDirectoryDetail>(`/api/platform/recognized-directory/${id}`, { retry: 0 })
    if (request === generation) data.value = result
  } catch (cause) {
    if (request === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (request === generation) loading.value = false
  }
}

watch(() => [props.open, props.recordId] as const, ([open, id]) => {
  if (!open || id == null) return
  data.value = undefined
  sourceRelationId.value = null
  void load(id)
}, { immediate: true })

const missing = (value: string | number | null | undefined) => value === null || value === undefined || value === '' ? '未提供' : String(value)
const time = (value: string | null) => value ? formatFetchTime(value) ?? value : '未提供'
const state = (value: string) => PLATFORM_HISTORY_STATES[value] ?? value
const scopes = (values: string[]) => values.length ? values.map(value => PLATFORM_RDJBS[value] ?? value).join('、') : '未记录'
const conflictLabel: Record<string, string> = {
  title_conflict: '行称号与查询范围不一致',
  enterprise_assignment_conflict: '企业归属冲突',
  unverifiable_observation: '存在内容未核实观察',
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-4xl" data-testid="platform-recognized-directory-detail">
      <DialogHeader>
        <DialogTitle class="pr-8">平台认定目录 #{{ recordId }} · 观察与版本</DialogTitle>
        <DialogDescription class="sr-only">平台认定目录记录的内容版本与实际观察</DialogDescription>
      </DialogHeader>
      <div v-if="loading && !data" class="flex flex-col gap-2"><Skeleton class="h-24 w-full" /><Skeleton class="h-40 w-full" /></div>
      <TableFailureState v-else-if="error" :title="`平台认定目录 #${recordId} 加载失败`" :description="error" :pending="loading" @retry="recordId != null && load(recordId)" />
      <div v-else-if="data" class="flex min-w-0 flex-col gap-5">
        <div v-if="data.conflicts.length" class="flex flex-wrap gap-1" data-testid="platform-recognized-directory-conflicts">
          <Badge v-for="conflict in data.conflicts" :key="conflict" variant="outline">{{ conflictLabel[conflict] ?? conflict }}</Badge>
        </div>
        <section class="min-w-0">
          <h3 class="text-sm font-medium">内容版本 <span class="text-muted-foreground font-normal">{{ data.counts.versions }} 个<template v-if="data.counts.versionsTruncated">（仅显示前 {{ data.versions.length }} 个）</template></span></h3>
          <div class="mt-2 flex flex-col gap-2">
            <article v-for="version in data.versions" :key="version.versionId" class="rounded-sm border p-3" data-testid="platform-recognized-directory-version">
              <div class="flex flex-wrap items-baseline gap-2">
                <span class="text-sm font-medium">版本 #{{ version.versionId }}</span>
                <Badge variant="outline">有效期 {{ missing(version.validityDateRaw) }}</Badge>
                <Badge v-if="version.ruleVersion == null" variant="quiet">尚未建立 typed 投影</Badge>
              </div>
              <dl class="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <dt class="text-muted-foreground">有效期</dt><dd class="font-mono break-all">{{ missing(version.validityDateRaw) }}</dd>
                <dt class="text-muted-foreground">维护批次</dt><dd>{{ missing(version.maintenanceBatch) }}</dd>
                <dt class="text-muted-foreground">属地</dt><dd class="font-mono break-all">{{ missing(version.district) }}</dd>
                <dt class="text-muted-foreground">平台认定说明</dt><dd class="whitespace-pre-wrap break-words">{{ missing(version.awardNote) }}</dd>
                <dt class="text-muted-foreground">行称号</dt><dd>{{ missing(version.titleRaw) }}</dd>
                <dt class="text-muted-foreground">称号范围</dt><dd>{{ scopes(version.titleScopes) }}</dd>
                <dt class="text-muted-foreground">企业</dt><dd>{{ missing(version.nameRaw) }} · {{ missing(version.usccRaw) }}</dd>
                <dt class="text-muted-foreground">观察次数</dt><dd>{{ version.observationCount }}</dd>
              </dl>
            </article>
          </div>
        </section>
        <section class="min-w-0">
          <h3 class="text-sm font-medium">实际观察 <span class="text-muted-foreground font-normal">{{ data.counts.observations }} 次<template v-if="data.counts.observationsTruncated">（仅显示最近 {{ data.observations.length }} 次）</template></span></h3>
          <div class="mt-2 min-w-0 overflow-x-auto rounded-sm border">
            <Table class="min-w-[900px] text-[13px] leading-5" aria-label="平台认定目录实际观察">
              <TableHeader>
                <TableRow class="bg-muted/40 text-muted-foreground hover:bg-transparent">
                  <TableHead class="px-3 py-2 font-medium">原行 / 查询</TableHead>
                  <TableHead class="px-3 py-2 font-medium">采集时间</TableHead>
                  <TableHead class="px-3 py-2 font-medium">称号范围</TableHead>
                  <TableHead class="px-3 py-2 font-medium">内容版本</TableHead>
                  <TableHead class="px-3 py-2 font-medium">企业</TableHead>
                  <TableHead class="px-3 py-2 font-medium">行称号</TableHead>
                  <TableHead class="px-3 py-2 font-medium">对应决定</TableHead>
                  <TableHead class="px-3 py-2 font-medium">状态</TableHead>
                  <TableHead class="px-3 py-2 font-medium">原行</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="observation in data.observations" :key="observation.relationId" class="border-t" data-testid="platform-recognized-directory-observation">
                  <TableCell class="px-3 py-2 whitespace-nowrap">行 #{{ observation.relationId }} · 查询 #{{ observation.queryId }}</TableCell>
                  <TableCell class="px-3 py-2 tabular-nums">{{ time(observation.queriedAt) }}</TableCell>
                  <TableCell class="px-3 py-2">{{ scopes(observation.titleScopes) }}</TableCell>
                  <TableCell class="px-3 py-2">{{ observation.versionId == null ? '未建立' : `版本 #${observation.versionId}` }}</TableCell>
                  <TableCell class="px-3 py-2">{{ observation.enterpriseName ?? '未匹配主体' }}</TableCell>
                  <TableCell class="px-3 py-2 font-mono text-xs">{{ missing(observation.version?.titleRaw) }}<span v-if="observation.titleConflict" class="text-muted-foreground mt-1 block">行称号与查询范围不一致</span></TableCell>
                  <TableCell class="px-3 py-2 text-xs">
                    <template v-if="observation.correspondenceRefs.length">
                      <span v-for="ref in observation.correspondenceRefs" :key="ref.id" class="mr-1 whitespace-nowrap">#{{ ref.id }} · {{ ref.status }}</span>
                    </template>
                    <span v-else class="text-muted-foreground">—</span>
                  </TableCell>
                  <TableCell class="px-3 py-2 text-xs">{{ state(observation.identityState) }}<template v-if="observation.contentState === 'unverifiable'"> · 原文内容无法核实</template></TableCell>
                  <TableCell class="px-3 py-2"><div class="flex flex-col items-start gap-1"><NuxtLink :to="{ path: '/platform-queries', query: { queryKey: observation.queryKey } }" class="whitespace-nowrap text-xs hover:underline">查看原查询</NuxtLink><Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="sourceRelationId = sourceRelationId === observation.relationId ? null : observation.relationId">{{ sourceRelationId === observation.relationId ? '收起原行' : '原行与对应' }}</Button></div></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <section v-if="sourceRelationId != null" class="mt-3 min-w-0 rounded-sm border p-3">
            <h4 class="mb-2 text-sm font-medium">原行 #{{ sourceRelationId }} 与对应决定</h4>
            <RecordSourceReader kind="relation" :id="sourceRelationId" presentation="business" />
          </section>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
