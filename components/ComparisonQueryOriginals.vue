<script setup lang="ts">
import { onScopeDispose, ref, shallowRef, watch } from 'vue'
import DisclosurePanel from './DisclosurePanel.vue'
import TablePagination from './TablePagination.vue'
import TableFailureState from './TableFailureState.vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{ queryId: number }>()
interface RelationPage { rows: { id: number; sequenceNo: number }[]; total: number; page: number; pageSize: number }
interface Chunk { data: string; offset: number; byteLength: number; totalBytes: number; hasMore: boolean; isNull: boolean }
type Original = { field: 'rawResponse' | 'collectionEvidence' | 'relation'; relationId?: number }
const open = ref(false)
const page = ref(1)
const pageSize = ref(200)
const displayed = shallowRef<RelationPage | null>(null)
const loading = ref(false)
const failed = ref(false)
const original = shallowRef<Original | null>(null)
const text = shallowRef<string | null | undefined>(undefined)
const reading = ref(false)
const readFailed = ref(false)
let listGeneration = 0
let readGeneration = 0
let listController: AbortController | undefined
let readController: AbortController | undefined
async function loadPage() {
  const own = ++listGeneration
  listController?.abort()
  if (!open.value) return
  const signal = (listController = new AbortController()).signal
  loading.value = true
  failed.value = false
  try {
    const response = await $fetch<RelationPage>(`/api/platform/queries/${props.queryId}/evidence`, { query: { field: 'relations', page: page.value, pageSize: pageSize.value }, signal })
    if (own === listGeneration) displayed.value = response
  } catch { if (own === listGeneration) failed.value = true }
  finally { if (own === listGeneration) loading.value = false }
}
async function read(value: Original) {
  const own = ++readGeneration
  readController?.abort()
  const signal = (readController = new AbortController()).signal
  const queryId = props.queryId
  original.value = value
  text.value = undefined
  reading.value = true
  readFailed.value = false
  try {
    const chunks: Uint8Array[] = []
    let offset = 0
    let totalBytes: number | undefined
    for (;;) {
      const response = await $fetch<Chunk>(`/api/platform/queries/${queryId}/evidence`, { query: { ...value, offset, length: 65536 }, signal })
      if (own !== readGeneration) return
      if (response.isNull) { text.value = null; return }
      const bytes = Uint8Array.from(atob(response.data), char => char.charCodeAt(0))
      if (response.offset !== offset || bytes.length !== response.byteLength || (totalBytes !== undefined && totalBytes !== response.totalBytes) || (response.hasMore && bytes.length === 0)) throw new Error('incomplete_archive')
      totalBytes = response.totalBytes
      chunks.push(bytes)
      offset += bytes.length
      if (!response.hasMore) break
    }
    if (offset !== totalBytes) throw new Error('incomplete_archive')
    const bytes = new Uint8Array(offset)
    let start = 0
    for (const chunk of chunks) { bytes.set(chunk, start); start += chunk.length }
    text.value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { if (own === readGeneration) readFailed.value = true }
  finally { if (own === readGeneration) reading.value = false }
}
watch([open, page, pageSize], () => { void loadPage() })
watch(() => props.queryId, () => {
  ++readGeneration
  readController?.abort()
  original.value = null
  reading.value = false
  readFailed.value = false
  text.value = undefined
  displayed.value = null
  page.value = 1
  void loadPage()
})
onScopeDispose(() => { ++listGeneration; ++readGeneration; listController?.abort(); readController?.abort() })
</script>
<template>
  <DisclosurePanel v-model:open="open" compact :title="`查询 #${queryId} · 完整原档（含未归属来源行）`">
    <div class="flex min-w-0 flex-col gap-2">
      <p v-if="loading" role="status">正在读取来源行目录…</p>
      <TableFailureState v-if="failed" title="来源行目录读取失败" :compact="!!displayed" :pending="loading" :description="displayed ? `保留第 ${displayed.page} 页；目标第 ${page} 页尚未读取。` : '尚未读取来源行，请重试。'" @retry="loadPage" />
      <template v-if="displayed">
        <p class="text-muted-foreground text-[13px]">共 {{ displayed.total }} 条来源行；包含候选及未归属行，不代表已确认归属。</p>
        <div class="flex flex-wrap gap-2">
          <Button v-for="relation in displayed.rows" :key="relation.id" variant="outline" size="sm" @click="read({ field: 'relation', relationId: relation.id })">来源行 {{ relation.sequenceNo }} · #{{ relation.id }}</Button>
        </div>
        <TablePagination :page="displayed.page" :page-size="displayed.pageSize" :total="displayed.total" :loading="loading || failed" unit="条来源行" @update:page="page = $event" @update:page-size="pageSize = $event; page = 1" />
      </template>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" @click="read({ field: 'rawResponse' })">查询响应原文</Button>
        <Button variant="outline" size="sm" @click="read({ field: 'collectionEvidence' })">采集证据原文</Button>
      </div>
      <p v-if="reading" role="status">正在读取完整原文…</p>
      <div v-if="readFailed" role="alert"><p>原文读取失败，尚未取得完整内容。</p><Button variant="outline" size="sm" :disabled="reading" @click="original && read(original)">重试读取原文</Button></div>
      <p v-if="text === null">原档未保存（null）</p>
      <p v-else-if="text === ''">原档为空字符串</p>
      <pre v-else-if="text !== undefined" class="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">{{ text }}</pre>
    </div>
  </DisclosurePanel>
</template>
