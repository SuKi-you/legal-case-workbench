# 关键节点审查与准备

接案底稿是同案后续审查的基线。补入材料或修订文字后，指定上一版底稿，终端会在当前版本上整理并生成新的审查底稿。

| 节点 | 命令值 | 审查成果 |
| --- | --- | --- |
| 对方答辩 | `opponent_response` | 识别新增答辩、相反记载及需要回应的材料，保留双方出处。 |
| 新证据 | `new_evidence` | 区分新材料、同文副本、版本替换及影响的需求，更新核对事项。 |
| 庭前准备 | `hearing_preparation` | 汇总当前版本的争点、未核事项、需出示的原件与准备清单。 |

```powershell
npm.cmd run agent:labor -- --case '案件ID' --workflow opponent_response --previous-output '接案底稿ID'
npm.cmd run agent:labor -- --case '案件ID' --workflow new_evidence --previous-output '答辩审查底稿ID'
npm.cmd run agent:labor -- --case '案件ID' --workflow hearing_preparation --previous-output '新证据审查底稿ID' --run '当前整理运行ID'
```

每次命令结束后，使用 `WORKFLOW_RESULT` 中实际生成的 ID 进入下一步。庭前已有符合当前材料版本的整理运行时，可明确复用该运行，直接生成准备清单。补了新材料或换了文字版本时，省略 `--run`，按当前材料重新整理。F5 启动后也可输入 `/review 节点 上一版底稿ID [当前整理运行ID]`。

同案材料版本、需求、读取规则和来源类型均相符时，节点流程沿用基线中已核验的读取。新增、修订和此前未核验的材料按需重新读取。底座使用当前记录集合重新计算差异、覆盖和专业状态。

节点报告随底稿版本保存。它分开记录材料范围、事实及出处、逐需求覆盖、冲突、专业状态和准备事项。旧记录本轮未匹配时保留核对事项。仍需查阅的材料及附件单列。全案保存点、回滚和撤销沿用原案件工作区。

通用接口位于[节点审查模块](../底座/src/node-review/index.ts)。劳动法插件以[专业准备事项](../劳动法插件/src/node-review.ts)补充通知、工资与合同的核对清单。承办人据固定出处复核个案。
