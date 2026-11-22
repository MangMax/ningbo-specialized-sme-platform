<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '#core/app/components/ui/button'
import { Table, TableBody, TableRow, TableCell } from '#core/app/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '#core/app/components/ui/dialog'
import { logModuleLabel } from './logPresentation'
import { bytesLabel, localRange, ruleLabel, type PolicyView, type Review } from './logPolicy'

const props = defineProps<{
  review: Review | null
  data: Pick<PolicyView, 'retentionDays' | 'maxBytes'> | null
  pending: boolean
  reviewParentReasons: string[]
}>()
const emit = defineEmits<{ dismiss: []; cancel: []; confirm: [] }>()

// Keep the frozen contents while the shared Dialog plays its closing animation.
// Clearing the open state must not change a configuration review into a clear warning.
const dialogReview = computed<Review | null>((previous) => props.review ?? previous ?? null)
const filterLabels: Record<string, string> = {
  from: '开始时间',
  to: '结束时间',
  level: '级别',
  source: '来源',
  module: '模块',
  outcome: '结果',
  operation: '操作',
  requestId: '请求标识',
  traceId: '链路标识',
  taskId: '任务标识',
  fileId: '文件编号',
  batchId: '批次标识',
  resourceId: '资源标识'
}

function clearFilterValue(key: string, value: unknown) {
  if (key === 'from' || key === 'to') return localRange(String(value))
  if (key === 'module') return logModuleLabel(String(value))
  return value
}

function onOpenChange(open: boolean) {
  if (!open && !props.pending) emit('dismiss')
}
</script>

<template>
  <Dialog :open="!!review" @update:open="onOpenChange">
    <DialogContent
      class="max-h-[90dvh] overflow-y-auto"
      @interact-outside="pending && $event.preventDefault()"
      @escape-key-down="pending && $event.preventDefault()"
    >
      <DialogHeader
        ><DialogTitle>{{
          dialogReview?.kind === 'config' ? '核对日志配置修改' : '确认清理运行日志'
        }}</DialogTitle
        ><DialogDescription>{{
          dialogReview?.kind === 'config'
            ? '采集配置对后续批次生效；保留策略调整可能清理已有日志。'
            : '此操作可能永久删除运行日志。业务审计、回执、源文件和任务产物不在清理范围。'
        }}</DialogDescription></DialogHeader
      >
      <template v-if="dialogReview?.kind === 'config'">
        <div
          v-if="dialogReview.sources.length || dialogReview.integrations.length"
          class="flex flex-col gap-2"
        >
          <p class="text-sm">仅列出有差异的采集规则：</p>
          <Table class="data-table">
            <TableBody>
              <TableRow
                v-for="change in [...dialogReview.sources, ...dialogReview.integrations]"
                :key="`${change.dimension}-${change.key}`"
              >
                <TableCell class="text-muted-foreground whitespace-normal">
                  {{ change.dimension }} · {{ change.label }}
                </TableCell>
                <TableCell class="whitespace-normal">{{ ruleLabel(change.from) }}</TableCell>
                <TableCell class="whitespace-normal">{{ ruleLabel(change.to) }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p class="text-muted-foreground text-table leading-5">
            其余项保持不变，不会被重置。
          </p>
        </div>
        <div v-if="dialogReview.fields.length" class="flex flex-col gap-2">
          <p class="text-sm">仅列出有差异的字段（与已保存配置比较）：</p>
          <Table class="data-table" data-testid="log-field-review-table">
            <TableBody>
              <TableRow
                v-for="change in dialogReview.fields"
                :key="`${change.profile}-${change.level}-${change.field}`"
              >
                <TableCell class="text-muted-foreground whitespace-normal">
                  {{ change.profileLabel }} · {{ change.levelLabel }} · {{ change.fieldLabel }}
                </TableCell>
                <TableCell class="whitespace-normal">{{
                  change.from ? '保留' : '不记录'
                }}</TableCell>
                <TableCell class="whitespace-normal">{{
                  change.to ? '保留' : '不记录'
                }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p class="text-muted-foreground text-table leading-5">
            只影响之后写入；恢复为保留也会作为改动提交。
          </p>
          <p
            v-if="reviewParentReasons.length"
            class="text-muted-foreground text-table leading-5"
            data-testid="log-field-review-parent"
          >
            当前不采集：{{ reviewParentReasons.join('、') }}。保存不会重新开启采集。
          </p>
        </div>
        <div
          v-if="dialogReview.retentionChanged || dialogReview.capacityChanged"
          class="flex flex-col gap-1 text-sm"
        >
          <p v-if="dialogReview.retentionChanged">
            保留天数：{{ data?.retentionDays }} 天 → {{ dialogReview.retentionDays }} 天
          </p>
          <p v-if="dialogReview.capacityChanged">
            容量：{{ data ? bytesLabel(data.maxBytes) : '' }} →
            {{ bytesLabel(dialogReview.maxBytes) }}
          </p>
        </div>
      </template>
      <template v-else-if="dialogReview?.kind === 'clear'">
        <p class="text-sm">清理以下已固定范围，每次最多 1000 条：</p>
        <Table>
          <TableBody>
            <TableRow v-for="(value, key) in dialogReview.filter" :key="key">
              <TableCell class="text-muted-foreground">{{ filterLabels[key] ?? key }}</TableCell>
              <TableCell class="break-all">{{ clearFilterValue(key, value) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </template>
      <DialogFooter
        ><Button variant="outline" :disabled="pending" @click="emit('cancel')">取消</Button
        ><Button
          :variant="dialogReview?.kind === 'clear' ? 'destructive' : 'default'"
          data-testid="log-policy-confirm"
          :disabled="pending"
          @click="emit('confirm')"
          >{{
            pending
              ? '正在提交…'
              : dialogReview?.kind === 'config'
                ? '确认保存配置'
                : '确认清理范围'
          }}</Button
        ></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>
