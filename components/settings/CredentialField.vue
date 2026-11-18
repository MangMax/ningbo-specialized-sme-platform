<script setup lang="ts">
import { Copy, Eye, EyeOff } from '@lucide/vue'
import { Motion, useReducedMotion } from 'motion-v'
import { Button } from '#core/app/components/ui/button'
import { Input } from '#core/app/components/ui/input'
import { Label } from '#core/app/components/ui/label'
import LoadingIndicator from './LoadingIndicator.vue'
import type { CredentialOperation, CredentialStatus } from '@/composables/useCredentialSettings'
defineProps<{ id: string; label: string; status: CredentialStatus; raw: string; replacement: string; busy: boolean; operation?: CredentialOperation; description: string; sensitive: boolean }>()
defineEmits<{ 'update:replacement': [value: string | number]; save: []; clear: []; reveal: [copy: boolean] }>()
const reducedMotion = useReducedMotion()
</script>

<template>
  <section class="bg-card text-card-foreground space-y-5 rounded-lg border p-5 shadow-xs" :aria-labelledby="`${id}-heading`">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 :id="`${id}-heading`" class="font-semibold">{{ label }}</h2>
      <span class="text-sm font-medium">{{ status.configured ? '已配置' : '未配置' }}</span>
    </div>
    <div class="space-y-2">
      <div class="bg-muted flex min-w-0 items-start gap-2 rounded-md p-3">
        <code class="min-w-0 flex-1 self-center break-all text-sm" :aria-label="`当前 ${label}`">{{ raw || status.masked || '尚未配置' }}</code>
        <Motion as-child :while-press="reducedMotion ? undefined : { scale: 0.9 }" :transition="{ duration: 0.12, ease: 'easeOut' }">
          <Button type="button" variant="ghost" size="icon" class="relative shrink-0 active:scale-100 active:bg-primary/15 active:text-primary" :aria-label="`${raw ? '隐藏' : '显示'} ${label}`" :aria-busy="operation === 'reveal'" :disabled="!status.configured || busy" @click="$emit('reveal', false)">
            <span class="inline-flex size-4 items-center justify-center"><EyeOff v-if="raw" :class="{ invisible: operation === 'reveal' }" /><Eye v-else :class="{ invisible: operation === 'reveal' }" /></span>
            <span class="pointer-events-none absolute inset-0 flex items-center justify-center"><LoadingIndicator :active="operation === 'reveal'" /></span>
          </Button>
        </Motion>
        <Motion as-child :while-press="reducedMotion ? undefined : { scale: 0.9 }" :transition="{ duration: 0.12, ease: 'easeOut' }">
          <Button type="button" variant="ghost" size="icon" class="relative shrink-0 active:scale-100 active:bg-primary/15 active:text-primary" :aria-label="`复制 ${label}`" :aria-busy="operation === 'copy'" :disabled="!status.configured || busy" @click="$emit('reveal', true)">
            <Copy :class="{ invisible: operation === 'copy' }" />
            <span class="pointer-events-none absolute inset-0 flex items-center justify-center"><LoadingIndicator :active="operation === 'copy'" /></span>
          </Button>
        </Motion>
      </div>
    </div>
    <form class="space-y-3" @submit.prevent="$emit('save')">
      <Label :for="`${id}-replacement`">替换 {{ label }}</Label>
      <Input :id="`${id}-replacement`" :model-value="replacement" :type="sensitive ? 'password' : 'text'" autocomplete="off" spellcheck="false" autocapitalize="off" :placeholder="`粘贴完整${label}`" :readonly="busy" @update:model-value="$emit('update:replacement', $event)" />
      <p class="text-muted-foreground wrap-anywhere text-sm">{{ description }}清除仅移除页面保存值，部署配置仍可生效。</p>
      <div class="flex flex-wrap gap-3">
        <Button type="submit" :data-testid="`save-${id}`" :aria-busy="operation === 'save'" :disabled="busy || !replacement.trim()"><LoadingIndicator :active="operation === 'save'" />保存 {{ label }}</Button>
        <Button type="button" variant="outline" :data-testid="`clear-${id}`" :aria-busy="operation === 'clear'" :disabled="busy || !status.hasSaved" @click="$emit('clear')"><LoadingIndicator :active="operation === 'clear'" />清除页面保存值</Button>
      </div>
    </form>
  </section>
</template>
