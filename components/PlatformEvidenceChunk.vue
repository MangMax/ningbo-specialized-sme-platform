<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { Button } from '@/components/ui/button'
import TableFailureState from './TableFailureState.vue'

const props = defineProps<{
  queryId: number
  field: 'rawResponse' | 'collectionEvidence' | 'relation'
  relationId?: number
  title: string
}>()
interface Chunk {
  queryId: number; field: string; relationId?: number; encoding: string
  offset: number; byteLength: number; totalBytes: number; isNull: boolean; hasMore: boolean; data: string
}
const offset = ref(0)
const total = ref<number>()
const isNull = ref(false)
const complete = ref(false)
// Keep accepted decoded segments as stable text nodes. Appending a segment must
// not replace/re-layout the entire already rendered multi-MiB original.
const textParts = ref<string[]>([])
const pending = ref(false)
const error = ref('')
const decoder = new TextDecoder('utf-8', { fatal: true })
const controller = new AbortController()
let active = true
onBeforeUnmount(() => { active = false; controller.abort() })
async function next() {
  if (pending.value || complete.value) return
  pending.value = true
  error.value = ''
  try {
    const chunk = await $fetch<Chunk>(`/api/platform/queries/${props.queryId}/evidence`, {
      query: { field: props.field, relationId: props.relationId, offset: offset.value }, signal: controller.signal, retry: 0,
    })
    if (!active) return
    const bytes = Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0))
    if (chunk.queryId !== props.queryId || chunk.field !== props.field || chunk.relationId !== props.relationId
      || chunk.encoding !== 'base64' || chunk.offset !== offset.value || chunk.byteLength !== bytes.length
      || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes < offset.value + bytes.length
      || (total.value !== undefined && (total.value !== chunk.totalBytes || isNull.value !== chunk.isNull))
      || chunk.hasMore !== (offset.value + bytes.length < chunk.totalBytes)
      || (chunk.hasMore && bytes.length === 0) || (chunk.isNull && chunk.totalBytes !== 0)) {
      throw new Error('来源或原档范围已变化，请重新读取此查询。')
    }
    textParts.value.push(decoder.decode(bytes, { stream: chunk.hasMore }))
    offset.value += bytes.length
    total.value = chunk.totalBytes
    isNull.value = chunk.isNull
    complete.value = !chunk.hasMore
  } catch (cause) {
    if (active) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (active) pending.value = false }
}
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2" :aria-label="title" :aria-busy="pending">
    <p class="text-sm font-medium">{{ title }}</p>
    <p class="text-muted-foreground text-xs" aria-live="polite">
      <template v-if="total === undefined">尚未加载</template>
      <template v-else>{{ offset }} / {{ total }} 字节 · {{ complete ? '完整' : '部分，尚未读完' }}<template v-if="isNull"> · 未记录（null）</template><template v-else-if="complete && total === 0"> · 空字符串</template></template>
    </p>
    <TableFailureState v-if="error" :title="`${title}分段加载失败`" :description="error" :pending="pending" compact @retry="next" />
    <pre v-if="total !== undefined && !isNull" class="max-h-80 overflow-auto whitespace-pre rounded-md border p-3 text-xs"><span v-for="(part, index) in textParts" :key="index">{{ part }}</span></pre>
    <Button v-if="!complete && !error" variant="outline" size="sm" class="self-start" :disabled="pending" data-action="chunk-next" @click="next">
      {{ pending ? '正在读取…' : total === undefined ? '读取首段' : '读取下一分段' }}
    </Button>
  </section>
</template>
