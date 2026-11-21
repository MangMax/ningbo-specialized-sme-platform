<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RosterEnterpriseDetail } from '#sme-roster/lib/roster/enterprise-roster'
import { TITLES } from '#sme-roster/lib/labels'
import RosterPlatformBusinessHistory from './PlatformBusinessHistory.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
const props = defineProps<{ timeline: RosterEnterpriseDetail['businessTimeline'] }>()
const source = ref('publication')
const title = ref('all')
const labels = { publication: '公布资料', recognized_list: '认定目录', business_list: '关联办理', apply_list: '申报记录' }
const statuses: Record<string, string> = { not_collected: '尚未采集', failed: '采集失败，保留已知业务记录', partial: '资料不完整', no_record: '未返回业务记录', not_queried: '尚未采集' }
const titles = computed(() => [...new Set(props.timeline.sources.flatMap(s => s.events.flatMap(e => e.title ? [e.title] : [])))])
</script>

<template>
  <Tabs v-model="source" class="bg-card min-w-0 gap-0 overflow-hidden rounded-lg border" data-testid="platform-records">
    <header class="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
      <h2 class="text-base font-semibold">业务时间线</h2>
      <Select v-model="title"><SelectTrigger class="w-full sm:w-56" aria-label="业务称号"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部称号</SelectItem><SelectItem v-for="code in titles" :key="code" :value="code">{{ TITLES[code] ?? code }}</SelectItem></SelectContent></Select>
    </header>
    <div class="border-b px-4 py-3">
    <TabsList aria-label="业务来源" class="grid h-auto w-full grid-cols-2 gap-1 sm:flex sm:w-fit">
      <TabsTrigger v-for="section in timeline.sources" :key="section.source" :value="section.source">{{ labels[section.source] }}</TabsTrigger>
    </TabsList>
    </div>
    <TabsContent v-for="section in timeline.sources" :key="section.source" :value="section.source" class="min-w-0 space-y-3 p-4">
      <p v-if="statuses[section.collectionStatus]" role="status" class="mb-2 text-sm">{{ statuses[section.collectionStatus] }}</p>
      <template v-if="section.source !== 'publication' || !$slots.publication">
      <div class="grid min-w-0 gap-3">
        <RosterPlatformBusinessHistory v-for="event in section.events.filter(e => title === 'all' || e.title === title)" :key="event.key" :event="event" />
      </div>
      <p v-if="!section.events.filter(e => title === 'all' || e.title === title).length" class="text-muted-foreground rounded-md bg-muted/40 px-4 py-6 text-center text-sm">暂无已知业务事件</p>
      </template>
      <slot v-if="section.source === 'publication'" name="publication" :title="title" />
    </TabsContent>
  </Tabs>
</template>
