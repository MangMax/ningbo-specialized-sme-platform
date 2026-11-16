<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RosterEnterpriseDetail } from '~~/lib/roster/enterprise-roster'
import { TITLES } from '~~/lib/labels'
import PlatformBusinessHistory from './PlatformBusinessHistory.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
const props = defineProps<{ timeline: RosterEnterpriseDetail['businessTimeline'] }>()
const source = ref('publication')
const title = ref('all')
const labels = { publication: '公布资料', recognized_list: '认定目录', business_list: '关联办理', apply_list: '申报记录' }
const statuses: Record<string, string> = { not_collected: '尚未采集', failed: '采集失败，保留已知业务记录', partial: '资料不完整', no_record: '未返回业务记录', not_queried: '尚未采集' }
const titles = computed(() => [...new Set(props.timeline.sources.flatMap(s => s.events.flatMap(e => e.title ? [e.title] : [])))])
</script>

<template>
  <Tabs v-model="source" class="min-w-0" data-testid="platform-records">
    <TabsList aria-label="业务来源" class="h-auto w-full flex-wrap justify-start gap-1">
      <TabsTrigger v-for="section in timeline.sources" :key="section.source" :value="section.source">{{ labels[section.source] }}</TabsTrigger>
    </TabsList>
    <Select v-model="title"><SelectTrigger class="max-w-full w-56" aria-label="业务称号"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部称号</SelectItem><SelectItem v-for="code in titles" :key="code" :value="code">{{ TITLES[code] ?? code }}</SelectItem></SelectContent></Select>
    <TabsContent v-for="section in timeline.sources" :key="section.source" :value="section.source" class="min-w-0">
      <p v-if="statuses[section.collectionStatus]" role="status" class="mb-2 text-sm">{{ statuses[section.collectionStatus] }}</p>
      <p v-if="section.collectedAt" class="text-muted-foreground mb-2 text-xs">最近采集：{{ section.collectedAt }}（辅助信息）</p>
      <div class="grid min-w-0 gap-3">
        <PlatformBusinessHistory v-for="event in section.events.filter(e => title === 'all' || e.title === title)" :key="event.key" :event="event" />
      </div>
      <p v-if="!section.events.filter(e => title === 'all' || e.title === title).length" class="text-muted-foreground py-3 text-sm">暂无已知业务事件</p>
      <slot v-if="section.source === 'publication'" name="publication" :title="title" />
    </TabsContent>
  </Tabs>
</template>
