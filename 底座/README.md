# LAW Agent：统一底座

底座统一交付插件宿主、材料能力和**项目式案件工作区**。每案有独立 ID、资料目录和办理进度，可关闭后重新打开继续存取。已有文字／图片、OCR、人工修订、固定版本引用、全案保存点与可撤销回滚；本轮在需求—读取—核对 loop 上实现四项信息整理能力，并接入 DeepSeek。

当前提供本地接口与 IDE/CLI 功能；已加入连续终端对话、模型工具调度、执行检查点恢复，以及带出处和版本的材料底稿导出。专业法律规则、账号权限、云同步与网页按规划继续。Web 放在整个项目最后，同一应用服务供未来网页复用。

## 在 IDE 中直接使用 Agent

用 VS Code 打开上一级目录的[法律 Agent 优化版工作区](../法律Agent-优化版.code-workspace)，按 **F5** 选择“法律 Agent（优化版 · 劳动法）”，即可在集成终端选择案件、输入任务。直接打开本文件夹时也可使用同一 F5 配置。原“共用能力插件”目录已归并到本工程，职责说明见[共用能力](docs/common-capabilities.md)。本目录属于独立优化副本，原项目、原交付件与对照基线保留；未安装 Dify 或额外 Agent 框架。

原 2026-11-02 验收与测试数量属于历史快照，记录保留在[执行与成果导出说明](docs/execution-and-outputs.md)。本次优化的自动化记录见[底座测试日志](../../../对照评测/优化-底座测试.log)与[劳动插件测试日志](../../../对照评测/优化-劳动插件测试.log)，最终复跑、新保留集及真实完整 CLI 验收统一在[交付报告草稿](../../../对照评测/交付报告-草稿.md)汇总。机制测试、模型提取对照与完整 CLI 验收分别判定，不能互相替代。

在当前底座目录的 PowerShell 执行：

```powershell
npm.cmd run agent:labor
```

`agent:labor` 加载同级劳动法插件；`npm.cmd run agent` 使用通用配置。在“选择案件”提示后输入序号（例如 `1`）、案件名称或完整 ID。出现“你：”后直接输入任务，例如“整理现有材料，检查差异并生成接案材料底稿”；选择输错会重新提示。终端显示实际工具调用与保存进度。输入 `/quit` 退出、`/status` 查看状态、`/materials` 查看材料、`/attach 文件路径` 选择附件、`/resume` 继续中断任务。命令使用仅留在本地 `.env.local` 的 DeepSeek 配置；调用会使用 API，密钥不写入文档或交付包。

也可以明确选择案件并恢复已有会话：

```powershell
npm.cmd run agent:labor -- --case '<案件ID或唯一名称>'
npm.cmd run agent:labor -- --case '<案件ID>' --session '<会话ID>' --resume
npm.cmd run agent:labor -- --case '<案件ID>' --session '<会话ID>' --status
```

`--status` 和 `--sessions` 可离线读取，不需要模型密钥。执行器按成功步骤保存；恢复保留已消耗预算，已确认的读取不再重复，写入先核对操作结果。补料或修订后建立关联的新处理记录；回滚也覆盖会话快照及底稿版本，迟到结果不能写回恢复后的案件。

默认通用配置整理材料明确提供的行为、讲话和交易。专业插件可通过 `--plugin` 提供工具、需求配置、专业复核器和专业成果区块；公开接入与边界见[部门法插件接口](docs/plugin-api.md)，通用示例见 `examples/plugins/transfer-review.ts`。插件的运行读取绑定当前案件，模型调用共用任务预算与取消信号；同进程可信插件并非系统沙箱。遇到多个文字分支时明确选择版本；原始 PDF/Word 附件目前仍只存取，未自动解析。

## 保存和导出底稿

Agent 的 `output.create` 生成案内 JSON、Markdown、Word，包含材料索引、时间线、陈述与出处、差异、缺项；指定前版可生成变化清单。也可通过离线命令操作：

```powershell
npm.cmd run outputs -- list --case '<案件ID>'
npm.cmd run outputs -- create --case '<案件ID>' --run '<整理运行ID>'
npm.cmd run outputs -- export --case '<案件ID>' --output '<底稿ID>' --format docx --out './runtime-data/exports/接案底稿.docx'
```

外部导出不覆盖已有文件，旧底稿保留。底稿快照是否仍与案件一致、分析是否覆盖当前材料分别显示；新增材料、未决文字分支和未解析附件不能被“已生成文档”掩盖。

运行 `npm.cmd run demo:agent` 可用虚构材料实际调用 DeepSeek，检查中断恢复、补料差异与新旧底稿；`npm.cmd run demo:outputs` 离线检查文档生成与版本变化。完整使用方法、扩展协议与本轮验收见[执行与成果导出说明](docs/execution-and-outputs.md)。

## 当前检查：四项信息整理与核对

```powershell
Set-Location -LiteralPath '.\底座'
npm.cmd run demo:information
```

配置已在本地 `.env.local` 中填写。此演示实际调用 DeepSeek，仅使用三组虚构材料，分别检查金额冲突、人物/期间/口径区分，以及口头陈述、否定和相对时间。逐项报告通过或失败并保存结果；独立验收预期不提供给模型。

代码能按专业需求提取结构化记录，检查原文引用，另行复核语义后进行跨材料关联、冲突比较与需求覆盖核对，结果随案件保存和回滚。[信息整理说明](docs/information.md)保留早期测试与三组虚构材料验收记录，本轮结果见上方对照评测链接。复杂复核曾触发超时，尚未验证真实卷宗质量或稳定时延。

## 循环机制的独立演示

```powershell
Set-Location -LiteralPath '.\底座'
npm.cmd run demo:loop
```

演示由 test 专业插件声明需求，test 读取插件先定位口头通知原话，专业复核提出有理由的补查，第二轮读取后续安排陈述后结束。输出准确出处、每轮动作、补查理由与终止原因，保存后重启读回。可替换为另一测试策略，一轮读齐，引擎和契约不变。

代码在 [循环契约](src/loops/contracts.ts)、[循环控制器](src/loops/engine.ts)和[记录存储](src/loops/store.ts)。控制器约束出处、输入版本、重复任务、轮数及读取次数；结束状态区分需求满足、待人工核对、没有新动作与预算耗尽。循环记录已纳入案件保存点、回滚预览和撤销，并发或回滚导致输入过期时拒绝旧结果。

这个 `demo:loop` 使用确定性的 test 提供方，仍不调用 LLM；四项真实模型功能由上面的 `demo:information` 检查。控制器边界与接入说明见[loop 说明](docs/intake-loop.md)。自我进化后置。

## 最快检查案件工作区

要求 Node.js ≥ 24.12、npm。在 VS Code 的 PowerShell 终端中执行：

```powershell
Set-Location -LiteralPath '.\底座'
npm.cmd run demo:cases
```

演示建立两个虚构案件，分别保存文字、标记进度，为 A 案存入原始附件；停止并重启后重新打开，导出附件核对字节，并验证用 B 案读取 A 案的材料或附件会失败。输出包含案件 ID、材料/附件 ID、阶段和导出路径。

Windows 示例使用 `npm.cmd`，避免当前 PowerShell 拦截 `npm.ps1`。新环境首次安装依赖时执行 `npm.cmd ci`。

## 整个案件恢复到保存点

在底座目录执行下面的演示，可检查完整过程，不需要 API Key：

```powershell
npm.cmd run demo:rollback
```

演示创建一个虚构案件，在补料前建立保存点，随后修改文字、创建引用、增加材料与附件、改变进度；回滚后重启验证原状态，再用自动保存点撤销回滚。输出 `restoredAfterRestart: true` 和 `rollbackUndone: true` 表示检查通过。

手动使用时，先建立保存点，后续需要恢复时列出保存点并预览：

```powershell
npm.cmd run cases -- checkpoint --case '<案件ID>' --label '初次材料核对完成' --actor '张律师'
npm.cmd run cases -- checkpoints --case '<案件ID>'
npm.cmd run cases -- rollback-preview --case '<案件ID>' --checkpoint '<保存点ID>'
```

预览列出资料与进度变化，以及材料、附件、OCR 记录、文字版本和引用哪些退出或回到当前视图。核对后，把预览输出的 `expectedRevision` 和 `token` 传给恢复命令：

```powershell
npm.cmd run cases -- rollback --case '<案件ID>' --checkpoint '<保存点ID>' --expected-revision '<expectedRevision>' --preview-token '<token>' --actor '张律师'
```

恢复会返回 `undoCheckpoint.id`，这是回滚前自动留下的全案保存点。想撤销时，对这个 ID 再执行预览与恢复即可。每次回滚与自动保存点在同一条案件记录中提交；另一窗口在预览后保存了内容，旧预览会被拒绝，需重新预览。

- 保存点包含当前已实现的全部案内状态：案件资料、办理进度、材料与附件集合、OCR 成功/失败记录、文字版本及引用集合，以及已保存的循环记录。原件和历史只保留一份，保存点记录这些不可变对象的 ID 与校验值。
- 恢复改变当前案件视图，原件、旧版本、操作历史和全部保存点继续保留。保存点后的材料及版本不再用于当前编辑；通过明确的历史引用 ID 仍能核验原出处。恢复不会自动替你选择某个文字分支。
- 案件 ID、创建时间不变；案件修订号继续增加，回滚本身也有历史记录。每个案件独立恢复，其他案件不受影响。
- 已导出的副本、编辑器里尚未提交的草稿不属于案内保存状态，不会改写。若草稿基准版本已退出当前视图，应重新导出有效版本后编辑。
- 旧案件首次访问会登记已有材料清单，再允许建立完整保存点。功能加入前仅记录进度的历史不能追溯还原为当时的完整材料快照。

## 按案件存取与标记进度

以下 `<案件ID>`、`<附件ID>`、`<材料ID>`、`<版本ID>` 等均为占位符，替换为实际输出值。全部命令默认使用 `./runtime-data`，可增加 `--data-dir` 选择数据目录。

1. 创建案件，然后列出或检索案件：

   ```powershell
   npm.cmd run cases -- create --title '陈某劳动争议' --number '内部案号-001' --actor '张律师'
   npm.cmd run cases -- list
   npm.cmd run cases -- list --query '陈某' --status active
   ```

2. 打开某案，查看案件资料、材料目录和附件目录：

   ```powershell
   npm.cmd run cases -- open --case '<案件ID>'
   ```

3. 保存文字或原始文件，再按需取出附件：

   ```powershell
   npm.cmd run cases -- add-text --case '<案件ID>' --label '接案记录' --text '需要保存的文字'
   npm.cmd run cases -- add-text --case '<案件ID>' --label '补充记录' --path './notes.txt'
   npm.cmd run cases -- add-file --case '<案件ID>' --path './document.pdf'
   npm.cmd run cases -- take-file --case '<案件ID>' --file-id '<附件ID>' --out './runtime-data/exports/document.pdf'
   ```

   `add-text --path` 接受 UTF-8 文本。`add-file` 按原始字节保存文件，支持 PDF、Word 等附件，单文件上限 **50 MiB**，本步不解析附件内容。取出时不覆盖已有文件，可更换目标文件名。文字/图片材料的原件可用 `take-material --case '<案件ID>' --material '<材料ID>' --out '<目标路径>'` 导出。

4. 标记办理进度并查历史：

   ```powershell
   npm.cmd run cases -- mark --case '<案件ID>' --stage '材料整理中' --status active --actor '张律师' --note '已收到补充材料' --expected-revision '<案件资料版本号>'
   npm.cmd run cases -- history --case '<案件ID>'
   ```

   案件版本号取自 `open` 输出的 `case.revision`。材料、附件、OCR、修订与引用等每次案内保存也会推进这个版本号。若省略 `--expected-revision`，CLI 会先读当前版本再提交。另一窗口先保存时，旧版本更新会报冲突并保留已保存内容，需重新打开核对后再保存。`update` 还可修改 `--title`、`--number` 和 `--description`。

状态只有 `active`（在办）、`paused`（暂停）、`closed`（结案），阶段 `stage` 可自定义，例如“等待补料”“庭前准备”。这是人工办理标记，不自动推断法律程序；结案后仍能继续存取资料或重新标记为在办。案件资料和进度更新保留历史，调用者填写的 `actor` 目前不是经过账号认证的身份。

图片处理沿用已有能力：

```powershell
npm.cmd run cases -- add-image --case '<案件ID>' --path './photo.png'
npm.cmd run cases -- ocr --case '<案件ID>' --material '<材料ID>'
```

图片解析先支持 PNG/JPEG，单图上限 20 MiB。本地 Tesseract.js 7.0.0 使用简体中文和英文，首次识别下载模型到 `runtime-data/ocr-cache`；普通案件存取不启动 OCR。原图、成功/失败识别记录分别保留。

## 在案件内直接编辑文字与创建引用

1. 列出文字版本并导出编辑草稿：

   ```powershell
   npm.cmd run materials:text -- versions --case '<案件ID>' --material '<材料ID>'
   npm.cmd run materials:text -- export --case '<案件ID>' --material '<材料ID>' --version '<版本ID>' --file './runtime-data/edits/text.txt'
   ```

2. 在 VS Code 打开输出的 `editableFile`，直接改字并按 **Ctrl+S**，然后保存为新版本：

   ```powershell
   npm.cmd run materials:text -- save --file './runtime-data/edits/text.txt' --editor '你的称呼' --note '对照原图纠正文字'
   ```

   草稿的 `text.txt.meta.json` 记住所属案件、数据目录及基准版本，`save` 自动沿用；不能通过传入另一 `--case` 改变归属。保存成功后推进这个草稿的基准，下次编辑可接着保存。导出不覆盖已有草稿，原图、旧识别和旧修订始终保留。

3. 对明确选定的文字版本创建引用并核对：

   ```powershell
   npm.cmd run materials:text -- cite --case '<案件ID>' --material '<材料ID>' --version '<新版本ID>' --quote '6000元'
   npm.cmd run materials:text -- resolve --case '<案件ID>' --material '<材料ID>' --reference '<引用ID>'
   ```

   摘录出现多次时增加 `--start` 指定 UTF-16 起始位置。引用固定材料、版本、文字哈希和半开区间 `[start,end)`；后续修订不改变旧引用。核对通过只说明该版本确有这段文字，不证明材料或法律事实真实。人工修订不继承旧 OCR 行框，`editor` 也只是调用者自报称呼。

## 独立区域与数据约定

```text
runtime-data/
├─ cases/<案件ID>/
│  ├─ revisions/             全案状态历史、材料清单、保存点与回滚记录
│  ├─ materials/<材料ID>/    原件、OCR、文字修订、固定版本引用
│  ├─ files/<附件ID>/        原始附件与校验记录
│  └─ loop-runs/<运行ID>.json  不可变循环记录及逐轮轨迹
├─ materials/                既有全局演示材料，保留原样
├─ edits/                    用户可编辑草稿
└─ exports/                  取出的副本
```

- 每次案件操作都明确传入 `caseId`，没有全局“当前案件”。跨案使用材料、版本、引用或附件 ID 会失败，不回退搜索其他案件或全局材料。
- 原件、OCR、修订、引用和附件留在所属案件的区域内。旧全局材料不自动迁入新案件，已有全局演示和旧 API 继续可用。
- 所有案内保存统一进入案件版本历史，按版本号校验提交；普通新增材料可在并发冲突后合并追加，回滚后迟到的旧保存会明确失败，不重新混入恢复后的视图。材料、附件和文字修订保存独立记录，不覆盖历史。各案可独立重新打开；单案的状态历史损坏时，列表单独报告该案，其他案件仍可列出。
- “随时存取”目前指本机持久化与重启恢复，不包含跨设备云同步或律师账号权限。新资料不会自动触发法律分析，本轮未增加任务清单、日历或节点审查。

## 接口、源码与验收

`createRuntime({ dataDir, ocr?, plugins? })` 默认装配 **32 个能力**：保留 `MATERIAL_CAPABILITIES` 的 9 个全局材料能力，`CASE_CAPABILITIES` 提供 23 个案件能力，包含新增的建立/列出保存点、回滚预览和恢复四项。新业务使用案件能力并显式传入案件 ID。

源码入口：[案件契约](src/cases/contracts.ts)、[案件状态与保存点存储](src/cases/store.ts)、[案件资料工作区](src/cases/workspace.ts)、[回滚服务](src/cases/rollback.ts)、[案件能力适配](src/cases/plugin.ts)、[统一启动](src/runtime.ts)。已有[材料存储](src/materials/store.ts)、[文字版本](src/materials/versions.ts)及[引用核对](src/materials/references.ts)在各案中复用，原 `materials.read@1` 仍返回原文和 OCR 记录。

操作入口：[案件命令](examples/cases.ts)、[案件工作区演示](examples/case-workspace-demo.ts)、[全案回滚演示](examples/case-rollback-demo.ts)、[直接编辑命令](examples/material-text.ts)。宿主原有职责及[host.ts 216 行逐段讲解](docs/host逐段讲解.md)继续适用。

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run demo:cases
npm.cmd run demo:rollback
```

早期 loop、全案回滚、案件工作区、人工修订与引用的测试数量均为各阶段历史记录，不能相加或当作本次优化版总数。原有直接编辑、连续保存、引用核验、分案隔离及原始附件存取检查继续保留，实施进度见[实现规划](../项目规划/implementation-roadmap.md)。当前零失败日志和最终验收状态见本页开头的对照评测链接；确定性插件测试不代表 LLM 效果或法律业务验收。

旧演示 `npm.cmd run demo:materials`、`npm.cmd run demo:versions` 仍可运行，使用原全局材料目录。整体仍按[实施规划](../项目规划/implementation-roadmap.md)逐步推进，接案整理、关键节点审查分别在 IDE 验收，最后接入 Web；当前已提供未来在线编辑和案件管理所需的本地接口，网页页面尚未实现。
