<script setup lang="ts">
import { DIFFERENCE_REASONS, DIFFERENCE_MEASURES } from '~~/lib/labels'
import { computed } from 'vue'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
export interface ReplacementDraft { status: string; reasonCode: string; reasonNote: string; measureCode: string; measureNote: string; evidenceQueryId: string; evidenceRelationId: string }
const draft = defineModel<ReplacementDraft>({ required: true })
/** Reka Select 不接受空字符串值；用不落库的哨兵值表达“尚未选择”。 */
const UNSET = '__unset'
const reasonCode = computed({
  get: () => draft.value.reasonCode || UNSET,
  set: value => { draft.value = { ...draft.value, reasonCode: value === UNSET ? '' : value } },
})
const measureCode = computed({
  get: () => draft.value.measureCode || UNSET,
  set: value => { draft.value = { ...draft.value, measureCode: value === UNSET ? '' : value } },
})
</script>
<template>
  <fieldset class="flex min-w-0 flex-col gap-2">
    <legend class="mb-2 text-sm font-medium">追加更正（原决定和历史保留）</legend>
    <label class="flex flex-col gap-1 text-[13px]">
      更正结论
      <Select v-model="draft.status">
        <SelectTrigger class="w-full" aria-label="更正结论"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="confirmed_reason">已确认原因</SelectItem>
            <SelectItem value="confirmed_no_diff">已确认无差异</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
    <label v-if="draft.status === 'confirmed_reason'" class="flex flex-col gap-1 text-[13px]">
      更正原因
      <Select v-model="reasonCode">
        <SelectTrigger class="w-full" aria-label="更正原因"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem :value="UNSET">请选择，系统不推测</SelectItem>
            <SelectItem v-for="(label, code) in DIFFERENCE_REASONS" :key="code" :value="code">{{ label }}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
    <label class="flex flex-col gap-1 text-[13px]">原因说明<Textarea v-model="draft.reasonNote" aria-label="原因说明" maxlength="4000" /></label>
    <label class="flex flex-col gap-1 text-[13px]">
      更正措施
      <Select v-model="measureCode">
        <SelectTrigger class="w-full" aria-label="更正措施"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem :value="UNSET">请选择措施</SelectItem>
            <SelectItem v-for="(label, code) in DIFFERENCE_MEASURES" :key="code" :value="code">{{ label }}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
    <p v-if="draft.reasonCode === 'pending_review'" class="text-muted-foreground text-[13px]">待审核原因须明确选择“保留正式公布历史并跟进审核”措施。</p>
    <p v-if="draft.status === 'confirmed_no_diff'" class="text-muted-foreground text-[13px]">确认无差异须明确选择“无需措施”；不填写原因。</p>
    <label class="flex flex-col gap-1 text-[13px]">措施说明<Textarea v-model="draft.measureNote" aria-label="措施说明" maxlength="4000" /></label>
    <label class="flex flex-col gap-1 text-[13px]">查询证据 ID（可选）<Input v-model="draft.evidenceQueryId" aria-label="查询证据 ID" inputmode="numeric" /></label>
    <label class="flex flex-col gap-1 text-[13px]">平台原行 ID（可选）<Input v-model="draft.evidenceRelationId" aria-label="平台原行 ID" inputmode="numeric" /></label>
  </fieldset>
</template>
