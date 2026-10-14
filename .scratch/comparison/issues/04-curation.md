# 04 — 人工标注 `curated`(范围可裁)

**What to build:** 让经办人能把一条差异标注为「已核实、无需处理」,以后重算时**不再冒出来**(或在页面默认过滤掉,可切换显示)。这是本模块**唯一允许写盘**的地方。

**Blocked by:** 02 — Nitro 接口 `GET /api/comparison`

**Status:** ✅ done

## 存储

- 落 **JSON 文件** `data/reconciliation-curated.json`(路径可经 runtimeConfig 覆盖,照 `NUXT_DB_PATH` 的先例)。**不写库、不改 schema、不用 `reconciliation_result` 表**(理由见 SPEC:物化会引入「何时重算」的一致性问题)。
- 键:`{ enterpriseKey, titleCode, direction }` → `{ note?, by?, at }`。`enterpriseKey` 用统代(`uscc_norm`)为主键;无统代者用 `name_norm` 加前缀区分。
- `lib/curation.ts` 在接口层读取标注并装饰 `curated` / `note`;`getComparison` 保持无文件 IO 的纯函数,口径及票 01 测试不变。

## 接口

- `PATCH /api/comparison/curated`
  - body:`{ uscc?, nameNorm?, titleCode, direction, curated: boolean, note?: string }`
  - 幂等:重复标注/取消不报错。
  - 非法参数(未知 title/direction、两者都没给标识)→ 400。
- 只允许**这一个写口子**;不得借机提供记录增删改。

## 页面

- 差异表每行加一个 shadcn **Switch / Checkbox** 或行操作按钮,触发标注。
- 顶部一个**筛选开关**「显示已核实」,默认**隐藏**;隐藏时计数徽标显示「N 条(另 M 条已核实)」。
- 备注可编辑(shadcn `Popover`/`Dialog` + `Input`/`Textarea`),**不使用原生输入框**。

## 测试

- [x] `tests/comparison.test.ts` 或新增:`curated` 命中后该行 `curated=true`;取消后恢复。
- [x] 未标注的差异不受影响(文件不存在时全部 `curated=false`,**不报错**)。
- [x] PATCH 幂等;非法参数 400。

## 验收

- [x] 标注一条 → 刷新后仍被记住(JSON 落盘);默认视图不再显示它。
- [x] 打开「显示已核实」→ 该条回来并带备注。
- [x] `data/*.json` 未被 `.gitignore` 误伤或已按现有约定处理(参照 `data/` 的忽略规则,**本文件属本地状态,应忽略**)。
- [x] `pnpm typecheck`、`pnpm test` 通过。

**分支**:`feat/comparison-curation`。**只提交本票涉及的文件。**


## 实施与验证记录(2026-10-14)

- 默认文件 `data/reconciliation-curated.json`;runtimeConfig `curatedPath`,环境变量 `NUXT_CURATED_PATH`。JSON 元组键 `[enterpriseKey,titleCode,direction]`;统代优先,无统代用 `name:<name_norm>`。同步读改写、原子替换;重复相同标注保留 `at`,取消删除该键。
- GET 默认隐藏已核实行;`counts` / `curatedCounts` 均按全部差异计算,先于称号/方向筛选、分页。页面待处理数 = `counts - curatedCounts`,徽标显示「N 条(另 M 条已核实)」。
- 行组件 `ComparisonCuration.vue`:官方 Switch + Dialog/Input,保存备注同时核实;保存后失效全部 comparison 查询,最后一页清空时回退页码。页面保留 Colada placeholderData 和既有设计 token。
- `pnpm typecheck`:退出 0。`pnpm test`:10 文件、126 测试通过;票 01 的 `lib/comparison.ts` 与 `tests/comparison.test.ts` 均未修改。
- 新增 `tests/curation.test.ts` 行为证据:
  - `returns all rows uncurated when the file is absent without creating it`:无文件全 false、无 note、不创建文件。
  - `persists note, decorates on fresh reads and restores the row on cancellation`:JSON 落盘、默认隐藏、显示时带 note、取消恢复。
  - `uses stored name_norm for missing USCC and isolates title and direction keys`:使用库内 name_norm、统代优先、称号与方向隔离。
  - `is idempotent for repeated PATCH and preserves omitted notes`:重复标注/取消、保留未传备注、清空备注。
  - `keeps global counts and curatedCounts independent of visibility, filters and pagination`:全局计数和跨页已核实数。
  - `rejects invalid PATCH body with 400: %j`(9 个参数案例):非法标识、称号、方向、布尔值、备注等返回 400 且不写文件。

### 真实库 dev / curl / UI

已存在的 3000 dev server 保留;本票另起 3471:

```sh
NUXT_IGNORE_LOCK=1 NUXT_CURATED_PATH="$PWD/.scratch/comparison/evidence/curation-runtime.json" pnpm dev --port 3471
curl -fsS -X PATCH http://localhost:3471/api/comparison/curated -H 'Content-Type: application/json' --data-binary @.scratch/comparison/evidence/patch.json
curl -fsS 'http://localhost:3471/api/comparison?title=specialized_sme&direction=missing_in_miit&showCurated=false'
curl -fsS 'http://localhost:3471/api/comparison?title=specialized_sme&direction=missing_in_miit&showCurated=true&pageSize=1'
```

- 真实库企业 `东方日升(宁波)新能源有限公司` / `91330226MA2H6Y300P`,市专、应纳未纳。PATCH body 的 `curated=true`,备注 `已核实：本条无需处理（票04验收）`;重复 PATCH 均 HTTP 200。
- 标注前总数 337;标注后默认/false 总数 336,true 总数 337,该行 `curated=true` 且带上述 note。页面刷新仍隐藏,徽标 `336 条(另 1 条已核实)`;打开「显示已核实」该行回来。
- 全部 `counts` 始终为市专 337/13、创新型 543/28、小巨人 0/0;`curatedCounts.specialized_sme.missing_in_miit=1`,其他为 0。`pageSize=1` 仍返回该全局计数。
- 非法 PATCH(title unknown、无标识)实测 HTTP 400。页面 Dialog 编辑/保存与行 Switch 取消均成功;curl 再次取消仍 200,默认 total 恢复 337、该行 false、note 消失、curatedCounts 恢复 0。
- curl 原始 JSON 位于 `.scratch/comparison/evidence/`(忽略、不提交);运行使用隔离的标注路径,未对真实本地标注文件写入验收备注。
- 截图(真实库,已目视检查):
  - 标注前:`/Users/mang/Workfile/宁波/专精特新/20261013/app/.scratch/comparison/shots/04-curation-before.png`
  - 标注后(显示已核实打开,可见已核实开关与备注):`/Users/mang/Workfile/宁波/专精特新/20261013/app/.scratch/comparison/shots/04-curation-after.png`
- `data/` 已忽略;截图/evidence 不提交。无 schema/pipeline/口径修改。本票完成后停止本票启动的 3471 server。
