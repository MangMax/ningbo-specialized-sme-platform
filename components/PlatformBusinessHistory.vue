<script setup lang="ts">
import type { RosterEnterpriseDetail } from '~~/lib/roster/enterprise-roster'
import TitleBadge from './TitleBadge.vue'
import DisclosurePanel from './DisclosurePanel.vue'
import EventChip from './EventChip.vue'
type BusinessEvent = RosterEnterpriseDetail['businessTimeline']['sources'][number]['events'][number]
defineProps<{ event: BusinessEvent }>()
const matters: Record<string, string> = { recognition: '认定', award: '认定', review: '复核', apply: '申报', update: '更新', cancel: '取消' }
const conclusions = { passed: '通过', invalid: '无效', processing: '办理中', unknown: '结论未知' }
</script>

<template>
  <article class="min-w-0 rounded-md border p-3 text-sm leading-6 break-words [overflow-wrap:anywhere]" data-testid="business-event">
    <h4 class="flex flex-wrap items-center gap-2"><TitleBadge v-if="event.title" :code="event.title" /><span v-else>称号未知</span><EventChip v-if="event.matter === 'award' || event.matter === 'review'" :type="event.matter" hide-batch /><span v-else>{{ matters[event.matter] ?? event.matterRaw ?? '事项未知' }}</span></h4>
    <p v-if="event.platformName">来源原名：{{ event.platformName }}</p>
    <p>结论：{{ conclusions[event.conclusion] }}<template v-if="event.statusRaw != null">（{{ event.statusRaw }}）</template></p>
    <p>{{ event.businessTimeKind === 'submission' ? '申报时间' : event.matter === 'review' ? '复核结论时间' : '业务时间' }}：{{ event.businessTime.value ?? '未知' }}</p>
    <p>实际期间：{{ event.period.from.value ?? '起始未知' }} 至 {{ event.period.until.value ?? '结束未知' }}</p>
    <DisclosurePanel title="业务详情" trigger-class="py-2" content-class="pb-1">
      <p>原事项：{{ event.matterRaw ?? matters[event.matter] ?? '未知' }}</p>
      <p>业务年度：{{ event.businessYear ?? '未知' }}</p>
      <p class="text-muted-foreground">资料采集时间：{{ event.collectedAt ?? '未记录' }}（辅助信息）</p>
    </DisclosurePanel>
  </article>
</template>
