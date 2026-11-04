# #320 真实业务数据副本回归记录

日期：2026-11-04（Asia/Shanghai）

## 数据来源与隔离

- 运行中容器：`spztx-main-49133834-app`，镜像 `spztx-roster:main-49133834`，仅绑定 `127.0.0.1:3482`。
- 业务库：`/state/data/roster.db`（约 1.8 GiB，54 张应用表）。**未对活动库做任何写操作。**
- 一致副本：通过容器内 `better-sqlite3` 的在线 backup 写入 `/state/data/roster-320-copy-20261104.db`，再 `docker cp` 到宿主机 `/tmp/320-real/roster.db`。
- 副本迁移：应用 0033–0035，补齐 `platform_apply_projection`、`platform_business_projection`、`platform_recognized_projection`。

## 投影回填

对副本中所有 `identity_state=resolved` 且 `content_state=verified` 的观察执行 `ensurePlatformObservation`：

| 接口 | 可投影观察 | 回填成功 | 回填失败 | 投影行 | 按观察 version 可连接 |
| --- | ---: | ---: | ---: | ---: | ---: |
| apply_list | 16,443 | 16,443 | 0 | 15,402 | 16,443 |
| business_list | 31,485 | 31,485 | 0 | 29,717 | 31,485 |
| recognized_list | 10,065 | 10,065 | 0 | 10,065 | 10,065 |
| 合计 | 57,993 | 57,993 | 0 | 55,184 | 57,993 |

投影行少于观察数是因为同一内容版本被多条观察复用；逐观察按 `version_id` 连接均有投影。

## 对照方法

- 基线：`origin/main` @ `27cb3061`，独立 worktree。
- 候选实现：`t3/implement-spec-320`，独立 worktree。
- 同一副本的两个一致快照：
  - 基线读 `/tmp/320-real/roster.db`（无 typed 投影；只读）。
  - 新实现读 `/tmp/320-real/roster-new.db`（已回填 typed 投影；只读）。
- 样本：按 3 个称号 × award/review 各 10 个（窗口函数按事件 ID 排序）+ 20 个带 `record_correspondence` 的事件，去重后共 **80 个事件**。
- 每个事件同时执行：
  - `readEventAnnualProcess`（年度过程、final candidate、sourceRefs、sourceGeneration）。
  - `discoverEventArchives`（候选、冲突、覆盖、既有决定）。
- 比较前对两边做同一规范化：剔除新增的 `awardYear/decisionYear/comparisonYear` 展示字段；把 `year_mismatch` / `official_decision_year_missing` 单独分组统计，其余字段逐项比较。

## 结果

| 项目 | 差异事件数 |
| --- | ---: |
| 年度过程（businessYear、steps、final、reasons、coverage、scopeGaps） | 0 / 80 |
| 候选（total、rows、conflicts、evidence、既有决定、coverage） | 0 / 80 |
| sourceGeneration | 0 / 80 |
| 年份冲突变化（预期修复项） | 0 / 80 |

- 80 个事件的年度过程与候选输出在规范化后**逐项一致**。
- 没有任何 `year_mismatch` 被移除或新增到这些真实事件；本批样本未触发旧的复核年份误标。
- 运行时间（单 worker）：基线约 23.6s，新实现约 21.9s；回填约 32.5s。两者均为有界读取，未出现超时或资源错误。

## 复现边界

- 该记录使用容器内活动库的在线副本；未运行生产写入、部署、迁移活动库或修改原始文件。
- 回填只在副本上执行；活动库仍无 0033–0035 投影表，部署顺序与回填策略需另行按发布流程处理。
- 样本覆盖 80 个事件，主要验证公开年度/候选读取的语义一致性；不代表全库所有事件、全部接口或性能容量验收。
