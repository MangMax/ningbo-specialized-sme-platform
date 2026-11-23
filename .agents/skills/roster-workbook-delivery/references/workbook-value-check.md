# 工作簿修订的值与修改边界

修订后，用[原生值比较脚本](../scripts/compare-workbook-values.py)只读比较保存的两份XLSX。按稳定企业标识对齐，行重排不算数据变化；值、原生单元格类型和Python读取类型分别比较。工具不计算公式，不从预览科学计数判断原生代码是否丢失，也不裁定资格或解释成员变化。后者使用[成员及原因对账](report-reconciliation.md)。

```sh
uv run .agents/skills/roster-workbook-delivery/scripts/compare-workbook-values.py \
  --before /绝对路径/修订前.xlsx --after /绝对路径/修订后.xlsx \
  --contract /绝对路径/修改约定.json --output /绝对路径/新回执.json
```

## 显式约定

```json
{
  "keyKind": "uscc",
  "sheets": {
    "有效名单": {
      "before": {"sheet": "名单", "keyColumn": "统一社会信用代码", "fields": {"代码": "统一社会信用代码", "名称": "企业名称"}},
      "after": {"sheet": "名单", "keyColumn": "统一社会信用代码", "fields": {"代码": "统一社会信用代码", "名称": "企业名称"}},
      "preserve": ["freezePanes", "autoFilter"],
      "allow": {"addedKeys": [], "removedKeys": [], "addedFields": [], "removedFields": [], "changedCells": []}
    }
  }
}
```

`sheets` 的键是回执中的逻辑表名；每侧明确实际sheet、可选headerRow（默认1）、主键列及全部业务字段映射。映射键是前后共用的逻辑字段名，值是该侧实际表头。主键必须也包含在fields中。重复、缺少表头或重复主键不能可靠比较，退出2；歧义主体不自动配对，其余主体仍报告差异。任一未映射的有内容列或工作表标为未覆盖；有意不检查的sheet须逐侧列入顶层 `excludedSheets: {"before": ["底稿"], "after": ["底稿"]}`。不能用省略字段隐藏变更。

`keyKind=uscc` 要求原生文本、精确18位大写字母数字，不做登记真实性或校验位认证。`id` 接受已确认的非空文本或整数，数字ID转字符串对齐，文本首尾空白保留并参与精确匹配；不按名称猜测，也不恢复数值代码的丢失精度。公式不能作主键。空名单默认未覆盖；确实应为空时，在该侧显式设allowEmpty=true。

默认所有成员和业务值须保持不变；字体修改无须加入允许列表，因为默认不检查字体。需要保持的交付属性由preserve选择：freezePanes比较冻结分割而不比较滚动位置，autoFilter比较筛选范围；rowHeight按主体对齐比较有效行高；font比较映射单元格的字体名称、字号、粗斜体和主题引用；numberFormat比较数字格式。这里的font只是前后属性一致性，不扫描主题或默认继承层；规定字体是否全表合规使用[版式检查](workbook-layout-check.md)。可选属性只对共同主体/字段检查，新增成员和字段必须另行明确允许。

允许成员/字段变化分别列入addedKeys/removedKeys/addedFields/removedFields，身份键按规范字符串填写；允许修改某个业务单元格时，用changedCells列出 `{ "key": "913000000000000001", "field": "名称" }`（仅格式示例，不是真实企业）。它允许该主体该字段的值及类型变化，回执仍列明前后值；不允许修改其他字段或preserve属性。授权范围应取自本次已确认修改，不用通配符。新增字段的内容本身无旧值可比较，须另行验收。

## 回执与独立反例

退出0表示声明范围已覆盖且变化均在约定内；1表示越界差异；2表示未覆盖、身份异常或输入/输出错误。正常比较JSON分别给出differences、permittedChanges、identityIssues、uncovered、实际约定、runId和输入前后SHA-256。输入/读取错误回执至少给出runId、status=error和error，不代表已完成比较或哈希核对。日期时间用ISO文本、时长用days/seconds/microseconds对象保留精度，原生类型另列；序列化失败也输出JSON错误并退出2。缺映射是输入错误，不作通过。未映射工作表一律未覆盖，空表也须显式排除。rendering明确为未评估，不能把原生值通过当成实际可读性验收。

输出不得覆盖任一输入（含硬/软链接），也不覆盖旧回执；每次用新路径，暂存后原子创建。只消费与本次stdout runId、状态、哈希一致的回执。业务工作簿和回执保存在Git外。
