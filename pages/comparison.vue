<script setup lang="ts">
import { computed } from 'vue'
import SnapshotDifferenceQueue from '@/components/tasks/SnapshotDifferenceQueue.vue'
const route=useRoute()
const snapshotId=computed(()=>typeof route.query.snapshot==='string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(route.query.snapshot)?route.query.snapshot:'')
</script>
<template>
 <main class="flex min-w-0 flex-col gap-4 p-4">
  <PageHeader title="差异清单" description="选择一次任务的当前快照，查看待核队列与已判结果。" />
  <SnapshotDifferenceQueue v-if="snapshotId" :key="snapshotId" :id="snapshotId" />
  <p v-else>尚未选择差异快照。请从任务中心打开一次差异任务。</p>
  <NuxtLink to="/tasks">前往任务中心</NuxtLink>
 </main>
</template>
