<script setup lang="ts">
import type { RosterEnterpriseDetail } from '#sme-roster/lib/roster/enterprise-roster'
import RosterTitleBadge from './TitleBadge.vue'
import DisclosurePanel from '../../../core/app/components/DisclosurePanel.vue'
import RosterEventChip from './EventChip.vue'
type BusinessEvent = RosterEnterpriseDetail['businessTimeline']['sources'][number]['events'][number]
defineProps<{ event: BusinessEvent }>()
const matters: Record<string, string> = { recognition: '认定', award: '认定', review: '复核', apply: '申报', update: '更新', cancel: '取消' }
const conclusions = { passed: '通过', invalid: '无效', processing: '办理中', unknown: '结论未知' }
</script>

<template>
  <article class="bg-card min-w-0 rounded-md border p-4 text-sm leading-6 break-words [overflow-wrap:anywhere]" data-testid="business-event">
    <h4 class="flex flex-wrap items-center gap-2"><RosterTitleBadge v-if="event.title" :code="event.title" /><span v-else>称号未知</span><RosterEventChip v-if="event.matter === 'award' || event.matter === 'review'" :type="event.matter" hide-batch /><span v-else>{{ matters[event.matter] ?? event.matterRaw ?? '事项未知' }}</span></h4>
    <p v-if="event.platformName" class="text-muted-foreground mt-1">来源原名：{{ event.platformName }}</p>
    <div class="mt-3 grid gap-x-6 gap-y-2 border-t pt-3 sm:grid-cols-2">
      <p><span class="text-muted-foreground">结论：</span>{{ conclusions[event.conclusion] }}<template v-if="event.statusRaw != null">（{{ event.statusRaw }}）</template></p>
      <p><span class="text-muted-foreground">{{ event.businessTimeKind === 'submission' ? '申报时间' : event.matter === 'review' ? '复核结论时间' : '业务时间' }}：</span>{{ event.businessTime.value?.replace('T', ' ') ?? '未知' }}</p>
      <p class="sm:col-span-2"><span class="text-muted-foreground">实际期间：</span><span class="inline-block">{{ event.period.from.value?.replace('T', ' ') ?? '起始未知' }}</span> 至 <span class="inline-block">{{ event.period.until.value?.replace('T', ' ') ?? '结束未知' }}</span></p>
    </div>
    <DisclosurePanel title="业务详情" trigger-class="py-2" content-class="pb-1">
      <p>原事项：{{ event.matterRaw ?? matters[event.matter] ?? '未知' }}</p>
      <p>业务年度：{{ event.businessYear ?? '未知' }}</p>
      <p class="text-muted-foreground">资料采集时间：{{ event.collectedAt ?? '未记录' }}（辅助信息）</p>
    </DisclosurePanel>
  </article>
</template>
