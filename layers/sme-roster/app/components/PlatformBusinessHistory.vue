<script setup lang="ts">
import type { RosterEnterpriseDetail } from '#sme-roster/lib/roster/enterprise-roster'
import RosterTitleBadge from './TitleBadge.vue'
import RosterEventChip from './EventChip.vue'
type BusinessEvent = RosterEnterpriseDetail['businessTimeline']['sources'][number]['events'][number]
defineProps<{ event: BusinessEvent }>()
const matters: Record<string, string> = { recognition: '认定', award: '认定', review: '复核', apply: '申报', update: '更新', cancel: '取消', nurture: '入库培育' }
const conclusions = { passed: '通过', invalid: '无效', processing: '办理中', unknown: '结论未知' }
</script>

<template>
  <article class="min-w-0 px-3.5 py-2.5 text-table leading-5 break-words [overflow-wrap:anywhere]" data-testid="business-event">
    <div class="flex flex-wrap items-center gap-2">
      <RosterTitleBadge v-if="event.title" :code="event.title" />
      <span v-else class="font-medium">称号未知</span>
      <RosterEventChip v-if="event.matter === 'award' || event.matter === 'review'" :type="event.matter" hide-batch />
      <span v-else class="text-muted-foreground text-xs">{{ matters[event.matter] ?? '事项未记录' }}</span>
      <span v-if="event.platformName" class="text-muted-foreground text-xs">· 平台登记名称：{{ event.platformName }}</span>
    </div>
    <dl class="mt-1.5 grid grid-cols-1 gap-x-5 gap-y-1 text-table sm:grid-cols-2">
      <div class="flex items-baseline gap-1"><dt class="text-muted-foreground shrink-0 text-xs">结论：</dt><dd>{{ conclusions[event.conclusion] }}</dd></div>
      <div class="flex items-baseline gap-1"><dt class="text-muted-foreground shrink-0 text-xs">{{ event.businessTimeKind === 'submission' ? '申报时间' : event.matter === 'review' ? '复核结论时间' : '业务时间' }}：</dt><dd class="tabular-nums">{{ event.businessTime.value?.replace('T', ' ') ?? '未知' }}</dd></div>
      <div v-if="event.businessYear != null && event.businessTime.value !== String(event.businessYear)" class="flex items-baseline gap-1"><dt class="text-muted-foreground shrink-0 text-xs">业务年度：</dt><dd class="tabular-nums">{{ event.businessYear }}</dd></div>
      <div class="flex items-baseline gap-1 sm:col-span-2"><dt class="text-muted-foreground shrink-0 text-xs">实际期间：</dt><dd class="tabular-nums"><span class="inline-block">{{ event.period.from.value?.replace('T', ' ') ?? '起始未知' }}</span> 至 <span class="inline-block">{{ event.period.until.value?.replace('T', ' ') ?? '结束未知' }}</span></dd></div>
    </dl>
  </article>
</template>
