# 最小插件契约

公开 API 见 [contracts.ts](../src/contracts.ts) 与 [index.ts](../src/index.ts)。本契约只覆盖当前可运行底座；后续法律 Agent 的业务模型与执行恢复尚未实现。

## 定义与装配

`PluginDefinition` 包含 `manifest`、`capabilities` 及可选 `setup`。清单声明插件 `id`、实现 `version`、`apiVersion: 1` 和可选 `requires: [{ id, version }]`。能力通过 `defineCapability({ id, version, input, output, execute })` 定义；引用只包含能力 ID 和契约版本，不包含提供方名称。能力版本为正整数且必须精确匹配；插件实现版本是独立的非空字符串，不参与 semver 范围解析。

`createHost({ plugins })` 接收明确选中的插件对象，返回已就绪宿主。每个能力 ID 只允许一个提供方；即使契约版本不同，重复提供也会冲突。配置装配负责选择实现，宿主不扫描目录、动态安装插件或自动选择提供方。

在任何 `setup` 执行前，宿主完成配置、重复插件／能力、缺失依赖、版本和循环依赖检查，并复制清单、依赖与能力描述。预检失败抛出 `HostError`，不会启动部分插件。schema 和执行函数仍引用原对象；插件代码在同一进程运行，没有安全隔离。

## 调用与校验

`host.invoke({ id, version }, input)` 返回 `InvocationResult`，调用者应分支检查 `status`：

| 状态 | 载荷与语义 |
| --- | --- |
| `success` | `data` 通过能力输出 schema 校验。 |
| `needs_input` | 非空 `reason`；表示插件需要补充输入，不自动暂停或恢复任务。 |
| `not_applicable` | 非空 `reason`；表示插件判断该能力不适用当前输入。 |
| `error` | 宿主生成的 `error.code/message`，可带 `stage` 与 `issues`。 |

每次结果带 `meta.callId`、能力引用和已定位的提供方；子调用另带 `parentCallId`。`listCapabilities()` 可查看已装配的能力与提供方。

`input`／`output` 接受 [Standard Schema V1](https://standardschema.dev/) schema（包括提供该接口的可调用实现），可使用兼容的 Zod 或其他实现。宿主支持同步／异步验证，输入转换后交给处理器；仅 `success.data` 经输出验证和转换。`defineCapability` 推导处理器输入及输出类型，宿主本身仅导入 Standard Schema 类型。示例中的来源 ID、文本和 UTF-16 偏移属于示例 schema。

处理器只能返回三个领域状态。输入／输出不符返回 `INPUT_INVALID`／`OUTPUT_INVALID`；验证器异常返回 `VALIDATOR_FAILED`，结果结构错误返回 `INVALID_RESULT`，处理器抛错返回 `EXECUTION_FAILED`。不要直接把子调用的 `error` 作为处理器结果返回；应显式处理或抛错，示例消费者采用后者。

插件通过 `context.invoke` 调用 `manifest.requires` 中声明的能力及精确版本，不直接引用另一插件实现。`requires` 表达跨插件依赖；同插件内部复用使用共享函数，不声明自身依赖（预检会将其视为依赖环）。未声明调用返回 `UNDECLARED_DEPENDENCY`，版本不符返回 `CONTRACT_VERSION_MISMATCH`。调用上下文只在本次能力调用仍在执行时开放，调用完成后再使用会返回 `CALL_CONTEXT_CLOSED`。

## 生命周期

依赖提供方先启动，消费者后启动。`setup(context)` 可获取资源，并在 setup 完成前调用 `context.onDispose(fn)` 登记清理；之后不允许登记。若 setup 失败，宿主清理已启动插件及失败插件已登记的资源，抛出 `PLUGIN_START_FAILED`，不会返回半启动宿主。

`stop()` 幂等：先拒绝新根调用（`HOST_NOT_READY`），等待已接受调用及其仍开放上下文发起的嵌套调用结束，再按启动顺序逆序清理；同一插件的清理函数也逆序执行。清理失败继续清理并收集到 `StopResult.cleanupErrors`。本版面向本地可信插件，没有隔离沙箱、超时强停、持久化执行记录、调度器或任意中断后的完整任务恢复。
