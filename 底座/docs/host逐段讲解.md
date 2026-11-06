# 读懂 host.ts：216 行代码逐段讲解

讲解日期：2026-10-31。对应 [真正的源码 host.ts](C:/Users/13700/Documents/LAW_Agent/法律agent3.0/底座/src/host.ts)，当前共 216 行。本笔记保留各段原代码，源码未改动；以后源码变化时行号也可能变化。

各代码块是原文件片段，部分位于类的内部；请在原工程中运行，不要把每一块当作独立程序执行。

## 先知道这个文件在做什么

你可以把 `Host` 理解为“插件运行管理器”。它记住已经选择的插件及其能力，收到调用请求后查找提供方、校验数据、执行能力，再返回结果；停止时等待已接纳的调用完成，并释放登记过的资源。

当前文件不包含模型推理和劳动法规则，也没有保存案件或暂停恢复任务的代码。插件里的 `needs_input` 在这里仅仅是一种返回结果。

有三个容易混淆的名词：

| 名词 | 这里的意思 | 实际示例 |
| --- | --- | --- |
| 插件 plugin | 提供一项或多项能力的代码模块。 | `example.quote-index-of` 插件。 |
| 能力 capability | 对外可调用的一项具体功能。 | `example.locate-quote`：在文本中定位原文。 |
| 宿主 host | 装配、调用、校验并管理插件的运行对象。 | `await createHost(...)` 创建的对象。 |

“能力版本”约束输入输出契约，“插件版本”标记具体实现的版本。更换插件实现时，只要仍满足相同能力契约，调用方就可以保持不变。

## 阅读地图

先从入口读，再沿调用关系走；不必强行从第 1 行一路读到第 216 行。

| 段落 | 源码行号 | 回答的问题 |
| --- | --- | --- |
| 1. createHost | 212—216 | 外部从哪里创建宿主？ |
| 2. imports | 1—10 | 用到了哪些外部功能和类型？ |
| 3. ResourceScope、failure | 12—20 | 如何记资源、如何返回错误？ |
| 4. Host 的字段 | 22—34 | 宿主需要记住什么？ |
| 5. start | 36—65 | 插件怎样启动？ |
| 6. listCapabilities | 67—73 | 怎样查看已经装配的能力？ |
| 7. invoke | 75—83 | 怎样接受外部调用？ |
| 8. meta | 94—105 | 怎样给调用加上身份信息？ |
| 9. dispatch | 107—115 | 怎样统计正在运行的调用？ |
| 10. perform | 147—186 | 怎样实际执行和校验结果？ |
| 11. context | 117—145 | 插件怎样调用依赖能力？ |
| 12. stop | 85—92 | 怎样发起停止？ |
| 13. shutdown | 188—196 | 怎样等待调用完成后停机？ |
| 14. cleanup | 198—210 | 怎样依次释放资源？ |

## 读代码前，先认这些语法

| 写法 | 通俗解释 |
| --- | --- |
| `const x = ...` | 给一个值起名字，之后不把这个名字重新指向别的值；对象内部是否可变另算。 |
| `let x = ...` | 声明后续可以重新赋值的变量。 |
| `value: SomeType` | 冒号后面说明 TypeScript 期望的类型，本身不进行运行时校验。 |
| `interface` | 描述一个对象应有哪些字段和方法，编译后不作为运行代码保留。 |
| `class` / `new` | 定义一类对象及其行为 / 创建其中一个对象。 |
| `this` | 当前这个宿主对象。 |
| `#state`、`#perform` | 类内部的私有字段或方法，外部不能直接访问。`#` 不是注释。 |
| `readonly` | TypeScript 限制该属性重新赋值；并不自动深冻结对象。 |
| `unknown` | 这个值是什么类型还不确定，要检查后再使用。 |
| `Promise<T>` | 一个表示“异步操作最终完成或失败”的对象，完成值的类型为 `T`。 |
| `async` / `await` | 声明异步函数 / 等待异步结果后继续当前函数；等待期间不会把整个 Node 进程都卡住。 |
| `?.` | 前面的值为 `null` 或 `undefined` 时跳过属性访问或调用。 |
| `condition ? a : b` | 条件成立用 `a`，否则用 `b`。 |
| `() => ...` | 定义一个函数。传给别人以后调用时，常称“回调函数”。 |
| `try / catch / finally` | 尝试执行 / 处理抛出的错误 / 无论正常返回还是抛错都执行收尾。 |

这里出现的 `MaybePromise<void>` 定义在 `contracts.ts`，意思是“可以直接结束，也可以返回一个需要等待的 Promise”。`void` 表示没有需要使用的返回值。

## 第 1 段：先从 createHost 入口看起（212—216 行）

[打开源码入口](C:/Users/13700/Documents/LAW_Agent/法律agent3.0/底座/src/host.ts:212)

```typescript
export async function createHost(options: HostOptions): Promise<PluginHost> {
  const host = new Host(planHost(options));
  await host.start();
  return host;
}
```

这五行就是外部创建宿主的入口：

1. 调用者传入 `options`，里面有本次明确选中的插件。
2. `planHost(options)` 先执行：检查配置、重复提供方、依赖和版本，排好启动顺序。它的实现放在 `plan.ts`。
3. `new Host(...)` 用这份计划创建宿主对象。
4. `await host.start()` 等待所有插件启动完成。
5. 最后把已经就绪的宿主返回给调用者。

`export` 表示其他文件可以导入这个函数。`Promise<PluginHost>` 表示调用者需要等待，才能拿到宿主。

如果计划检查或启动失败，函数会抛错，不会把半启动的宿主返回。

## 第 2 段：import，把需要的东西拿进来（1—10 行）

```typescript
import { randomUUID } from 'node:crypto';
import type {
  CapabilityContext, CapabilityDescription, CapabilityRef, HostOptions,
  InvocationError, InvocationMeta, InvocationResult, MaybePromise,
  PluginDefinition, PluginHost, StopResult,
} from './contracts.ts';
import { HostError } from './errors.ts';
import { isCapabilityRef, isRecord, planHost } from './plan.ts';
import type { HostPlan } from './plan.ts';
import { errorMessage, validate } from './validation.ts';
```

- `randomUUID` 是 Node 提供的功能，用来给每次调用生成标识。
- `import type` 只拿类型说明，例如“调用结果应该长什么样”；这些导入不会作为运行代码保留。
- `HostError` 是项目定义的启动错误类型。
- `planHost` 负责提前检查和整理插件配置。
- `isCapabilityRef`、`isRecord` 是运行时检查函数。
- `validate` 真正执行输入输出校验；`errorMessage` 把抛出的错误整理成文字。

`./` 表示当前文件所在文件夹。因此 `./contracts.ts` 就是 `host.ts` 旁边的文件。

## 第 3 段：资源记录和统一错误格式（12—20 行）

```typescript
interface ResourceScope {
  readonly pluginId: string;
  readonly disposers: (() => MaybePromise<void>)[];
  accepting: boolean;
}

function failure(meta: InvocationMeta, error: InvocationError): InvocationResult {
  return { status: 'error', error, meta };
}
```

`ResourceScope` 描述每个插件的清理记录：

- `pluginId`：资源归哪个插件。
- `disposers`：需要在清理时调用的函数列表。
- `accepting`：当前是否还允许登记清理函数。它不代表插件能否接受业务调用。

`(() => MaybePromise<void>)[]` 从里往外读：这是一个数组，里面每一项都是“不需要参数、可以同步或异步完成”的函数。

虽然 `disposers` 是 `readonly`，仍可以向数组里 `push`，也可以清空它；限制的是不能把这个属性重新指向另一个数组。

`failure` 很简单：把错误与本次调用的信息装进固定格式。`error`、`meta` 是对象属性简写，分别等于 `error: error`、`meta: meta`。

注意：`failure` 是返回错误结果，没有 `throw`。创建宿主失败会抛错；能力调用失败通常返回 `status: 'error'`，调用者按状态处理。

## 第 4 段：Host 对象需要记住什么（22—34 行）

```typescript
class Host implements PluginHost {
  #state: PluginHost['state'] = 'starting';
  readonly #plan: HostPlan;
  readonly #scopes: ResourceScope[] = [];
  #activeCalls = 0;
  #onDrained: (() => void) | undefined;
  #stopPromise: Promise<StopResult> | undefined;

  constructor(plan: HostPlan) {
    this.#plan = plan;
  }

  get state(): PluginHost['state'] { return this.#state; }
```

`implements PluginHost` 的意思是：TypeScript 要检查这个类是否满足 `PluginHost` 约定的接口，不会因此自动生成运行逻辑。

| 字段 | 保存的内容 |
| --- | --- |
| `#state` | 当前是启动中、就绪、停止中还是已停止。 |
| `#plan` | 已检查的配置、启动顺序和能力提供方表。 |
| `#scopes` | 各插件登记的资源清理记录。 |
| `#activeCalls` | 当前尚未完成的能力调用数量。 |
| `#onDrained` | 调用数归零时，用来通知等待停止过程的函数。 |
| `#stopPromise` | 已经发起的停止过程，让重复 `stop()` 共用它。 |

`PluginHost['state']` 是一种类型写法：取出接口中 `state` 字段允许的类型。它不是运行时读取某个对象的状态。

`constructor` 在 `new Host(plan)` 时执行，先把计划存起来。真正启动插件发生在之后的 `start()`。

`get state()` 让外部可以写 `host.state` 查看状态，不需要写 `host.state()`。

## 第 5 段：start，按顺序启动插件（36—65 行）

```typescript
  async start(): Promise<void> {
    let activating = '';
    try {
      for (const plugin of this.#plan.orderedPlugins) {
        activating = plugin.manifest.id;
        const scope: ResourceScope = { pluginId: activating, disposers: [], accepting: true };
        this.#scopes.push(scope);
        try {
          await plugin.setup?.({
            onDispose(dispose) {
              if (!scope.accepting || typeof dispose !== 'function') {
                throw new Error('Disposers must be registered as functions during setup.');
              }
              scope.disposers.push(dispose);
            },
          });
        } finally {
          scope.accepting = false;
        }
      }
      this.#state = 'ready';
    } catch (error) {
      const cleanupErrors = await this.#cleanup();
      this.#state = 'stopped';
      throw new HostError('PLUGIN_START_FAILED', `${activating}: ${errorMessage(error)}`, {
        pluginId: activating,
        cleanupErrors,
      });
    }
  }
```

这一段的顺序是：

1. 按 `orderedPlugins` 启动，依赖提供方排在消费者前面。
2. 启动每个插件前，先为它建立资源记录并加入 `#scopes`。
3. 如果插件有 `setup`，就执行并等待完成。
4. 插件可以调用收到的 `onDispose`，把清理函数登记进来。
5. 每次 `setup` 结束后关闭登记入口；所有插件启动完毕，状态改为 `ready`。

`plugin.setup?.(...)` 表示 `setup` 可有可无。一个简单的纯计算插件不一定需要初始化资源。

先加入 `#scopes` 再执行 `setup` 很关键：假设插件取得了资源、登记了清理函数，然后初始化中途失败，宿主仍知道应当清理什么。

这里有两层错误处理：

- 内层 `finally` 保证正常结束或抛错之后，`accepting` 都变为 `false`。
- 外层 `catch` 在启动失败时执行已登记的清理，状态改为 `stopped`，再抛出 `PLUGIN_START_FAILED`。

清理只能执行插件预先登记的函数，并不会自动撤销任意外部操作。

## 第 6 段：listCapabilities，列出能力（67—73 行）

```typescript
  listCapabilities(): readonly CapabilityDescription[] {
    return [...this.#plan.providers.values()].map(({ capability, plugin }) => ({
      id: capability.id,
      version: capability.version,
      provider: { id: plugin.manifest.id, version: plugin.manifest.version },
    }));
  }
```

`providers` 是一张 `Map` 表，按能力 ID 查找提供方。这里拿出所有条目，转成方便查看的数组。

`[...something]` 在这里是把可迭代的条目展开到数组里；`.map(...)` 表示对每一项进行转换。

`({ capability, plugin })` 是拆出这两个字段。箭头后面的 `({ ... })` 表示直接返回一个对象，外层括号避免它被当成函数体。

例如列表中可能有：

```typescript
{
  id: 'example.locate-quote',
  version: 1,
  provider: { id: 'example.quote-index-of', version: '1.0.0' }
}
```

它说明能力契约是第 1 版，由哪个插件实现；查看列表本身不会执行该能力。这里的 `readonly` 是类型约束，返回值是整理出来的描述列表，不是自动冻结整个数组。

## 第 7 段：invoke，接收外部调用（75—83 行）

```typescript
  invoke(ref: CapabilityRef, input: unknown): Promise<InvocationResult> {
    const meta = this.#meta(ref);
    if (this.#state !== 'ready') {
      return Promise.resolve(failure(meta, {
        code: 'HOST_NOT_READY', message: `Host is ${this.#state}; new calls are not accepted.`,
      }));
    }
    return this.#dispatch(ref, input, meta);
  }
```

调用者可以这样请求能力：

```typescript
const result = await host.invoke(
  { id: 'example.report-quote', version: 1 },
  { sourceId: 'fictional-note-1', text: '测试文本', quote: '文本' },
);
```

这个方法只做三件事：建立调用信息、检查宿主状态、把请求交给 `#dispatch`。

状态不是 `ready` 时返回 `HOST_NOT_READY`，不会执行插件。`Promise.resolve(...)` 把这个立即可得的错误结果包装为 Promise，使这个方法始终提供异步返回接口。

`input: unknown` 表示：外部传来的数据现在还不可信任其类型，稍后必须真正校验。

## 第 8 段：meta，给每次调用加上信息（94—105 行）

```typescript
  #meta(ref: CapabilityRef, parentCallId?: string): InvocationMeta {
    const capability = isCapabilityRef(ref)
      ? Object.freeze({ id: ref.id, version: ref.version })
      : Object.freeze({ id: '<invalid>', version: 0 });
    const plugin = this.#plan.providers.get(capability.id)?.plugin;
    return Object.freeze({
      callId: randomUUID(),
      capability,
      ...(parentCallId ? { parentCallId } : {}),
      ...(plugin ? { provider: Object.freeze({ id: plugin.manifest.id, version: plugin.manifest.version }) } : {}),
    });
  }
```

这段生成的内容包括：

- `callId`：本次调用的标识。
- `capability`：要调用的能力与契约版本。
- `provider`：已经找到的实现插件和版本。
- `parentCallId`：如果是插件内部发起的子调用，记录父调用标识。

比如外部请求“生成定位报告”，报告插件再请求“查找原文”，这是两个调用，拥有不同 `callId`，后者用 `parentCallId` 指回前者。

`parentCallId?: string` 表示这个参数可以不传。

`...(condition ? { field: value } : {})` 的意思是：条件成立时把字段加进对象，否则不加。

`Object.freeze` 防止被冻结对象自身的属性被改写，但它是浅冻结，不会自动冻结所有嵌套对象；这里对 `capability` 和 `provider` 也分别进行了冻结。

这些是跟随结果返回的信息，当前没有写入数据库，也不等于已建立完整的持久化审计日志。

## 第 9 段：dispatch，给执行过程计数并收尾（107—115 行）

```typescript
  #dispatch(ref: CapabilityRef, input: unknown, meta: InvocationMeta): Promise<InvocationResult> {
    this.#activeCalls++;
    return this.#perform(ref, input, meta)
      .catch((error: unknown) => failure(meta, { code: 'EXECUTION_FAILED', message: errorMessage(error) }))
      .finally(() => {
        this.#activeCalls--;
        if (this.#activeCalls === 0) this.#onDrained?.();
      });
  }
```

可以读成：

> 调用数加一 → 执行 `perform` → 意外抛错时转成统一错误 → 无论结果如何都把调用数减一。

`++` 是加一，`--` 是减一。这里统计的不只插件函数本身，也包括输入、输出校验；子调用同样会进入这套计数。

`.catch(...)` 处理 Promise 的拒绝。如果 `perform` 已经正常返回一个错误对象，就不会再触发这个 `catch`。

`.finally(...)` 无论成功或失败都执行。如果调用数归零，就尝试执行 `#onDrained`，通知正在等待的停止过程继续。

`this.#onDrained?.()` 表示：只有通知函数存在时才调用。

## 第 10 段：perform，真正执行能力（147—186 行）

[打开核心执行逻辑](C:/Users/13700/Documents/LAW_Agent/法律agent3.0/底座/src/host.ts:147)

```typescript
  async #perform(ref: CapabilityRef, input: unknown, meta: InvocationMeta): Promise<InvocationResult> {
    if (!isCapabilityRef(ref)) {
      return failure(meta, { code: 'CONFIG_INVALID', message: 'Invalid capability reference.' });
    }
    const provider = this.#plan.providers.get(ref.id);
    if (!provider) {
      return failure(meta, { code: 'CAPABILITY_NOT_FOUND', message: `No provider for ${ref.id}.` });
    }
    const { capability, plugin } = provider;
    if (capability.version !== ref.version) {
      return failure(meta, {
        code: 'CONTRACT_VERSION_MISMATCH', message: `${ref.id}: requested @${ref.version}, provided @${capability.version}.`,
      });
    }
    const parsedInput = await validate(capability.input, input, 'input');
    if (!parsedInput.ok) return failure(meta, parsedInput.error);

    let open = true;
    try {
      const outcome: unknown = await capability.execute(parsedInput.value, this.#context(plugin, meta, () => open));
      if (!isRecord(outcome)) {
        return failure(meta, { code: 'INVALID_RESULT', message: 'Capability did not return an outcome object.' });
      }
      if (outcome.status === 'success' && 'data' in outcome) {
        const parsedOutput = await validate(capability.output, outcome.data, 'output');
        return parsedOutput.ok
          ? { status: 'success', data: parsedOutput.value, meta }
          : failure(meta, parsedOutput.error);
      }
      if ((outcome.status === 'needs_input' || outcome.status === 'not_applicable')
        && typeof outcome.reason === 'string' && outcome.reason.trim().length > 0) {
        return { status: outcome.status, reason: outcome.reason, meta };
      }
      return failure(meta, { code: 'INVALID_RESULT', message: 'Capability returned an invalid status or payload.' });
    } catch (error) {
      return failure(meta, { code: 'EXECUTION_FAILED', message: errorMessage(error) });
    } finally {
      open = false;
    }
  }
```

这是阅读重点，可以分成五小步。

### 10.1 找能力并检查版本（148—160 行）

先检查请求是否有合法的能力 ID 和版本，再从 `providers` 表查找实现。找不到就返回 `CAPABILITY_NOT_FOUND`，版本不同就返回 `CONTRACT_VERSION_MISMATCH`。

`const { capability, plugin } = provider` 是对象拆解：同时取出能力定义和所属插件。

### 10.2 校验输入（161—162 行）

`validate` 用能力声明的输入规则检查 `input`。不符合规则时，立即返回错误，不会执行插件。

校验器也可能转换数据，所以之后使用 `parsedInput.value`。例如某个规则把字符串数字转换为数字，插件收到的是转换后的值。

### 10.3 执行插件（164—169 行）

`open = true` 标记本次调用的上下文仍然有效。

随后执行 `capability.execute(...)`，传入已经校验的输入，以及 `#context` 创建的调用上下文。这里才进入具体插件的代码。

`const outcome: unknown` 表示即使插件有类型声明，运行中也仍要检查实际返回值。`isRecord` 只做初步对象检查，后面的状态检查才进一步判断结果结构。

### 10.4 校验并整理返回结果（170—180 行）

| 插件结果 | 宿主怎么处理 |
| --- | --- |
| `success` 且有 `data` | 校验成功数据；只有通过输出规则才向外返回成功。 |
| `needs_input` 且有非空原因 | 返回“需要补充输入”的状态。 |
| `not_applicable` 且有非空原因 | 返回“不适用”的状态。 |
| 其他情况 | 返回 `INVALID_RESULT`。 |

`success.data` 还可能经过输出规则转换，所以返回的是 `parsedOutput.value`。

这意味着插件返回成功不等于宿主直接认定成功。宿主要检查结果是否符合声明的格式；这一步也不等于验证了内容的法律正确性。

`needs_input` 在此只返回状态，不会保存案件或自动等待用户回答。处理器直接返回 `error` 也不属于约定的三个领域结果，会被当作非法结果；子调用错误应当由插件明确处理或抛出。

### 10.5 处理异常并关闭上下文（181—185 行）

插件执行抛错时，返回 `EXECUTION_FAILED`。

最后 `open = false` 一定执行。这会让本次调用保存下来的上下文失效，避免插件以后拿着旧上下文继续发起新调用。

输入输出校验器的具体异常分类在 `validation.ts` 中完成，例如数据不合法与校验器自己抛错，会返回不同错误码。

## 第 11 段：context，给插件一个受约定约束的调用入口（117—145 行）

```typescript
  #context(plugin: PluginDefinition, meta: InvocationMeta, isOpen: () => boolean): CapabilityContext {
    return Object.freeze({
      callId: meta.callId,
      invoke: (ref: CapabilityRef, input: unknown) => {
        const childMeta = this.#meta(ref, meta.callId);
        if (!isOpen()) {
          return Promise.resolve(failure(childMeta, {
            code: 'CALL_CONTEXT_CLOSED', message: 'The originating call has finished.',
          }));
        }
        if (!isCapabilityRef(ref)) {
          return Promise.resolve(failure(childMeta, { code: 'CONFIG_INVALID', message: 'Invalid capability reference.' }));
        }
        const dependency = plugin.manifest.requires?.find((item) => item.id === ref.id);
        if (!dependency) {
          return Promise.resolve(failure(childMeta, {
            code: 'UNDECLARED_DEPENDENCY', message: `${plugin.manifest.id} did not declare ${ref.id}.`,
          }));
        }
        if (dependency.version !== ref.version) {
          return Promise.resolve(failure(childMeta, {
            code: 'CONTRACT_VERSION_MISMATCH', message: `${ref.id}: declared @${dependency.version}, requested @${ref.version}.`,
          }));
        }
        // Accepted calls may finish their dependency calls while stop() drains.
        return this.#dispatch(ref, input, childMeta);
      },
    });
  }
```

插件执行时得到的 `context` 目前只有调用标识和 `invoke` 方法。插件可以通过它请求依赖能力，而不需要导入依赖插件的具体实现。

每次子调用依次检查：

1. 父调用是否仍有效；已经结束则返回 `CALL_CONTEXT_CLOSED`。
2. 能力引用是否合规。
3. 插件是否在 `manifest.requires` 中声明过这个依赖。
4. 请求的版本是否与声明一致。
5. 通过后交给 `#dispatch`，进入相同的计数、校验、执行流程。

`find((item) => item.id === ref.id)` 就是在依赖列表中找出 ID 相同的那一项。

`isOpen: () => boolean` 表示传入的是一个“调用后返回布尔值”的函数。前面的 `() => open` 会读取第 10 段那个变量的当前值，这种保留对外层变量访问的机制称为闭包。`open` 变为 `false` 后，旧上下文就会检查到变化。

注意，停止时外部新请求被拒绝，但已经接纳的调用仍可在其上下文有效期间完成依赖调用。这能让正在进行的工作收尾，而不是做到一半忽然失去依赖。

这是同进程的调用约定，不是对插件代码的安全沙箱隔离。

## 第 12 段：stop，发起一次可重复等待的停止过程（85—92 行）

```typescript
  stop(): Promise<StopResult> {
    if (!this.#stopPromise) {
      this.#state = 'stopping';
      // Store the shared promise before a disposer can synchronously re-enter stop().
      this.#stopPromise = Promise.resolve().then(() => this.#shutdown());
    }
    return this.#stopPromise;
  }
```

第一次调用 `stop()`：

1. 立即把状态改为 `stopping`，阻止新的外部调用。
2. 创建并保存 `#stopPromise`。
3. 随后执行真正的 `#shutdown()`。

以后再调用 `stop()`，会拿到已经保存的同一个 Promise，等待同一次停止，不重新清理一遍。这就是这里说的“幂等”。

第 89 行故意使用 `Promise.resolve().then(...)`。`.then` 中的回调会稍后执行，先让当前语句把 Promise 保存好。

为什么需要这个顺序？清理函数也可能再次触发 `stop()`。如果还没保存第一次停止过程，就开始执行清理，可能重复进入停止逻辑；提前保存之后，再次调用就能直接复用已有 Promise。

这个方法没有 `async`，直接把保存的 Promise 返回，便于多次调用共享同一个对象。

## 第 13 段：shutdown，等待已接纳的调用完成（188—196 行）

```typescript
  async #shutdown(): Promise<StopResult> {
    if (this.#activeCalls > 0) {
      await new Promise<void>((resolve) => { this.#onDrained = resolve; });
    }
    const cleanupErrors = await this.#cleanup();
    this.#onDrained = undefined;
    this.#state = 'stopped';
    return Object.freeze({ status: 'stopped', cleanupErrors: Object.freeze(cleanupErrors) });
  }
```

如果还有调用没有完成，就创建一个 Promise，并把它的 `resolve` 函数保存到 `#onDrained`。

`resolve` 可以理解为“通知这个等待已经完成”的函数。第 9 段把调用数减到零后，会执行它，于是这里的 `await` 就可以继续。

后面的顺序是：清理资源 → 清掉等待通知函数 → 状态改为 `stopped` → 返回停止结果。

停止结果中的 `cleanupErrors` 可能有内容，调用者要检查它。当前停止机制会等待已接纳的调用结束，没有超时强停功能。

## 第 14 段：cleanup，逆序清理资源（198—210 行）

```typescript
  async #cleanup(): Promise<{ pluginId: string; message: string }[]> {
    const errors: { pluginId: string; message: string }[] = [];
    for (const scope of [...this.#scopes].reverse()) {
      for (const dispose of [...scope.disposers].reverse()) {
        try { await dispose(); }
        catch (error) { errors.push({ pluginId: scope.pluginId, message: errorMessage(error) }); }
      }
      scope.disposers.length = 0;
    }
    this.#scopes.length = 0;
    return errors;
  }
}
```

这一段有两层循环：

- 外层：按插件启动顺序的反方向清理，先清消费者，再清它依赖的提供方。
- 内层：同一插件内，后登记的清理函数先执行。

例如先准备底层连接，再创建使用这个连接的对象，清理时通常应该先关闭使用者，再关闭连接。

`[...array].reverse()` 先复制数组再反转，避免直接改变原数组的顺序。

某个清理函数抛错时，只把错误加入 `errors`，然后继续清理其他资源。`scope.disposers.length = 0` 和 `this.#scopes.length = 0` 是清空已处理的记录。

第 210 行的 `}` 结束整个 `Host` 类；最后五行公开入口函数放在类外。

## 用现有测试插件串起来

示例文件：

- [configuration.ts：选择并装配插件](C:/Users/13700/Documents/LAW_Agent/法律agent3.0/底座/examples/configuration.ts)
- [consumer.ts：消费者如何调用依赖能力](C:/Users/13700/Documents/LAW_Agent/法律agent3.0/底座/examples/consumer.ts)
- [demo.ts：外部怎样运行演示](C:/Users/13700/Documents/LAW_Agent/法律agent3.0/底座/examples/demo.ts)

以默认配置中成功定位“一枚蓝色书签”的那一次调用为例：

1. 配置选中报告消费者和 `index-of` 提供方，交给 `createHost`。
2. `planHost` 检查依赖，把原文查找提供方排在报告消费者前面。
3. `start` 让宿主就绪。演示插件可以没有 `setup`，不需要假装打开数据库等资源。
4. `host.invoke` 收到报告能力请求，生成调用信息，`#dispatch` 把调用数加到 1。
5. `#perform` 校验报告请求，执行消费者代码。
6. 消费者用 `context.invoke` 请求原文定位能力，依赖检查通过后，子调用数加到 2。
7. 提供方定位原文，返回示例中的来源 ID 和 `[14, 20)` 位置；输出校验通过，子调用结束，计数回到 1。
8. 消费者返回报告结果，根调用输出校验通过，上下文关闭，计数回到 0。
9. 完成所有演示请求后，`stop` 发起关闭，`shutdown` 等待并清理，状态变为 `stopped`。

这两个插件之间交换的是能力契约。切换成 `scan` 提供方之后，消费者代码和宿主代码都保持不变。

## 最后检查自己是否读懂了

读完后，可以试着用自己的话回答：

1. `createHost` 为什么要等待 `start` 完成再返回？
2. `invoke`、`dispatch`、`perform` 为什么分成三个方法，各负责什么？
3. 插件返回成功后，宿主为什么还要校验输出？
4. `#activeCalls` 与 `#onDrained` 怎样配合，让 `stop` 等到调用结束？
5. 第二次调用 `stop` 为什么不会重复清理？
6. 为什么插件改成另一种实现后，消费者仍然能调用？

第一次阅读先抓住 `createHost → start → invoke → dispatch → perform → stop → shutdown → cleanup` 这条主线，再回来看上下文和 Promise 的细节。
