<script setup lang="ts">
/**
 * `/roster` —— **旧的企业总表入口**(RL-04),RL-17 已并入 `/`(名录台账)。
 *
 * 这里只做 302:把 **原样的查询串**带到 `/`,深链不断 —— 以前发出去的
 * `/roster?q=…&title=…` 必须还能落到同一批筛选上,而不是被丢回一个没筛过的第一页。
 *
 * 路由级 `redirect` 而不是「在 setup 里 navigateTo」:后者会先渲染一帧空页面再跳,
 * 用户看得见闪一下;`definePageMeta` 的 `redirect` 由 vue-router 在**解析路由时**处理,
 * 页面组件根本不会被挂载。
 *
 * 语义映射(两个入口当时就是同一份数据):
 *  - `按企业`(RL-04 的一企一行)= 新页面的默认视图,查询串原样带过去;
 *  - 原来第二个页签「差异与原因」的深链是 `?tab=/`,没有 URL 承载 —— 不存在要映射的旧链接。
 */
definePageMeta({
  redirect: (to) => ({ path: '/', query: to.query }),
})
</script>

<template>
  <!-- 路由在解析阶段就跳走了,这里不会被渲染;留着空节点只为让 SFC 有模板。 -->
  <div />
</template>
