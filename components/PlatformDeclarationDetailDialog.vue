<script setup lang="ts">
import { projectionDisplay } from '~~/lib/platform/projection-display'
import { ref, watch } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#core/app/components/ui/dialog'
import { Badge } from '#core/app/components/ui/badge'
import { Skeleton } from '#core/app/components/ui/skeleton'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import type { DeclarationDetail } from '~~/lib/platform/declarations'
import { PLATFORM_RDJBS, RELATION_DECLARE_KINDS } from '#sme-roster/lib/labels'
import { formatFetchTime } from '~~/lib/reconcile-time'

const props = defineProps<{ recordId: number | null; open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const data = ref<DeclarationDetail>()
const loading = ref(false)
const error = ref('')
let generation = 0

async function load(id: number) {
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await $fetch<DeclarationDetail>(`/api/platform/declarations/${id}`, { retry: 0 })
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
const missing = (value: string | number | null | undefined) => value === null || value === undefined || value === '' ? '未提供' : String(value)
const time = (value: string | null) => value ? formatFetchTime(value) ?? value : '未提供'
const declareKind = (value: string | null) => value ? RELATION_DECLARE_KINDS[value] ?? value : '事项未提供'
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl" data-testid="platform-declaration-detail">
      <DialogHeader>
        <DialogTitle>申报记录 · 版本详情</DialogTitle>
        <DialogDescription>版本按内容版本编号排列，不代表时间顺序。</DialogDescription>
      </DialogHeader>
      <div v-if="loading && !data" class="flex flex-col gap-2"><Skeleton class="h-24 w-full" /><Skeleton class="h-40 w-full" /></div>
      <TableFailureState v-else-if="error" :title="`申报记录 #${recordId} 加载失败`" :description="error" :pending="loading" @retry="recordId != null && load(recordId)" />
      <div v-else-if="data" class="flex min-w-0 flex-col gap-5">
        <section class="min-w-0">
          <h3 class="text-sm font-medium">记录身份</h3>
          <dl class="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-table sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <dt class="text-muted-foreground">来源</dt><dd>{{ data.record.interface }}</dd>
            <dt class="text-muted-foreground">身份规则</dt><dd>{{ data.record.identityRuleVersion }}</dd>
            <dt class="text-muted-foreground">建立时间</dt><dd>{{ time(data.record.createdAt) }}</dd>
          </dl>
        </section>
        <section class="min-w-0">
          <h3 class="text-sm font-medium">内容版本 <span class="text-muted-foreground font-normal">{{ data.counts.versions }} 个<template v-if="data.counts.versionsTruncated">（仅显示前 {{ data.versions.length }} 个）</template></span></h3>
          <div class="mt-2 flex flex-col gap-2">
            <article v-for="version in data.versions" :key="version.versionId" class="rounded-sm border p-3" data-testid="platform-declaration-version">
              <div class="flex flex-wrap items-baseline gap-2">
                <span class="text-sm font-medium">版本 #{{ version.versionId }}</span>
                <Badge variant="outline">{{ projectionDisplay(version, version.declareKind, declareKind) }}</Badge>
                <span class="text-muted-foreground text-xs">年度 {{ projectionDisplay(version, version.declarationYear) }} · 状态 {{ projectionDisplay(version, version.status) }}</span>
              </div>
              <dl class="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-table sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <dt class="text-muted-foreground">称号</dt><dd>{{ projectionDisplay(version, version.titleRaw, projectionTitle) }}</dd>
                <dt class="text-muted-foreground">企业原值</dt><dd>{{ projectionDisplay(version, version.nameRaw) }} · {{ projectionDisplay(version, version.usccRaw) }}</dd>
                <dt class="text-muted-foreground">申报时间</dt><dd>{{ projectionDisplay(version, version.appliedAt, time) }}</dd>
                <dt class="text-muted-foreground">规则版本</dt><dd>{{ missing(version.ruleVersion) }}</dd>
                <dt class="text-muted-foreground">采集时间</dt><dd>首次 {{ time(version.firstObservedAt) }} · 最近 {{ time(version.lastObservedAt) }}</dd>
                <dt class="text-muted-foreground">内容哈希</dt><dd class="break-all font-mono text-xs">{{ version.hashAlgorithm }} · {{ version.contentHash }}</dd>
              </dl>
            </article>
          </div>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
