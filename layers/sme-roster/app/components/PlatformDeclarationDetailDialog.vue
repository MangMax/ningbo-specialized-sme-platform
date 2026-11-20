<script setup lang="ts">
import { projectionDisplay } from '#sme-roster/lib/platform/projection-display'
import { ref, watch } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#core/app/components/ui/dialog'
import { Badge } from '#core/app/components/ui/badge'
import { Skeleton } from '#core/app/components/ui/skeleton'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import type { DeclarationDetail } from '#sme-roster/lib/platform/declarations'
import { PLATFORM_RDJBS, RELATION_DECLARE_KINDS } from '#sme-roster/lib/labels'
import { formatFetchTime } from '#sme-roster/lib/reconcile-time'

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
const time = (value: string | null) => value ? formatFetchTime(value) ?? value : '未提供'
const declareKind = (value: string | null) => value ? RELATION_DECLARE_KINDS[value] ?? value : '事项未提供'
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-3xl" data-testid="platform-declaration-detail">
      <DialogHeader>
        <DialogTitle>申报记录 · 版本详情</DialogTitle>
        <DialogDescription class="sr-only">查看历次申报的称号、日期和结果</DialogDescription>
      </DialogHeader>
      <div v-if="loading && !data" class="flex flex-col gap-2"><Skeleton class="h-24 w-full" /><Skeleton class="h-40 w-full" /></div>
      <TableFailureState v-else-if="error" title="申报记录加载失败" :description="error" :pending="loading" @retry="recordId != null && load(recordId)" />
      <div v-else-if="data" class="flex min-w-0 flex-col gap-5">
        <section class="min-w-0">
          <h3 class="text-sm font-medium">内容版本 <span class="text-muted-foreground font-normal">{{ data.counts.versions }} 个<template v-if="data.counts.versionsTruncated">（仅显示前 {{ data.versions.length }} 个）</template></span></h3>
          <div class="mt-2 flex flex-col gap-2">
            <article v-for="version in data.versions" :key="version.versionId" class="rounded-sm border p-3" data-testid="platform-declaration-version">
              <p v-if="version.ruleVersion == null" class="text-muted-foreground text-table">该版本暂无可核对的业务内容</p>
              <template v-else>
                <div class="flex flex-wrap items-baseline gap-2">
                  <Badge variant="outline">{{ projectionDisplay(version, version.declareKind, declareKind) }}</Badge>
                  <span class="text-muted-foreground text-xs">年度 {{ projectionDisplay(version, version.declarationYear) }} · 状态 {{ projectionDisplay(version, version.status) }}</span>
                </div>
                <dl class="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-table sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <dt class="text-muted-foreground">称号</dt><dd>{{ projectionDisplay(version, version.titleRaw, projectionTitle) }}</dd>
                  <dt class="text-muted-foreground">平台登记名称</dt><dd>{{ projectionDisplay(version, version.nameRaw) }} · {{ projectionDisplay(version, version.usccRaw) }}</dd>
                  <dt class="text-muted-foreground">申报时间</dt><dd>{{ projectionDisplay(version, version.appliedAt, time) }}</dd>
                </dl>
              </template>
            </article>
          </div>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
