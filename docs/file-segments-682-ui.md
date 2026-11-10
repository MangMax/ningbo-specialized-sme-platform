# #682 文件内容分段 UI

列表只投影 `registeredSummary.declarations`；展开编辑直接消费 `declarations`，按 `displaySequence` 与 `declarationId` 排序。正式出处聚合只在默认收起的「入库情况统计」展示。没有声明即未登记，不复制统计作为草稿。

每个展开区只允许一个编辑、删除确认或提交操作。只有新增追加空草稿；取消恢复快照。删除整集合载荷中省略目标 ID，企业记录不删除。修改以稳定 ID 替换目标 part，其他 ID 与 part 保留；未改范围通过协议的省略语义保留。序号不发送。

原载荷未确认可原键重试；输入变化清除旧重试请求。commit 确认后读取失败只提供重读，不能重提。CAS 错误保留原稿。折叠、筛选、分页和路由离开通过编辑器 save/discard/stay 协调；浏览器关闭通过 beforeunload。同步使用原有文件级全部已保存声明的预检、依据与确认流程，当前操作未结束不可启动。

## 验证与父任务接入

聚焦命令：`pnpm test --maxWorkers=1 tests/file-segments-668-ui.test.ts tests/file-segments-668-http.test.ts tests/declaration-681-migration.test.ts tests/parse-maintenance-105-http.test.ts`。新 UI 测试覆盖零登记489事件、空新稿、稳定 ID/整集合保留、顺序、取消/删除、幂等重试、确认后读失败、CAS、多范围和离开选择。

不包含后端/数据库迁移。父任务部署前先按 [#681 契约](file-segments-681-contract.md) 在受控副本执行0046迁移，再在同一集成 checkout 串行 typecheck/build；不可并发争用 Nuxt buildlock。本票使用外部 Vite 合成组件夹具，未构建生产包。真实副本公共 HTTP 与完整页面浏览器验收仍由父任务执行；不以组件模拟替代。

外部原始证据：`/Users/mang/Workfile/file-segments-682-evidence/`（mapping.md、browser.md、各轮测试/typecheck日志及合成夹具）。设计按批准 V2，未重新派独立审核。
