# 工作簿交付属性检查

生成或修订业务工作簿后，用[只读检查脚本](../scripts/check-workbook-layout.py)核对**最终保存文件**。先从本次任务确定基准工作簿、必备工作表/字段及版式约定；本工具不替代理选择最新版模板，不从文件名或上次偏好猜要求。

```sh
uv run .agents/skills/roster-ingestion-pipeline/scripts/check-workbook-layout.py \
  --workbook /绝对路径/最终名单.xlsx \
  --contract /绝对路径/本次版式约定.json \
  --output /绝对路径/格式检查回执.json
```

输入、约定及回执保存在Git外。输出路径不能与任一输入相同；脚本不保存工作簿，并比较读取前后的SHA-256。

## 本次约定

JSON顶层必须有非空 `sheets` 对象，以实际工作表名为键。每张表给出有界 `range` 和至少一个要检查的属性。未声明的属性不检查。下面只演示约定结构，不是所有名单的默认格式：

```json
{
  "allowExtraSheets": false,
  "sheets": {
    "名单": {
      "range": "A1:B3",
      "headers": ["企业名称", "统一社会信用代码"],
      "dataRows": 2,
      "font": {"name": "微软雅黑", "size": 12},
      "rowHeight": 40,
      "headerAlignment": {"horizontal": "center", "vertical": "center"},
      "freezePanes": "A2",
      "autoFilter": "A1:B3"
    }
  }
}
```

- `headers` 按声明矩形第一行逐列比较；必备工作表或字段缺失会失败。`dataRows` 是矩形中表头之后的非空业务行数。
- `font` 可只指定名字或字号；检查矩形内全部单元格、工作簿默认字体和覆盖矩形的行列默认样式。字体存在主题引用时，另外核对该引用的Latin、东亚及简体中文等相关字体角色；未被引用的替代字体不会仅因存在而失败。
- `rowHeight` 按实际行设置或默认行高检查，不自动调整。`headerAlignment` 可指定水平和垂直对齐。
- `freezePanes` 表达冻结边界，`A2` 表示冻结一行；检查冻结行列数，不把已滚动到 `A94` 误判为冻结93行。`null` 表示不冻结。
- `autoFilter` 检查工作表级筛选范围；不将Excel Table筛选代替它。`null` 表示不设工作表筛选。
- `allowExtraSheets` 默认为true；false时要求工作表集合完全相同。全工作簿格式约定应列出全部表；只列一张表只证明那一张表。

未知约定键、空约定或非法范围作为输入错误，不猜测意图。默认每张声明范围最多一百万单元格，可显式调整 `--max-cells`；超过预算报告未覆盖。默认仅列前200条明细，`omittedFindings` 明示省略数量，汇总仍统计全部失败；可调 `--max-details`。

## 结果与人工验收

退出码0是声明范围内通过；1是属性不符合；2是输入/读取错误或存在未覆盖范围。JSON报告包含逐项位置、实际值、期望值、失败数及文件哈希。遇到失败或未覆盖，应先定位原因；报告通过只证明输入约定对应的静态属性，不证明三年资格、来源判断、字体在用户机器的安装情况或长历史的实际可读性。

内容或版式变化后仍需查看最终文件中最长、多行内容；本工具不会自动修复、删减历史、修改行高或变更业务数据。

独立CLI反例可运行：

```sh
uv run .agents/skills/roster-ingestion-pipeline/scripts/test_693_workbook_layout.py
```
