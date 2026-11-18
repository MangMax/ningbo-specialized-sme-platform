<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import TableFailureState from '@/components/TableFailureState.vue'

interface RosterStats {
  totalRecords: number
  totalEnterprises: number
}

const { data, error, isLoading, refetch } = useQuery({
  key: () => ['stats'],
  query: () => $fetch<RosterStats>('/api/stats'),
})
</script>

<template>
  <div class="space-y-3">
    <p v-if="data" class="text-muted-foreground text-sm tabular-nums">
      名录记录 <strong class="text-foreground font-semibold">{{ data.totalRecords.toLocaleString('zh-CN') }}</strong> 个企业×称号
      · <strong class="text-foreground font-semibold">{{ data.totalEnterprises.toLocaleString('zh-CN') }}</strong> 家有称号企业
    </p>
    <TableFailureState
      v-if="error"
      compact
      title="名录统计加载失败"
      :description="data ? '显示的是上次加载的统计。' : '可以重新加载名录统计。'"
      :pending="isLoading"
      @retry="refetch()"
    />
    <p v-else-if="isLoading && !data" role="status" class="text-muted-foreground text-sm">
      正在加载名录统计…
    </p>
  </div>
</template>
