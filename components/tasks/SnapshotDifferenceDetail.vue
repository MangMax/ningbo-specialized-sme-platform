<script setup lang="ts">
import { platformBusinessFields } from '~~/lib/roster/platform-records'
import { computed } from 'vue'
import { useTaskPolling } from '~/composables/useTaskPolling'
import { DIFFERENCE_STATUSES, DIFFERENCE_REASONS, DIFFERENCE_MEASURES, TITLES } from '~~/lib/labels'
import type { snapshotJudgment } from '~~/server/utils/snapshot-judgment'
const props=defineProps<{id:string; row:{enterpriseId:number;titleCode:string;direction:string}}>()
const key=computed(()=>`${props.id}:${props.row.enterpriseId}:${props.row.titleCode}:${props.row.direction}`)
const {data,loading,failed,refresh}=useTaskPolling(key, signal=>$fetch<Awaited<ReturnType<typeof snapshotJudgment>>>(`/api/task-center/${encodeURIComponent(props.id)}/difference-detail`,{query:props.row,headers:{'x-task-center-browser':'1'},signal}))
const label=(status:string)=>status==='confirmed_no_diff'?'无差异':DIFFERENCE_STATUSES[status]??status
// Whitelist business fields. Raw JSON, transport metadata and local source paths stay out of this surface.
const fields:Record<string,string>={qymc:'企业名称',tyshxydm:'统一社会信用代码',rdjb:'认定级别',nd:'年度',nf:'年份',sqsj:'申请时间',rdsj:'认定时间',shzt:'审核状态',zt:'状态',szsfmc:'省份',szcsmc:'城市'}
</script>
<template>
 <section aria-label="差异详情" class="flex min-w-0 flex-col gap-3 break-words border p-4">
  <h3 class="font-medium">差异详情 · {{ TITLES[row.titleCode] }}</h3>
  <TableFailureState v-if="failed" title="详情读取失败" description="冻结出处不可读或请求失败，请重试。" :pending="loading" @retry="refresh" />
  <p v-if="loading && !data" role="status">正在读取详情…</p>
  <template v-if="data">
   <p>当前判断：{{ label(data.current.status) }} {{ DIFFERENCE_REASONS[data.current.reasonCode ?? ''] }}</p>
   <p>{{ data.current.notes || '尚无判断说明' }}</p>
   <p>措施：{{ DIFFERENCE_MEASURES[data.current.measureCode ?? ''] || '未记录' }}</p>
   <h4>查询范围与缺口</h4>
   <p>{{ data.current.searchedScope || '未记录已查范围' }}</p><p>{{ data.current.gaps || '未记录缺口' }}</p>
   <p>冻结企业范围：{{ data.officialScope.length }} 家</p>
   <p v-for="member in data.officialScope" :key="member.enterpriseId">{{ member.name || `企业 ${member.enterpriseId}` }} · {{ member.uscc || '信用代码未记录' }}</p>
   <h4>平台原始历史行</h4>
   <div v-for="item in data.platformHistory" :key="item.itemId" class="flex flex-col gap-2 border-b pb-2">
    <p>{{ item.source }} · {{ item.complete ? '采集完成' : '采集未完成' }}</p>
    <template v-for="(segment, index) in item.segments" :key="index">
     <div v-for="(record, ri) in segment.rows" :key="ri" class="border p-2">
      <p v-for="field in platformBusinessFields(record)" :key="field.key">{{ fields[field.key] || field.label }}：{{ field.value }}</p>
     </div>
    </template>
   </div>
   <p v-if="!data.platformHistory.length">本次快照没有平台历史行。</p>
   <h4>冻结公布出处</h4>
   <p v-for="(source, index) in (data.officialSources as Record<string,unknown>[])" :key="index">{{ TITLES[String(source.title_code)] }} · {{ source.year || '年度未记录' }} · {{ source.batch_seq || '批次未记录' }} · {{ typeof source.source_file==='string' ? source.source_file.split(/[\\/]/).pop() : '来源未记录' }} · {{ source.attachment || '附件未记录' }} · 名单序号 {{ source.list_no ?? '未记录' }} · 第 {{ source.page ?? '未记录' }} 页</p>
   <p v-if="!data.officialSources.length">未记录公布出处。</p>
   <h4>证据引用</h4>
   <p v-for="(evidence,index) in data.current.evidence" :key="index">{{ evidence.kind==='external' ? evidence.note : evidence.kind==='official' ? '冻结公布出处' : '本次平台历史行' }}<a v-if="evidence.kind==='external'" :href="evidence.url" target="_blank" rel="noopener noreferrer"> 查看来源</a></p>
   <h4>操作记录</h4>
   <p v-if="!data.operations.length">尚无操作记录。</p>
   <div v-for="op in data.operations" :key="op.id" class="border-b pb-2">
    <p>{{ op.recordedAt }} · {{ op.actor || '未记录' }}</p>
    <p>修改前：{{ label(op.before.status) }} {{ DIFFERENCE_REASONS[op.before.reasonCode ?? ''] }} · {{ op.before.notes || '未记录说明' }}</p>
    <p>修改后：{{ label(op.after.status) }} {{ DIFFERENCE_REASONS[op.after.reasonCode ?? ''] }} · {{ op.after.notes || '未记录说明' }}</p>
   </div>
  </template>
 </section>
</template>
