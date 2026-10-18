<script setup lang="ts">
import { ref, watch } from 'vue'
import CorrespondenceItem from './CorrespondenceItem.vue'
import type { CorrespondenceDetail } from '~~/lib/roster/correspondence-view'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

const props = defineProps<{ enterpriseId: number; returnTo?: string | null }>()
type Result = { rows: CorrespondenceDetail[]; total: number; page: number; pageSize: number }
const page = ref(1)
const pageSize = ref(25)
const displayed = ref<Result | null>(null)
const loading = ref(false)
const error = ref(false)
let requestId = 0
async function load() {
  const current = ++requestId
  loading.value = true
  error.value = false
  try {
    const result = await $fetch<Result>('/api/roster/correspondences', { query: { enterpriseId: props.enterpriseId, type: 'later_process', page: page.value, pageSize: pageSize.value } })
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
      <ul v-if="displayed?.rows.length" class="flex min-w-0 flex-col gap-2"><CorrespondenceItem v-for="edge in displayed.rows" :key="edge.id" :edge="edge" :return-to="returnTo" /></ul>
      <p v-else-if="!loading && !error" class="text-muted-foreground text-[13px]">尚无已登记的后续流程。此处不推断平台没有原行。</p>
      <TablePagination v-if="displayed" class="mt-4" :page="displayed.page" :page-size="displayed.pageSize" :total="displayed.total" unit="条流程" :loading="loading || error" @update:page="setPage" @update:page-size="setPageSize" />
    </CardContent>
  </Card>
</template>
