<script setup lang="ts">
import { Copy, Eye, EyeOff } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CredentialStatus } from '@/composables/useCredentialSettings'
defineProps<{ id: string; label: string; status: CredentialStatus; raw: string; replacement: string; busy: boolean; canRead: boolean; description: string }>()
defineEmits<{ 'update:replacement': [value: string | number]; save: []; clear: []; reveal: [copy: boolean] }>()
</script>

<template>
  <section class="space-y-5 rounded-lg border p-5" :aria-labelledby="`${id}-heading`">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 :id="`${id}-heading`" class="font-semibold">{{ label === 'OCR token' ? '在线 OCR token' : label }}</h2>
      <span class="text-sm font-medium">{{ status.configured ? '已配置 · 未验证' : '未配置' }}</span>
    </div>
    <div class="space-y-2">
      <p class="text-muted-foreground break-all text-sm">有效来源：{{ status.source === 'saved' ? '页面保存' : status.source === 'none' ? '无' : status.source }}</p>
      <div class="bg-muted flex min-w-0 items-start gap-2 rounded-md p-3">
        <code class="min-w-0 flex-1 self-center break-all text-sm" :aria-label="`当前 ${label}`">{{ raw || status.masked || '尚未配置' }}</code>
        <Button type="button" variant="ghost" size="icon" class="shrink-0" :aria-label="`${raw ? '隐藏' : '显示'}${label === 'OCR token' ? ' ' : ''}${label}`" :disabled="!canRead || busy" @click="$emit('reveal', false)"><EyeOff v-if="raw" /><Eye v-else /></Button>
        <Button type="button" variant="ghost" size="icon" class="shrink-0" :aria-label="`复制${label === 'OCR token' ? ' ' : ''}${label}`" :disabled="!canRead || busy" @click="$emit('reveal', true)"><Copy /></Button>
      </div>
    </div>
    <form class="space-y-3" @submit.prevent="$emit('save')">
      <Label :for="`${id}-replacement`">替换{{ label === 'OCR token' ? ' ' : '' }}{{ label }}</Label>
      <Input :id="`${id}-replacement`" :model-value="replacement" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" :placeholder="`粘贴完整${label}`" :readonly="busy" @update:model-value="$emit('update:replacement', $event)" />
      <p class="text-muted-foreground text-sm">{{ description }}清除仅移除页面保存值，部署配置仍可生效。</p>
      <div class="flex flex-wrap gap-3">
        <Button type="submit" :data-testid="`save-${id}`" :disabled="busy || !replacement.trim()">{{ busy ? '正在处理…' : `保存${label === 'OCR token' ? ' ' : ''}${label}` }}</Button>
        <Button type="button" variant="outline" :data-testid="`clear-${id}`" :disabled="busy || !status.hasSaved" @click="$emit('clear')">清除页面保存值</Button>
      </div>
    </form>
  </section>
</template>
