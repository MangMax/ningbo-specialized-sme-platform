<script setup lang="ts">
import { DIFFERENCE_REASONS, DIFFERENCE_MEASURES } from '~~/lib/labels'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
export interface ReplacementDraft { status: string; reasonCode: string; reasonNote: string; measureCode: string; measureNote: string; evidenceQueryId: string; evidenceRelationId: string }
const draft = defineModel<ReplacementDraft>({ required: true })
</script>
<template>
  <fieldset class="flex min-w-0 flex-col gap-2">
    <legend class="mb-2 text-sm font-medium">追加更正（原决定和历史保留）</legend>
    <label class="flex flex-col gap-1 text-[13px]">更正结论<NativeSelect v-model="draft.status" aria-label="更正结论"><NativeSelectOption value="confirmed_reason">已确认原因</NativeSelectOption><NativeSelectOption value="confirmed_no_diff">已确认无差异</NativeSelectOption></NativeSelect></label>
    <label v-if="draft.status === 'confirmed_reason'" class="flex flex-col gap-1 text-[13px]">更正原因<NativeSelect v-model="draft.reasonCode" aria-label="更正原因"><NativeSelectOption value="">请选择，系统不推测</NativeSelectOption><NativeSelectOption v-for="(label, code) in DIFFERENCE_REASONS" :key="code" :value="code">{{ label }}</NativeSelectOption></NativeSelect></label>
    <label class="flex flex-col gap-1 text-[13px]">原因说明<Textarea v-model="draft.reasonNote" aria-label="原因说明" maxlength="4000" /></label>
    <label class="flex flex-col gap-1 text-[13px]">更正措施<NativeSelect v-model="draft.measureCode" aria-label="更正措施"><NativeSelectOption value="">请选择措施</NativeSelectOption><NativeSelectOption v-for="(label, code) in DIFFERENCE_MEASURES" :key="code" :value="code">{{ label }}</NativeSelectOption></NativeSelect></label>
    <p v-if="draft.reasonCode === 'pending_review'" class="text-muted-foreground text-[13px]">待审核原因须明确选择“保留正式公布历史并跟进审核”措施。</p>
    <p v-if="draft.status === 'confirmed_no_diff'" class="text-muted-foreground text-[13px]">确认无差异须明确选择“无需措施”；不填写原因。</p>
    <label class="flex flex-col gap-1 text-[13px]">措施说明<Textarea v-model="draft.measureNote" aria-label="措施说明" maxlength="4000" /></label>
    <label class="flex flex-col gap-1 text-[13px]">查询证据 ID（可选）<Input v-model="draft.evidenceQueryId" aria-label="查询证据 ID" inputmode="numeric" /></label>
    <label class="flex flex-col gap-1 text-[13px]">平台原行 ID（可选）<Input v-model="draft.evidenceRelationId" aria-label="平台原行 ID" inputmode="numeric" /></label>
  </fieldset>
</template>
