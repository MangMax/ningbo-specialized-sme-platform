<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import type { DecisionVersion, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import DecisionVersionDetails from './DecisionVersionDetails.vue'
import TablePagination from '@/components/TablePagination.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import { Button } from '@/components/ui/button'
const props = defineProps<{ scope: ReviewScope }>()
const page = shallowRef(1), pageSize = shallowRef(25), selected = shallowRef<number | null>(null)
const previousVersion = shallowRef<DecisionVersion>()
watch(() => JSON.stringify(props.scope), () => { page.value = 1; selected.value = null; previousVersion.value = undefined })
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['decision-history', props.scope, page.value, pageSize.value],
  query: async ({ entry }) => {
    const query = { ...entry.key[1] as ReviewScope, page: entry.key[2] as number, pageSize: entry.key[3] as number }
    return { ...await $fetch<{ rows: Pick<DecisionVersion, 'id' | 'recordedAt' | 'status'>[]; total: number; page: number; pageSize: number }>('/api/roster/decision-lifecycle/history', { query }), scope: query }
  },
})
const previous = shallowRef<typeof data.value>()
watch(data, v => { if (v) previous.value = v }, { immediate: true, flush: 'sync' })
const displayed = computed(() => data.value ?? previous.value)
const { data: version, isLoading: versionLoading, error: versionError, refetch: reloadVersion } = useQuery({
  key: () => ['decision-version', selected.value], enabled: () => selected.value != null,
  query: ({ entry }) => $fetch<DecisionVersion>(`/api/roster/decision-lifecycle/${entry.key[1]}`),
})
watch(version, v => { if (v && selected.value != null) previousVersion.value = v }, { immediate: true, flush: 'sync' })
const displayedVersion = computed(() => selected.value == null ? undefined : version.value ?? previousVersion.value)
</script>
<template>
  <section class="flex min-w-0 flex-col gap-2" aria-label="决定历史">
    <h4 class="text-sm font-medium">决定历史</h4>
    <p v-if="isLoading" role="status">正在读取决定历史…</p>
    <TableFailureState v-if="error" title="决定历史读取失败" :pending="isLoading" @retry="refetch()" />
    <p v-if="displayed" class="text-muted-foreground text-[13px]">企业 #{{ displayed.scope.enterpriseId }} · {{ displayed.scope.titleCode }} · {{ displayed.scope.direction }} · 第 {{ displayed.page }} 页</p>
    <ul class="flex flex-col gap-1"><li v-for="row in displayed?.rows ?? []" :key="row.id"><Button size="sm" variant="ghost" :aria-label="`查看历史决定 ${row.id}`" @click="selected = row.id">决定 #{{ row.id }} · {{ row.recordedAt }}</Button></li></ul>
    <p v-if="versionLoading" role="status">正在读取历史决定原文…</p>
    <TableFailureState v-if="versionError" title="历史决定原文读取失败" :description="`读取目标：历史决定 #${selected}。可重试读取。`" :pending="versionLoading" @retry="reloadVersion()" />
    <p v-if="displayedVersion && displayedVersion.id !== selected" class="text-muted-foreground text-[13px]">显示来源：历史决定 #{{ displayedVersion.id }}；读取目标：历史决定 #{{ selected }}</p>
    <DecisionVersionDetails v-if="displayedVersion" :decision="displayedVersion" label="历史决定" />
    <TablePagination v-if="displayed" :page="displayed.page" :page-size="displayed.pageSize" :total="displayed.total" unit="个版本" :loading="isLoading || !!error" @update:page="page = $event" @update:page-size="pageSize = Math.min(50, $event); page = 1" />
  </section>
</template>
