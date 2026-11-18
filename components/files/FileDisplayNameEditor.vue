<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Alert, AlertDescription } from '#core/app/components/ui/alert'
import { Button } from '#core/app/components/ui/button'
import { Input } from '#core/app/components/ui/input'
import { Label } from '#core/app/components/ui/label'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import type { FileRow } from '~~/server/utils/file-store'

const open = defineModel<boolean>('open', { default: false })
const props = withDefaults(
  defineProps<{
    file: FileRow | null
    pending?: boolean
    failure?: string
  }>(),
  { pending: false, failure: '' },
)
const emit = defineEmits<{ save: [displayName: string] }>()
const displayName = ref('')

watch(
  open,
  (value) => {
    if (value && props.file) displayName.value = props.file.displayName
  },
  { immediate: true },
)

const normalizedName = computed(() => displayName.value.trim())
const invalid = computed(
  () =>
    !normalizedName.value ||
    Array.from(normalizedName.value).length > 255 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(normalizedName.value),
)
const unchanged = computed(
  () => normalizedName.value === props.file?.displayName,
)

function save() {
  if (invalid.value || unchanged.value || props.pending) return
  emit('save', normalizedName.value)
}
</script>

<template>
  <section v-if="open" class="space-y-3" aria-label="文件名称">
    <div class="flex flex-col gap-4">
      <DisclosurePanel compact title="原始文件与路径"
        ><div class="flex flex-col gap-1">
          <span class="text-muted-foreground text-xs">磁盘文件名(只读)</span>
          <code class="font-mono text-xs break-all">{{ file?.filename }}</code>
          <span class="text-muted-foreground mt-1 text-xs">库内路径(只读)</span>
          <code class="font-mono text-xs break-all">{{ file?.relPath }}</code>
        </div></DisclosurePanel
      >

      <div class="flex flex-col gap-1.5">
        <Label for="file-display-name" class="text-xs">用户可见名称</Label>
        <Input
          id="file-display-name"
          v-model="displayName"
          data-testid="file-display-name-input"
          :disabled="pending"
          :aria-invalid="invalid || undefined"
          @keydown.enter.prevent="save"
        />
        <p class="text-muted-foreground text-xs">
          最多 255 个字符。审计记录会保留修改前后的名称。
        </p>
      </div>

      <Alert v-if="failure" variant="destructive">
        <AlertDescription>{{ failure }}</AlertDescription>
      </Alert>
    </div>

    <Button
      data-testid="save-file-display-name"
      :disabled="invalid || unchanged || pending"
      @click="save"
    >
      {{ pending ? '保存中…' : '保存显示名称' }}
    </Button>
  </section>
</template>
