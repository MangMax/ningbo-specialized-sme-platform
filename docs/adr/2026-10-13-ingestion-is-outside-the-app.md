# 数据入库是项目外的前期工作,app 只读台账

解析公布文件、清洗、写库(含 `mammoth`/`tinyglobby`/`exceljs` 解析、`.doc` 转档、归一化、幂等导入)属于**前期数据处理**,放在 `20261013/pipeline/`,**不在 app 仓库内**。app 只做一件事:读 `data/roster.db` 并展示。

**为什么:** app 的定位从 [ADR-只读看板先行](./2026-10-13-readonly-board-first.md) 起就锁死为「只读查阅」——没有数据管理、没有比对、更没有导入。把解析与清洗混进 app,会让一个只读前端背上原生依赖(mammoth、soffice 转档)、一个导入 CLI、一套解析测试,以及随之而来的“这到底算 app 功能吗”的持续歧义。入库是一次性的前期工作:数据目录换了就重跑一遍,产出新库即可。

**后果:**
- **单向依赖**:`pipeline → app`。pipeline 复用 app 的库结构(`app/db/schema.ts`)、DB 打开与迁移(`app/db/client.ts`)、以及共享契约 `app/lib/domain.ts`(名称归一化、区县词表)。**app 不依赖 pipeline**,也不包含任何解析/导入代码。
- app 的依赖里不应出现 `mammoth`、`node-html-parser`、`tinyglobby`、`docx`;这些只属于 pipeline。
- app 的测试不得经由导入管道造数——直接以 drizzle 插桩(app 自己的读模型)。
- 库是构建产物(不入版本控制)。缺库时 app 显示为空,并提示先跑 pipeline。

**已考虑但未选:** 把 pipeline 放进 app 仓库内的 `scripts/`——依赖与职责会渗回只读前端,正是本次要纠正的。
