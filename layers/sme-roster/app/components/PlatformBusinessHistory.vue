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
  <article class="bg-card min-w-0 rounded-md border p-4 text-sm leading-6 break-words [overflow-wrap:anywhere]" data-testid="business-event">
    <h4 class="flex flex-wrap items-center gap-2">
      <RosterTitleBadge v-if="event.title" :code="event.title" />
      <span v-else>称号未知</span>
      <RosterEventChip v-if="event.matter === 'award' || event.matter === 'review'" :type="event.matter" hide-batch />
      <span v-else>{{ matters[event.matter] ?? '事项未记录' }}</span>
    </h4>
    <p v-if="event.platformName" class="text-muted-foreground mt-1">平台登记名称：{{ event.platformName }}</p>
    <div class="mt-3 grid gap-x-6 gap-y-2 border-t pt-3 sm:grid-cols-2">
      <p><span class="text-muted-foreground">结论：</span>{{ conclusions[event.conclusion] }}</p>
      <p><span class="text-muted-foreground">{{ event.businessTimeKind === 'submission' ? '申报时间' : event.matter === 'review' ? '复核结论时间' : '业务时间' }}：</span>{{ event.businessTime.value?.replace('T', ' ') ?? '未知' }}</p>
      <p v-if="event.businessYear != null && event.businessTime.value !== String(event.businessYear)"><span class="text-muted-foreground">业务年度：</span>{{ event.businessYear }}</p>
      <p class="sm:col-span-2"><span class="text-muted-foreground">实际期间：</span><span class="inline-block">{{ event.period.from.value?.replace('T', ' ') ?? '起始未知' }}</span> 至 <span class="inline-block">{{ event.period.until.value?.replace('T', ' ') ?? '结束未知' }}</span></p>
    </div>
  </article>
</template>
