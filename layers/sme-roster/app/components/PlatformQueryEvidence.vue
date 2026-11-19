<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import DisclosurePanel from '../../../core/app/components/DisclosurePanel.vue'
import RosterPlatformEvidenceChunk from './PlatformEvidenceChunk.vue'
import TableFailureState from '../../../core/app/components/TableFailureState.vue'
import { Button } from '#core/app/components/ui/button'
const props = defineProps<{ queryId: number }>()
interface RelationPage {
  queryId: number; field: string; rows: { id: number; sequenceNo: number }[]; total: number; page: number; pageSize: number
}
const open = ref(false)
const rows = ref<RelationPage['rows']>([])
const page = ref(0)
const pageSize = ref(25)
const total = ref<number>()
const pending = ref(false)
const error = ref('')
let controller = new AbortController()
const revision = ref(0)
let active = true
onBeforeUnmount(() => { active = false; controller.abort() })
async function next() {
  if (pending.value || (total.value !== undefined && rows.value.length >= total.value)) return
  pending.value = true
  error.value = ''
  const request = revision.value
  try {
    const result = await $fetch<RelationPage>(`/api/platform/queries/${props.queryId}/evidence`, {
      query: { field: 'relations', page: page.value + 1, pageSize: pageSize.value }, signal: controller.signal, retry: 0,
    })
    if (!active || request !== revision.value) return
    if (result.queryId !== props.queryId || result.field !== 'relations' || result.page !== page.value + 1
      || (total.value !== undefined && total.value !== result.total)
      || new Set([...rows.value, ...result.rows].map(row => row.id)).size !== rows.value.length + result.rows.length
      || (result.rows.length === 0 && rows.value.length < result.total)) throw new Error('关系来源或范围已变化，请重新读取此查询。')
    rows.value.push(...result.rows)
    page.value = result.page
    pageSize.value = result.pageSize
    total.value = result.total
  } catch (cause) { if (active && request === revision.value) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (active && request === revision.value) pending.value = false }
}
function restart() {
  ++revision.value
  controller.abort()
  controller = new AbortController()
  rows.value = []
  page.value = 0
  total.value = undefined
  pending.value = false
  error.value = ''
  void next()
}
function toggle(value: boolean) {
  open.value = value
  if (value && total.value === undefined && !error.value) void next()
}
</script>

<template>
  <DisclosurePanel title="查看关系与原文" :open="open" :heading-level="2" keep-mounted padded @update:open="toggle">
    <div class="flex min-w-0 flex-col gap-4 px-3" :aria-busy="pending">
      <p class="text-muted-foreground text-xs" aria-live="polite">
        <template v-if="total === undefined">关系尚未加载</template>
        <template v-else>已加载关系目录 {{ rows.length }} / {{ total }} · 第 1–{{ page }} 页 · {{ rows.length === total ? '关系目录完整' : '部分，尚未读完' }}</template>
        <span>；关系原档与查询原文分别按需读取，未读取字段尚未加载。</span>
      </p>
      <Button variant="ghost" size="sm" class="self-start" data-action="query-restart" @click="restart">重新读取此查询</Button>
      <TableFailureState v-if="error" :title="`关系第 ${page + 1} 页加载失败`" :description="error" :pending="pending" compact @retry="next" />
      <div v-for="relation in rows" :key="`${revision}:${relation.id}`" class="rounded-md border p-3" :data-relation-id="relation.id">
        <RosterPlatformEvidenceChunk :query-id="queryId" field="relation" :relation-id="relation.id" :title="`第 ${relation.sequenceNo} 条 · 关系 #${relation.id} 原档（含企业名称与原字段）`" />
      </div>
      <Button v-if="!error && (total === undefined || rows.length < total)" variant="outline" size="sm" class="self-start" :disabled="pending" data-action="relations-next" @click="next">{{ pending ? '正在读取关系…' : '读取下一关系页' }}</Button>
      <RosterPlatformEvidenceChunk :key="`collection:${revision}`" :query-id="queryId" field="collectionEvidence" title="采集原档" />
      <RosterPlatformEvidenceChunk :key="`raw:${revision}`" :query-id="queryId" field="rawResponse" title="响应原文" />
    </div>
  </DisclosurePanel>
</template>
