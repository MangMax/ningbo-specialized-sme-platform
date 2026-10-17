<script setup lang="ts">
import { Copy, Eye, EyeOff, LoaderCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCredentialSettings } from '@/composables/useCredentialSettings'
const { adminToken, replacement, state, raw, busy, failed, message, canRead, load, save, clear, reveal } = useCredentialSettings()
</script>

<template>
  <div class="max-w-3xl space-y-6" :aria-busy="busy">
    <form class="space-y-3 rounded-lg border p-5" @submit.prevent="load">
      <Label for="settings-admin-token">API 管理 token</Label>
      <div class="flex flex-col gap-3 sm:flex-row">
        <Input id="settings-admin-token" v-model="adminToken" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="输入现有管理 token" class="min-w-0 flex-1" />
        <Button type="submit" variant="outline" :disabled="busy || !adminToken.trim()">
          <LoaderCircle v-if="busy" class="animate-spin motion-reduce:animate-none" />{{ busy ? '正在处理…' : '读取配置' }}
        </Button>
      </div>
      <p class="text-muted-foreground text-sm">管理授权仅在当前页面使用，离开后清理。</p>
    </form>

    <section v-if="state" class="space-y-5 rounded-lg border p-5" aria-labelledby="ocr-settings-heading">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ocr-settings-heading" class="font-semibold">在线 OCR token</h2>
        <span class="text-sm font-medium">{{ state.ocrToken.configured ? '已配置 · 未验证' : '未配置' }}</span>
      </div>
      <div class="space-y-2">
        <p class="text-muted-foreground break-all text-sm">有效来源：{{ state.ocrToken.source === 'saved' ? '页面保存' : state.ocrToken.source === 'none' ? '无' : state.ocrToken.source }}</p>
        <div class="bg-muted flex min-w-0 items-start gap-2 rounded-md p-3">
          <code class="min-w-0 flex-1 self-center break-all text-sm" aria-label="当前 OCR token">{{ raw || state.ocrToken.masked || '尚未配置' }}</code>
          <Button type="button" variant="ghost" size="icon" class="shrink-0" :aria-label="raw ? '隐藏 OCR token' : '显示 OCR token'" :disabled="!canRead || busy" @click="reveal()">
            <EyeOff v-if="raw" /><Eye v-else />
          </Button>
          <Button type="button" variant="ghost" size="icon" class="shrink-0" aria-label="复制 OCR token" :disabled="!canRead || busy" @click="reveal(true)"><Copy /></Button>
        </div>
      </div>
      <form class="space-y-3" @submit.prevent="save">
        <Label for="ocr-token-replacement">替换 OCR token</Label>
        <Input id="ocr-token-replacement" v-model="replacement" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="粘贴新 token" :readonly="busy" />
        <p class="text-muted-foreground text-sm">保存后供新任务使用，不会自动发起 OCR。清除仅移除页面保存值，部署配置仍可生效。</p>
        <div class="flex flex-wrap gap-3">
          <Button type="submit" data-testid="save-ocr-token" :disabled="busy || !replacement.trim()">{{ busy ? '正在处理…' : '保存 OCR token' }}</Button>
          <Button type="button" variant="outline" data-testid="clear-ocr-token" :disabled="busy || !state.ocrToken.hasSaved" @click="clear">清除页面保存值</Button>
        </div>
      </form>
    </section>
    <p v-if="message" :role="failed ? 'alert' : 'status'" :class="failed ? 'text-destructive' : 'text-muted-foreground'" class="text-sm">{{ message }}</p>
  </div>
</template>
