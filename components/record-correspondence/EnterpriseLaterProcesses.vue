<script setup lang="ts">
import { ref, watch } from 'vue'
import { correspondenceStatusText, CORRESPONDENCE_ROLES, type CorrespondenceSummary, type SourceKind } from '~~/lib/roster/correspondence-view'
import SourceReader from './SourceReader.vue'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps<{ enterpriseId: number; returnTo?: string | null }>()
type Result = { rows: CorrespondenceSummary[]; total: number; page: number; pageSize: number }
const page = ref(1)
const pageSize = ref(25)
const displayed = ref<Result | null>(null)
const loading = ref(false)
const error = ref(false)
let requestId = 0
const selectedSource = ref<{ kind: SourceKind; id: number } | null>(null)
function openSource(edge: CorrespondenceSummary) {
  if (edge.relationId != null) selectedSource.value = { kind: 'relation', id: edge.relationId }
  else if (edge.exportRowId != null) selectedSource.value = { kind: 'export_row', id: edge.exportRowId }
}
function eventTo(edge: CorrespondenceSummary) {
  const eventId = edge.eventId ?? edge.predecessorEventId
  return { path: `/enterprises/${edge.enterpriseId ?? props.enterpriseId}`, query: { ...(eventId != null ? { eventId: String(eventId) } : {}), ...(props.returnTo ? { returnTo: props.returnTo } : {}) } }
}
function sourceLocator(edge: CorrespondenceSummary) {
  if (edge.relationId != null) return `平台查询来源记录 #${edge.relationId}`
  if (edge.exportRowId != null) return `平台导出来源记录 #${edge.exportRowId}`
  return '未绑定平台原行'
}
async function load() {
  const current = ++requestId
  loading.value = true
  error.value = false
  try {
    const result = await $fetch<Result>('/api/roster/correspondences', { query: { enterpriseId: props.enterpriseId, type: 'later_process', view: 'summary', page: page.value, pageSize: pageSize.value } })
    if (current === requestId) displayed.value = result
  } catch {
    if (current === requestId) error.value = true
  } finally {
    if (current === requestId) loading.value = false
  }
}
watch([() => props.enterpriseId, page, pageSize], () => { void load() }, { immediate: true })
function setPage(value: number) { page.value = value }
function setPageSize(value: number) { pageSize.value = value; page.value = 1 }
</script>

<template>
  <Card class="gap-0 py-0" data-testid="enterprise-later-processes">
    <CardHeader class="border-b px-5 py-4"><h2 class="text-sm font-medium">独立后续流程</h2><p class="text-muted-foreground text-[13px]">后续申请、更新与复核按具体原行展示，不覆盖既有正式事件。</p></CardHeader>
    <CardContent class="min-w-0 p-5">
      <TableLoadingStatus kind="comparison" :loading="loading" label="正在读取后续流程…" />
      <TableFailureState v-if="error" title="后续流程读取失败" :compact="!!displayed" :pending="loading" :description="displayed ? '本次读取失败，保留上次成功的流程列表。' : '请重试读取后续流程。'" @retry="load" />
      <p v-if="displayed && (displayed.page !== page || displayed.pageSize !== pageSize)" class="text-muted-foreground mb-2 text-[13px]">仍显示第 {{ displayed.page }} 页的已读取结果。</p>
      <ul v-if="displayed?.rows.length" class="flex min-w-0 flex-col gap-2">
        <li v-for="edge in displayed.rows" :key="edge.id" class="min-w-0 border-t py-2 text-[13px]" :data-correspondence-id="edge.id">
          <div class="flex flex-wrap items-center gap-2">
            <span>{{ CORRESPONDENCE_ROLES[edge.role] ?? '独立后续流程' }}</span>
            <Badge :variant="edge.status === 'confirmed' && !edge.requiresRevalidation ? 'secondary' : 'outline'">{{ correspondenceStatusText(edge) }}</Badge>
            <span class="text-muted-foreground">修订 {{ edge.revision }}</span>
          </div>
          <p class="text-muted-foreground mt-1">{{ sourceLocator(edge) }}</p>
          <div class="mt-1 flex flex-wrap items-center gap-2">
            <NuxtLink v-if="edge.eventId != null || edge.predecessorEventId != null" :to="eventTo(edge)" class="text-primary underline underline-offset-2 hover:no-underline">查看关联正式事件 #{{ edge.eventId ?? edge.predecessorEventId }}</NuxtLink>
            <Button v-if="edge.relationId != null || edge.exportRowId != null" variant="ghost" size="sm" @click="openSource(edge)">查看原始记录</Button>
          </div>
          <p v-if="edge.requiresRevalidation" class="text-warning mt-1">出处变更后需重新核验；当前不按已确认出处计。</p>
        </li>
      </ul>
      <p v-else-if="!loading && !error" class="text-muted-foreground text-[13px]">尚无已登记的后续流程。此处不推断平台没有原行。</p>
      <TablePagination v-if="displayed" class="mt-4" :page="displayed.page" :page-size="displayed.pageSize" :total="displayed.total" unit="条流程" :loading="loading || error" @update:page="setPage" @update:page-size="setPageSize" />
    </CardContent>
  </Card>
  <Dialog :open="selectedSource !== null" @update:open="open => { if (!open) selectedSource = null }">
    <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>平台原行与查询条件</DialogTitle><DialogDescription>读取完整来源与关联记录。</DialogDescription></DialogHeader>
      <SourceReader v-if="selectedSource" :kind="selectedSource.kind" :id="selectedSource.id" :return-to="returnTo" />
    </DialogContent>
  </Dialog>
</template>
