# 04 — 全量审计:被并主体清单 + 重建发布

**What to build:** 用加固后的流程重跑导入,并**枚举出所有受影响的主体**,供人工判定。

**Blocked by:** 01, 02, 03

**Status:** done — 加固归并审计、空账表重建和当前完整比对重算已落地；原始对照报告与本轮只读快照回归证据见下。

## 要做的

### (1) 找出「被错误并掉」的主体

- 现状:历史上按统代归并了 **123** 家。其中有真改名(`有限公司`↔`股份有限公司`),也有像贝兹德这样**被错统代误导**的。
- 用加固后的逻辑**重算**,产出一张对照表,逐条列:
  - 被并方名称 / 并入方名称 / 触发归并的统代 / **依据来源**(哪个文件哪一行 / 或「仅整理版」);
  - 判定:**保留归并** / **撤销归并(拆回两个主体)** / **待人工**。
- 重点核查:凡依据里出现**整理版**的,一律重新判定。

### (2) 从原始来源重建

- 清库 → `vp run db:import --root ..`(注意:现已知道**幂等不刷新 `source_file`**,必须**清库重建**,见 `files/README.md`)。
- 重建后输出完整导入报告:各来源条数、回填数(含被佐证/未佐证)、归并清单、质量标记分布。

### (3) 回归比对

- 重算比对模块(`/api/comparison`),确认:
  - `东方日升(宁波)新能源有限公司` 不再有任何专精特新记录;
  - 它在专精特新侧不再出现「应纳未纳」;
  - `贝兹德智能科技有限公司` 拿回创新型 2023-2(序号745)与专精特新 2024-1(序号205),不再出现在「应出未出」;
  - 总差异数的变化给出说明。

## 交付

- [x] `reports/` 下的**归并审计对照表**(CSV 或 md 表)。—— pipeline `reports/identity-resolution-20261014.md`：83 对原始同码归并依据、当前旧流程 125 对逐项对照、296 待确认主体、293 整理版独有候选（均未写入）。
- [x] 重建后的导入报告。—— `acceptance/20261015/final-import-run3.json` + `final-ledger-run3-audit.json`（7358/19982/21442/21443 为**单条纠偏前的历史快照**；现行正式库 7357/19982/21442/21443，见 `root-formal-one-row-review/formal-application-proof.json`），五表两 CLI 相同；另一独立空库缓存重放见 `fresh-flow/evidence/root-cached-replay-acceptance.json`。
- [x] 比对前后差异数对照。—— `evidence/comparison-regression/snapshot-counts.json`：旧 checkout 792 / 重建前 stage 696 / **当时**正式 555（该 555 为**历史快照**，单条纠偏后当前为 **553**：`root-formal-one-row-review/cache-publication-proof.json`），文件明写「快照输入不同，不是同输入因果实验、也不是最早错误基线」。

## 验收

- [x] SPEC「验收」第 1、2、4 条逐条满足。—— 第 1 条：`named-regressions.json` 直接列当前出处（东方日升无专精特新；贝兹德 2023-2 序号 745、2024-1 序号 205）；第 2 条：不能独立佐证者保持无统代+标记（现行 99 家无统代：78 `uscc_missing` + 21 `uscc_missing+uscc_conflict`）；第 4 条：两假差异消失且总差异数变化有说明（`snapshot-counts.json` 792→696→555，其中 555 为历史快照，单条纠偏后 553）。第 3 条归票 05。
- [x] **凡统代无独立佐证的企业,一律无统代 + 标记**,不猜测。—— 只读核现行正式库：`uscc_norm is null` **99 家**（78 `uscc_missing` + 21 `uscc_missing+uscc_conflict`）全部带 `quality_flags`，整理版统代写入 0。（单条纠偏前的 100 家为历史快照。）
- [x] `vp run db:import` 可重复执行,结果稳定(幂等)。—— 两独立 CLI 进程四张业务账表逐项相同（`final-ledger-run{2,3}-audit.json` `lastTwoCliLedgerIdentical=true`），另有 `fresh-flow` 11371 两进程 C/D 逐字节一致。

**分支**:从干净 `main` 起,如 `fix/rebuild`。**完成后交给主代理做票 05 的视觉抽查。**

## 2026-10-15 当前交付

历史125对逐项处理、83对原始同码来源及未佐证候选清单在pipeline `reports/identity-resolution-20261014.md`。当前正式从空账表重建21份有效来源：7358主体、19982记录、21442事件、21443出处（**7358 为单条数据纠偏前的历史快照；单条纠偏后现行为 7357 主体**，其余四数不变，见 `acceptance/20261015/root-formal-one-row-review/formal-application-proof.json`）；无猜测整理版写入，不能确认者保留空值及标记。完整导入报告、五表幂等证据见项目 `acceptance/20261015/final-{import-run3.json,ledger-run3-audit.json}`。另一个独立空库读取相同缓存事实重放，两独立CLI四张业务账表逐项等于正式库，见 `fresh-flow/evidence/root-cached-replay-acceptance.json`。

回归原始出处和当前555差异全量读取见 `evidence/comparison-regression/{named-regressions.json,README.md,snapshot-counts.json}`：东方日升无专精特新、贝兹德2023/2序号745及2024/1序号205正确，两者均无假差异。快照旧checkout792、重建前stage696、当前555；快照输入不同，明确不能当同输入因果实验或最早错误基线。主代理本人原图抽查见pipeline `reports/visual-verification.md`。
