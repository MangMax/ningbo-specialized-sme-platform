<script setup lang="ts">
import { projectionDisplay } from '#sme-roster/lib/platform/projection-display'
import { ref, watch } from 'vue'
import ModalDialog from '#core/app/components/ModalDialog.vue'
import { Badge } from '#core/app/components/ui/badge'
import { Skeleton } from '#core/app/components/ui/skeleton'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import type { RecognizedDirectoryDetail } from '#sme-roster/lib/platform/recognized-directory'
import { PLATFORM_RDJBS } from '#sme-roster/lib/labels'

const props = defineProps<{ recordId: number | null; open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const data = ref<RecognizedDirectoryDetail>()
const loading = ref(false)
const error = ref('')
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
  void load(id)
}, { immediate: true })

const projectionTitle = (rawCode: string) => PLATFORM_RDJBS[rawCode] ?? rawCode
const conflictLabel: Record<string, string> = {
  enterprise_assignment_conflict: '企业归属冲突',
  unverifiable_observation: '存在内容未核实观察',
}
</script>

<template>
  <ModalDialog
    :open="open"
    title="平台认定目录 · 详情"
    description="查看当前认定的有效期、批次和称号"
    hide-description
    size="xl"
    content-test-id="platform-recognized-directory-detail"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="loading && !data" class="flex flex-col gap-2"><Skeleton class="h-24 w-full" /><Skeleton class="h-40 w-full" /></div>
    <TableFailureState v-else-if="error" title="平台认定目录加载失败" :description="error" :pending="loading" @retry="recordId != null && load(recordId)" />
    <div v-else-if="data" class="flex min-w-0 flex-col gap-5">
      <div v-if="data.conflicts.length" class="flex flex-wrap gap-1" data-testid="platform-recognized-directory-conflicts">
        <Badge v-for="conflict in data.conflicts.filter(value => value !== 'title_conflict')" :key="conflict" variant="outline">{{ conflictLabel[conflict] ?? conflict }}</Badge>
      </div>
      <section class="min-w-0">
        <article v-if="data.current" class="rounded-lg border p-3.5" data-testid="platform-recognized-directory-current">
          <p v-if="data.current.ruleVersion == null" class="text-muted-foreground text-table">暂无可核对的业务内容</p>
          <template v-else>
            <div class="flex flex-wrap items-baseline gap-2">
              <Badge variant="outline">有效期 {{ projectionDisplay(data.current, data.current.validityDateRaw) }}</Badge>
            </div>
            <dl class="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-table sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <dt class="text-muted-foreground">维护批次</dt><dd>{{ projectionDisplay(data.current, data.current.maintenanceBatch) }}</dd>
              <dt class="text-muted-foreground">属地</dt><dd class="font-mono break-all">{{ projectionDisplay(data.current, data.current.district) }}</dd>
              <dt class="text-muted-foreground">平台认定说明</dt><dd class="whitespace-pre-wrap break-words">{{ projectionDisplay(data.current, data.current.awardNote) }}</dd>
              <dt class="text-muted-foreground">称号</dt><dd>{{ projectionDisplay(data.current, data.current.titleRaw, projectionTitle) }}</dd>
              <dt class="text-muted-foreground">企业</dt><dd>{{ projectionDisplay(data.current, data.current.nameRaw) }} · {{ projectionDisplay(data.current, data.current.usccRaw) }}</dd>
            </dl>
          </template>
        </article>
        <p v-else class="text-muted-foreground text-table">暂无可核对的业务内容</p>
      </section>
    </div>
  </ModalDialog>
</template>
