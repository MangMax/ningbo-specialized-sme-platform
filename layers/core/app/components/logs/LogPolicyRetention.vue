<script setup lang="ts">
import { Button } from '#core/app/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '#core/app/components/ui/field'
import { Input } from '#core/app/components/ui/input'
import { iconForSection } from './logIcons'
import { bytesLabel, local, type PolicyView } from './logPolicy'

defineProps<{ data: PolicyView; busy: boolean; validPolicy: boolean; hasChanges: boolean }>()
const days = defineModel<string | number>('days', { required: true })
const bytes = defineModel<string | number>('bytes', { required: true })
const emit = defineEmits<{ review: [] }>()
</script>

<template>
  <section aria-labelledby="log-retention-heading" class="flex min-w-0 flex-col gap-3">
    <div class="flex flex-col gap-1">
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-muted-foreground inline-flex size-4 shrink-0 items-center justify-center">
          <Icon :name="iconForSection('retention')" class="size-4" aria-hidden="true" />
        </span>
        <h2 id="log-retention-heading" class="text-sm font-medium">保留策略</h2>
      </div>
      <p class="text-muted-foreground text-table leading-5">
        取更严格者；缩短保留期或降低容量可能清理已有日志。
      </p>
    </div>
    <dl class="grid min-w-0 gap-x-6 gap-y-1 text-table leading-5 sm:grid-cols-2">
      <div class="flex min-w-0 gap-2">
        <dt class="text-muted-foreground shrink-0">当前生效</dt>
        <dd class="min-w-0 break-words">
          {{ data.retentionDays }} 天 / {{ bytesLabel(data.maxBytes) }}
        </dd>
      </div>
      <div class="flex min-w-0 gap-2">
        <dt class="text-muted-foreground shrink-0">存储用量</dt>
        <dd class="min-w-0 break-words">{{ bytesLabel(data.storageBytes) }}</dd>
      </div>
      <div class="flex min-w-0 gap-2">
        <dt class="text-muted-foreground shrink-0">累计清理</dt>
        <dd class="min-w-0 break-words">
          策略裁剪 {{ data.pruned }} 条 / 手动清理 {{ data.cleared }} 条
        </dd>
      </div>
      <div class="flex min-w-0 gap-2">
        <dt class="text-muted-foreground shrink-0">进程状态</dt>
        <dd class="min-w-0 break-words">
          <span :class="data.status?.unavailable ? 'text-destructive' : ''">{{
            data.status?.unavailable ? '不可用' : '可用'
          }}</span
          >；已丢弃 {{ data.status?.dropped ?? 0 }} 条；排队
          {{ data.status?.queuedEntries ?? 0 }} 条；写入中
          {{ data.status?.inFlightEntries ?? 0 }} 条<template
            v-if="(data.status?.writeUnknown ?? 0) > 0"
            >；写入结果未知 {{ data.status?.writeUnknown }} 条</template
          ><template v-if="(data.status?.coalesced ?? 0) > 0"
            >；合并重复查询 {{ data.status?.coalesced }} 次</template
          >
        </dd>
      </div>
    </dl>
    <p class="text-muted-foreground text-table leading-5">
      用量含日志库与附属文件，不含文件系统与容器输出；进程计数自
      {{ data.status?.since ? local(data.status.since) : '本次进程启动' }} 起。
    </p>
    <form data-testid="log-policy-form" @submit.prevent="emit('review')">
      <FieldGroup class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field :data-disabled="busy">
          <FieldLabel for="log-retention-days">保留天数（1–365）</FieldLabel
          ><Input
            id="log-retention-days"
            v-model.number="days"
            type="number"
            min="1"
            max="365"
            required
            :disabled="busy"
          />
        </Field>
        <Field :data-disabled="busy">
          <FieldLabel for="log-max-bytes">容量字节（1 MiB–4 GiB）</FieldLabel
          ><Input
            id="log-max-bytes"
            v-model.number="bytes"
            type="number"
            min="1048576"
            max="4294967296"
            required
            :disabled="busy"
          />
        </Field>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 sm:col-span-2">
          <Button
            type="submit"
            variant="outline"
            data-testid="log-policy-review"
            :disabled="busy || !validPolicy || !hasChanges"
            >核对日志配置修改</Button
          >
          <!-- 后果写在按钮旁边，不做单独一段通栏说明；没有变化时说明为什么不能核对。 -->
          <p class="text-muted-foreground text-table leading-5">
            <template v-if="!hasChanges">当前配置与已生效配置相同，无需核对。</template>
            <template v-else
              >核对范围包括采集规则、记录内容与保留策略；只提交有差异的项，其余保持不变。保留策略调整可能触发轮转。</template
            >
          </p>
        </div>
      </FieldGroup>
    </form>
  </section>
</template>
