<script setup lang="ts">
import type { getParse105 } from '~~/server/utils/parse-maintenance-105'
import { Button } from '@/components/ui/button'
import { TITLES, EVENTS } from '~~/lib/labels'
const props = defineProps<{ fileId: number; sha256: string }>()
const { data, error, refresh } = await useFetch<{ state: ReturnType<typeof getParse105> }>(() => `/api/files/${props.fileId}/segments`)
</script>
<template>
  <div class="space-y-2 text-sm" aria-label="已登记物理页码范围">
    <p>物理页码范围（非正文印刷页码；仅页码不足以唯一定位企业）</p>
    <p v-if="error" role="alert">范围读取失败，不能确认当前范围。<Button variant="outline" @click="refresh()">重试读取范围</Button></p>
    <template v-else-if="data">
      <p v-for="d in data.state.declarations" :key="d.declarationId" class="break-words">
        {{ TITLES[d.part.titleCode] }} · {{ EVENTS[d.part.eventKind] }} · {{ d.part.year ?? '年份未知' }} / {{ d.part.batch ?? '批次未知' }} · {{ d.part.attachment ?? '附件未知' }}：
        {{ d.pageRanges === null ? '范围未知' : d.pageRanges.length ? d.pageRanges.map(r => `${r.start}–${r.end}页`).join('、') : '范围已清空' }}
        <span v-if="d.sha256 !== sha256">（来源已变化，须重新核实）</span>
      </p>
      <p v-if="!data.state.declarations.length">尚无范围声明；来源派生段不自动指定范围。</p>
    </template>
    <p v-else role="status">正在读取范围…</p>
  </div>
</template>
