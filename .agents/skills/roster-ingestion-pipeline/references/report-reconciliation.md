# 两版名录的成员与原因对账

规则、源数据或人工修订改变成员后，用[只读对账脚本](../scripts/reconcile-roster-reports.py)比较冻结输入，说明新增、移除、保留及同标识名称变化。主张来自输入，工具不生成业务原因，不把删行当作已解决。

```sh
uv run .agents/skills/roster-ingestion-pipeline/scripts/reconcile-roster-reports.py \
  --before /绝对路径/旧名单.xlsx --after /绝对路径/新名单.xlsx \
  --contract /绝对路径/对账约定.json --reasons /绝对路径/已有说明.json \
  --output /绝对路径/对账回执.json --report /绝对路径/对账报告.txt
```

输入支持XLSX、UTF-8 CSV和JSON行对象数组。XLSX须明确sheet；CSV表头位置可配置。不要把业务库或工作簿存入Git；工具只读输入，记录哈希，输出路径必须与输入及彼此不同，包括硬链接。

## 对账约定

```json
{
  "keyKind": "uscc",
  "before": {
    "sheet": "名单", "headerRow": 1,
    "identityColumn": "统一社会信用代码", "nameColumn": "企业名称",
    "noteColumns": ["备注"],
    "metadata": {"titleCode": "specialized_sme", "asOf": "2026-11-10", "ruleVersion": "v10", "snapshotId": "旧快照"}
  },
  "after": {
    "sheet": "名单", "headerRow": 1,
    "identityColumn": "统一社会信用代码", "nameColumn": "企业名称",
    "noteColumns": ["备注"],
    "metadata": {"titleCode": "specialized_sme", "asOf": "2026-11-10", "ruleVersion": "v11", "snapshotId": "新快照"}
  }
}
```

元数据由调用者明确提供，脚本不证明它们与部署一致。称号不同拒绝比较；规则、判断日或快照不同会逐项列出口径差别，不能据此宣布数据修复。

`keyKind=uscc` 使用已确认统代：字符串经NFKC、大写、去空白/不可见字符后，要求18位字母数字；数值型代码、空值或短码列为异常，不尝试恢复丢失精度。这是格式检查，不是登记真实性或校验位认证。`keyKind=id` 使用已确认稳定ID，接受非空字符串或正整数。名称不是身份键，名称变化仅作观察，不能据此确认更名。

缺失或重复映射列是输入错误；重复主体键阻断两侧该主体的自动比较，原行号与对应侧记录仍列入歧义组。无效标识行另外逐行报告；不将某侧的重复主体假装成另一侧新增。其余可比主体仍给出集合结果。

## 已有说明

`--reasons` 可省略；提供时，JSON以规范身份键索引，只能填写已有主张。例如：

```json
{
  "913000000000000001": {
    "reason": "用户明确的人工排除理由原文",
    "source": "确认记录或证据引用",
    "investigation": "completed",
    "systemCorrection": "not_requested",
    "externalAction": "pending",
    "note": "保留补充说明原文"
  }
}
```

这个键仅演示格式，不是真实企业。三个完成状态都是输入原文，不由工具从原因推算；未提供状态写unknown。明确原因只标为provided_not_verified，不表示工具核实、更正或办结。新增、移除及同标识名称变化缺原因时标未解释，未使用的说明也保留。

## 输出与验收

JSON包含原始行数、有效不同标识数、可比身份数、完整新增/移除/保留集合、歧义/无效行、原始说明、口径差异及文件哈希。可读报告摘出成员/名称变化及三种完成状态，不列全部不变成员。

退出码0表示对账完成且变化都有输入说明；1表示有未解释变化；2表示身份异常或输入/读写错误。0不表示企业资格正确、说明已被核实或外部办理已完成。逐项处理异常后再认领“本轮对账已闭环”。

实际输入的独立CLI反例：

```sh
uv run .agents/skills/roster-ingestion-pipeline/scripts/test_689_report_reconciliation.py
```
