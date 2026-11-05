<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTaskPolling } from '~/composables/useTaskPolling'
import { TITLES, DIFFERENCE_STATUSES } from '~~/lib/labels'
import type { readSnapshotQueue } from '~~/server/utils/difference-queue'
const props=defineProps<{id:string}>()
const page=ref(1), pageSize=ref(25)
const key=computed(()=>`${props.id}:${page.value}:${pageSize.value}`)
const {data,sourceKey,loading,failed,refresh}=useTaskPolling(key,async signal=>{const result=await $fetch<ReturnType<typeof readSnapshotQueue>>(`/api/task-center/${encodeURIComponent(props.id)}/difference-queue`,{query:{page:page.value,pageSize:pageSize.value},headers:{'x-task-center-browser':'1'},signal}); if(!Array.isArray(result.rows)||!Array.isArray(result.unfinished)) throw new Error('Invalid queue response'); return result })
function resize(value:number) {pageSize.value=value;page.value=1}
</script>
<template>
  <section aria-label="快照待核队列" class="flex min-w-0 flex-col gap-3">
    <h3 class="font-medium">快照待核队列</h3>
    <TableFailureState v-if="failed" title="队列暂不可读" description="采集尚未结束或读取失败，请重试。保留上次读取的页。" :pending="loading" @retry="refresh" />
    <p v-if="loading && !data" role="status">正在读取待核队列…</p>
    <template v-if="data">
      <p v-if="sourceKey !== key" role="status">当前显示上次成功读取的第 {{ data.page }} 页。</p>
      <p v-if="data.unfinished.length" role="status">{{ data.unfinished.length }} 家企业的覆盖或记录信息未完成，尚未推导候选。</p>
      <p v-if="!data.total">暂无待核候选。</p>
      <ul class="flex flex-col gap-2">
        <li v-for="row in data.rows" :key="`${row.enterpriseId}:${row.titleCode}:${row.direction}`" class="flex flex-wrap gap-2 border-b pb-2">
          <NuxtLink :to="`/enterprises/${row.enterpriseId}`">企业详情</NuxtLink>
          <span>{{ TITLES[row.titleCode] ?? row.titleCode }}</span>
          <span>{{ row.direction === 'missing_in_miit' ? '只在公布' : '只在平台' }}</span>
          <span>{{ DIFFERENCE_STATUSES[row.status as keyof typeof DIFFERENCE_STATUSES] ?? row.status }}</span>
        </li>
      </ul>
      <TablePagination :page="page" :page-size="pageSize" :total="data.total" :loading="loading" unit="条" @update:page="page=$event" @update:page-size="resize" />
    </template>
  </section>
</template>
