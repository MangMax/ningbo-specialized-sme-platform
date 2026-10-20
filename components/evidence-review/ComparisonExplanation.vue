<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@pinia/colada'
import type { RosterEnterpriseDetail } from '~~/lib/roster/enterprise-roster'
import QueryAssessmentSummary from './QueryAssessmentSummary.vue'
import TableFailureState from '@/components/TableFailureState.vue'
const props = defineProps<{ enterpriseId: number; titleCode: string; direction: string; returnTo?: string }>()
const emit = defineEmits<{ navigate: [] }>()
const { data, error, isLoading, refetch } = useQuery({
  key: () => ['roster-enterprise', String(props.enterpriseId)],
  query: () => $fetch<RosterEnterpriseDetail>(`/api/roster/enterprises/${props.enterpriseId}`),
})
const assessment = computed(() => data.value?.titleAssessments.find(a => a.titleCode === props.titleCode && a.direction === props.direction))
const link = computed(() => `/enterprises/${props.enterpriseId}?tab=review&titleCode=${props.titleCode}&direction=${props.direction}${props.returnTo ? `&returnTo=${encodeURIComponent(props.returnTo)}` : ''}`)
</script>
<template>
  <div class="flex min-w-0 flex-col gap-1">
    <QueryAssessmentSummary v-if="assessment" :assessment="assessment" compact />
    <p v-else class="text-muted-foreground text-[13px]">{{ isLoading ? '正在读取查询覆盖与决定…' : '查询覆盖与决定尚未读取' }}</p>
    <TableFailureState
      v-if="error"
      title="解释状态读取失败"
      :description="`读取目标：企业 #${enterpriseId} · ${titleCode} · ${direction}。上次结果仍保留。`"
      compact
      :pending="isLoading"
      @retry="refetch()"
    />
    <NuxtLink :to="link" @click="emit('navigate')" class="text-primary text-[13px] hover:underline">查看决定历史与复核</NuxtLink>
  </div>
</template>
