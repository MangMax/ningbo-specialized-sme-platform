<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTaskPolling } from '~/composables/useTaskPolling'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import TableLoadingStatus from '@/components/TableLoadingStatus.vue'
import SnapshotDifferenceDetail from './SnapshotDifferenceDetail.vue'
import { TITLES, DIFFERENCE_STATUSES, DIFFERENCE_REASONS } from '~~/lib/labels'
import type { readSnapshotQueue } from '~~/server/utils/difference-queue'
const props=defineProps<{id:string}>()
const view=ref('pending'), status=ref('all'), reasonCode=ref('all')
const selected=ref< {enterpriseId:number;titleCode:string;direction:string} | null>(null)
watch([view,status,reasonCode],()=>{page.value=1;selected.value=null})
const page=ref(1), pageSize=ref(25)
const key=computed(()=>`${props.id}:${page.value}:${pageSize.value}:${view.value}:${status.value}:${reasonCode.value}`)
const {data,sourceKey,loading,failed,refresh}=useTaskPolling(key,async signal=>{const selection={view:view.value,status:status.value,reasonCode:reasonCode.value,page:page.value};const result=await $fetch<ReturnType<typeof readSnapshotQueue>>(`/api/task-center/${encodeURIComponent(props.id)}/difference-queue`,{query:{page:page.value,pageSize:pageSize.value,view:view.value,status:status.value==='all'?undefined:status.value,reasonCode:reasonCode.value==='all'?undefined:reasonCode.value},headers:{'x-task-center-browser':'1'},signal}); if(!Array.isArray(result.rows)||!Array.isArray(result.unfinished)) throw new Error('Invalid queue response'); return {...result,selection} })
function scopeLabel(scope:{view:string;status:string;reasonCode:string;page:number}) { return `${scope.view==='pending'?'待核队列':'已判结果'} / ${scope.status==='all'?'全部状态':scope.status==='confirmed_no_diff'?'无差异':DIFFERENCE_STATUSES[scope.status] ?? scope.status} / ${scope.reasonCode==='all'?'全部原因':DIFFERENCE_REASONS[scope.reasonCode] ?? scope.reasonCode} / 第 ${scope.page} 页` }
function resize(value:number) {pageSize.value=value;page.value=1}
</script>
<template>
  <section aria-label="任务差异队列" class="relative flex min-w-0 flex-col gap-3">
    <TableLoadingStatus :loading="loading" kind="comparison" label="正在读取任务差异…" />
    <h3 class="font-medium">任务差异</h3>
    <Tabs v-model="view"><TabsList><TabsTrigger value="pending">待核队列</TabsTrigger><TabsTrigger value="judged">已判结果</TabsTrigger></TabsList></Tabs>
    <div class="flex flex-wrap gap-2">
      <Select v-model="status"><SelectTrigger aria-label="筛选状态" class="w-full sm:w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem v-for="(label,code) in DIFFERENCE_STATUSES" :key="code" :value="code">{{ code==='confirmed_no_diff'?'无差异':label }}</SelectItem></SelectContent></Select>
      <Select v-model="reasonCode"><SelectTrigger aria-label="筛选原因" class="w-full sm:w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部原因</SelectItem><SelectItem v-for="(label,code) in DIFFERENCE_REASONS" :key="code" :value="code">{{ label }}</SelectItem></SelectContent></Select>
    </div>
    <p>判断由代理写回；需要改判时请向代理说明。</p>
    <TableFailureState v-if="failed" title="队列暂不可读" description="采集尚未结束或读取失败，请重试。保留上次读取的页。" :pending="loading" @retry="refresh" />
    <p v-if="loading && !data" role="status">正在读取任务差异…</p>
    <template v-if="data">
      <p v-if="sourceKey !== key" role="status">当前显示上次成功读取：{{ scopeLabel(data.selection) }}。本次请求：{{ scopeLabel({view,status,reasonCode,page}) }}{{ failed ? '读取失败。' : '正在读取。' }}</p>
      <p v-if="data.unfinished.length" role="status">{{ data.unfinished.length }} 家企业的覆盖或记录信息未完成，尚未推导候选。</p>
      <p v-if="!data.total">{{ data.selection.view==='pending'?'暂无待核候选。':'暂无符合筛选的已判结果。' }}</p>
      <ul class="flex flex-col gap-2">
        <li v-for="row in data.rows" :key="`${row.enterpriseId}:${row.titleCode}:${row.direction}`" class="flex flex-wrap gap-2 border-b pb-2">
          <NuxtLink :to="`/enterprises/${row.enterpriseId}`">企业详情</NuxtLink>
          <span>{{ TITLES[row.titleCode] ?? row.titleCode }}</span>
          <span>{{ row.direction === 'missing_in_miit' ? '只在公布' : '只在平台' }}</span>
          <span>{{ row.status==='confirmed_no_diff'?'无差异':DIFFERENCE_STATUSES[row.status] ?? row.status }}</span>
          <span>{{ DIFFERENCE_REASONS[row.reasonCode ?? ''] }}</span>
          <Button variant="outline" size="sm" @click="selected=row">查看详情 · 企业 {{ row.enterpriseId }}</Button>
        </li>
      </ul>
      <TablePagination :page="data.page" :page-size="pageSize" :total="data.total" :loading="loading" unit="条" @update:page="page=$event" @update:page-size="resize" />
      <SnapshotDifferenceDetail v-if="selected" :key="`${id}:${selected.enterpriseId}:${selected.titleCode}:${selected.direction}`" :id="id" :row="selected" />
    </template>
  </section>
</template>
