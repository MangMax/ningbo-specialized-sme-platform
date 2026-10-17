<script setup lang="ts">
import CredentialSettings from '@/components/settings/CredentialSettings.vue'
useHead({ title: '配置 · 专精特新企业称号台账' })
</script>
<template>
  <div class="space-y-5">
    <PageHeader title="配置" description="管理外部服务凭据" />
    <CredentialSettings />
  </div>
</template>
