# 04 — 人工标注 `curated`(范围可裁)

**What to build:** 让经办人能把一条差异标注为「已核实、无需处理」,以后重算时**不再冒出来**(或在页面默认过滤掉,可切换显示)。这是本模块**唯一允许写盘**的地方。

**Blocked by:** 02 — Nitro 接口 `GET /api/comparison`

**Status:** ready(若用户倾向「一期纯只读」,本票可整体裁掉,票 01–03 不依赖它)

## 存储

- 落 **JSON 文件** `data/reconciliation-curated.json`(路径可经 runtimeConfig 覆盖,照 `NUXT_DB_PATH` 的先例)。**不写库、不改 schema、不用 `reconciliation_result` 表**(理由见 SPEC:物化会引入「何时重算」的一致性问题)。
- 键:`{ enterpriseKey, titleCode, direction }` → `{ note?, by?, at }`。`enterpriseKey` 用统代(`uscc_norm`)为主键;无统代者用 `name_norm` 加前缀区分。
- `getComparison`(票 01)读取该文件,为命中行置 `curated=true`,并可带 `note`。**票 01 已为此预留 `curated` 字段(本期恒 false)**;本票把它接上。

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

- [ ] `tests/comparison.test.ts` 或新增:`curated` 命中后该行 `curated=true`;取消后恢复。
- [ ] 未标注的差异不受影响(文件不存在时全部 `curated=false`,**不报错**)。
- [ ] PATCH 幂等;非法参数 400。

## 验收

- [ ] 标注一条 → 刷新后仍被记住(JSON 落盘);默认视图不再显示它。
- [ ] 打开「显示已核实」→ 该条回来并带备注。
- [ ] `data/*.json` 未被 `.gitignore` 误伤或已按现有约定处理(参照 `data/` 的忽略规则,**本文件属本地状态,应忽略**)。
- [ ] `pnpm typecheck`、`pnpm test` 通过。

**分支**:`feat/tus-uploads`。**只提交本票涉及的文件。**
