<script setup lang="ts">
import { ArrowRight } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
</script>

<template>
  <Button as-child variant="outline" size="sm">
    <NuxtLink to="/lead-lists">浏览线索名单 <ArrowRight aria-hidden="true" /></NuxtLink>
  </Button>
</template>
