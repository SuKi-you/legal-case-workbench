import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { createDeepSeekModel, loadDeepSeekConfig } from '../src/information/deepseek.ts';
import { createLegalAgent, type LegalAgentExtension } from '../src/agent/engine.ts';
import type { AgentState } from '../src/agent/contracts.ts';
import { agentStateSchema, agentWorkflowSchema } from '../src/agent/contracts.ts';
import { COMMON_INFORMATION_PROFILE } from '../src/agent/profiles.ts';
import { ExecutionStore } from '../src/execution/store.ts';

const help = `法律 Agent 终端
npm.cmd run agent -- --case <案件ID或唯一名称>
npm.cmd run agent -- --case <案件ID> --session <会话ID>
npm.cmd run agent -- --case <案件ID> --session <会话ID> --resume
npm.cmd run agent -- --case <案件ID> --once "整理现有材料并生成底稿"
npm.cmd run agent -- --case <案件ID> --session <会话ID> --status （离线查看）
接案：npm.cmd run agent:labor -- --case <案件ID> --workflow intake
节点：npm.cmd run agent:labor -- --case <案件ID> --workflow opponent_response|new_evidence|hearing_preparation --previous-output <底稿ID>
庭前可加 --run <当前整理运行ID> 复用；可用 --profile 指定需求配置，--model-calls 设置本轮上限。
可重复 --select 材料ID=文字版本ID 和 --source-kind 材料ID=document_record。来源类型由录入人声明。
可加 --data-dir <目录>、--plugin <本地插件模块.ts>（可多次）、--attach <文件路径>（可多次）。
省略--case时输入列表序号、案件名称或完整ID选择，输错可重新选择，q退出。看到“你：”后，普通文字才是给Agent的任务。
/intake 接案；/review 节点 上一版底稿ID [当前运行ID]；/status 状态；/materials 材料；/resume 恢复；/attach 路径；/quit 退出。
Ctrl+C 中断当前执行，保留已确认的步骤；再次进入同一会话可恢复。`;

function pairs(values: readonly string[], option: string): [string, string][] {
  const result = values.map(value => {
    const [key, entry, extra] = value.split('=');
    if (!key || !entry || extra !== undefined) throw new Error(`${option} 需要“材料ID=值”。`);
    return [key, entry] as [string, string];
  });
  if (new Set(result.map(([key]) => key)).size !== result.length) throw new Error(`${option} 对同一材料只能指定一次。`);
  return result;
}

export async function runAgentCommand(args: string[]) {
  const { values } = parseArgs({ args, options: {
    case: { type: 'string' }, session: { type: 'string' }, 'data-dir': { type: 'string', default: './runtime-data' },
    once: { type: 'string' }, resume: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false }, sessions: { type: 'boolean', default: false },
    plugin: { type: 'string', multiple: true, default: [] }, attach: { type: 'string', multiple: true, default: [] },
    workflow: { type: 'string' }, profile: { type: 'string' }, 'previous-output': { type: 'string' }, run: { type: 'string' },
    select: { type: 'string', multiple: true, default: [] }, 'source-kind': { type: 'string', multiple: true, default: [] },
    'model-calls': { type: 'string' },
  } });
  if (values.help) { console.log(help); return; }
  if ([values.once !== undefined, values.workflow !== undefined, values.resume].filter(Boolean).length > 1)
    throw new Error('--once、--workflow、--resume 请选择一项。');
  const maxModelCalls = values['model-calls'] === undefined ? undefined : Number(values['model-calls']);
  if (maxModelCalls !== undefined && (!Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 200))
    throw new Error('--model-calls 须为 1 到 200 的整数。');
  const dataDir = resolve(values['data-dir']), cases = new CaseStore(dataDir);
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
  let inputClosed = false;
  rl.on('close', () => { inputClosed = true; });
  // Start one reader immediately, so input typed while startup is awaiting I/O
  // stays buffered for the picker and the following conversation alike.
  const lines = rl[Symbol.asyncIterator]();
  const prompt = (message = '你：') => {
    // Piped input can reach EOF during startup while buffered lines remain.
    // A closed readline cannot prompt, but those queued lines are still valid.
    if (inputClosed) { if (!stdin.isTTY) stdout.write(message); return; }
    rl.setPrompt(message); rl.prompt();
  };
  let controller: AbortController | undefined;
  const interrupt = () => { if (controller) controller.abort(); else rl.close(); };
  rl.on('SIGINT', interrupt); process.on('SIGINT', interrupt);
  try {
    let caseId = values.case;
    if (!caseId) {
      const list = (await cases.list({})).cases;
      if (list.length === 0) throw new Error('尚无案件，请先运行 npm.cmd run cases -- create --title 案件名称 --actor 你的称呼');
      list.forEach((item, index) => console.log(`${index + 1}. ${item.title}　${item.id}`));
      while (!caseId) {
        prompt('选择案件（序号 / 名称 / ID，q 退出）：');
        const answer = await lines.next();
        if (answer.done || /^(?:q|quit|\/quit|\/exit)$/iu.test(answer.value.trim())) return;
        const choice = answer.value.trim();
        if (!choice) { console.log('请输入列表中的数字序号、案件名称或完整ID。'); continue; }
        if (/^[1-9]\d*$/u.test(choice)) caseId = list[Number(choice) - 1]?.id;
        else {
          const exact = list.filter((item) => item.id.toLowerCase() === choice.toLowerCase() || item.title === choice);
          const matches = exact.length > 0 ? exact : list.filter((item) => item.title.toLowerCase().includes(choice.toLowerCase()));
          if (matches.length === 1) caseId = matches[0]!.id;
          else if (matches.length > 1) { console.log('名称匹配了多个案件，请输入对应的数字序号或完整ID。'); continue; }
        }
        if (!caseId) console.log('没有找到这个案件，请按上方列表重新输入，例如 1。');
      }
    } else if (!/^[0-9a-f-]{36}$/iu.test(caseId)) {
      const matches = (await cases.list({ query: caseId })).cases;
      if (matches.length !== 1) throw new Error('名称未唯一匹配案件，请使用案件ID。'); caseId = matches[0]!.id;
    }
    const selected = await cases.read(caseId), workspace = new CaseWorkspace(dataDir, cases);
    if (values.status || values.sessions) {
      const store = new ExecutionStore(dataDir);
      if (values.status) {
        if (!values.session) throw new Error('--status需要--session。');
        console.log(JSON.stringify(agentStateSchema.parse((await store.loadLatest({ caseId: selected.id, sessionId: values.session })).snapshot.payload), null, 2));
      } else console.log(JSON.stringify((await store.list(selected.id)).map((item) => agentStateSchema.parse(item.snapshot.payload)), null, 2));
      return;
    }
    const model = createDeepSeekModel(loadDeepSeekConfig());
    const extensions: LegalAgentExtension[] = [];
    for (const path of values.plugin) {
      const module = await import(pathToFileURL(resolve(path)).href);
      const extension = await (typeof module.createPlugin === 'function'
        ? module.createPlugin({ dataDir }) : module.default) as LegalAgentExtension | undefined;
      if (!extension || typeof extension.id !== 'string' || typeof extension.version !== 'string') throw new Error('插件模块须default导出带id和version的LegalAgentExtension。');
      extensions.push(extension);
    }
    const agent = await createLegalAgent({ dataDir, extensions, model,
      onEvent: (event) => { if (event.kind === 'tool' || event.kind === 'checkpoint' || event.kind === 'error') console.log(`[${event.kind}] ${event.message}`); },
    });
    let sessionId = values.session;
    let attached = [...values.attach].map((path) => resolve(path));
    const installedProfiles = extensions.flatMap(extension => extension.profiles ?? []);
    const workflowProfile = values.profile ?? (installedProfiles.length === 1 ? installedProfiles[0]!.id : COMMON_INFORMATION_PROFILE.id);
    const show = (state: AgentState) => {
      sessionId = state.id;
      const task = state.tasks.find((item) => item.id === state.activeTaskId);
      const reply = [...state.messages].reverse().find((item) => item.role === 'assistant' && item.taskId === task?.id);
      if (reply) console.log(`\nAgent：${reply.text}`);
      console.log(`\n会话 ${state.id}\n任务 ${task?.status ?? '无'}；工具 ${task?.usedSteps ?? 0}/${task?.limits.maxSteps ?? 0}；模型 ${task?.usedModelCalls ?? 0}/${task?.limits.maxModelCalls ?? 0}`);
      if (task?.error) console.log(`停止原因：${task.error}`);
      if (task?.workflow) {
        const output = state.steps.find(step => step.taskId === task.id && step.status === 'completed' && step.toolId === 'output.create');
        const result = output?.result as { nodeReview?: { kind: string; status: string; preparations: unknown[] } } | undefined;
        const node = result?.nodeReview;
        console.log('WORKFLOW_RESULT ' + JSON.stringify({ ...result,
          ...(node ? { nodeReview: { kind: node.kind, status: node.status, preparationCount: node.preparations.length } } : {}),
          sessionId: state.id, taskId: task.id, taskStatus: task.status, error: task.error ?? null, modelCalls: task.usedModelCalls }));
      }
    };
    async function perform(message?: string) {
      controller = new AbortController();
      try {
        if (message !== undefined) show(await agent.send({ caseId: selected.id, ...(sessionId ? { sessionId } : {}), message,
          allowedPaths: attached, signal: controller.signal, ...(maxModelCalls !== undefined ? { limits: { maxModelCalls } } : {}) }));
        else { if (!sessionId) throw new Error('恢复需要会话ID。'); show(await agent.resume({ caseId: selected.id, sessionId, signal: controller.signal })); }
      } finally { controller = undefined; }
    }
    async function workflow(kind: string, previousOutputId?: string, runId?: string) {
      if (runId && values['source-kind'].length) console.log('复用已保存运行的来源分类。本次只生成审查底稿，来源类型参数用于新整理。');
      const input = agentWorkflowSchema.parse({ kind, profileId: workflowProfile,
        selections: pairs(values.select, '--select').map(([materialId, versionId]) => ({ materialId, versionId })),
        ...(!runId && values['source-kind'].length ? { sourceKinds: Object.fromEntries(pairs(values['source-kind'], '--source-kind')) } : {}),
        ...(previousOutputId ? { previousOutputId } : {}), ...(runId ? { runId } : {}) });
      controller = new AbortController();
      try {
        const state = await agent.runWorkflow({ caseId: selected.id, ...(sessionId ? { sessionId } : {}), workflow: input,
          signal: controller.signal, ...(maxModelCalls !== undefined ? { limits: { maxModelCalls } } : {}) });
        show(state);
        return state.tasks.find(task => task.id === state.activeTaskId)?.status === 'completed';
      } finally { controller = undefined; }
    }
    try {
      console.log(`已打开：${selected.title}（${selected.id}）`);
      if (sessionId) show(await agent.read({ caseId: selected.id, sessionId }));
      if (values.workflow !== undefined) {
        if (!await workflow(values.workflow, values['previous-output'], values.run)) process.exitCode = 1;
        return;
      }
      if (values.once !== undefined) { await perform(values.once);
        if (sessionId && ['failed', 'interrupted'].includes((await agent.read({ caseId: selected.id, sessionId })).tasks.at(-1)!.status)) process.exitCode = 1;
        return; }
      if (values.resume) { await perform();
        if (sessionId && ['failed', 'interrupted'].includes((await agent.read({ caseId: selected.id, sessionId })).tasks.at(-1)!.status)) process.exitCode = 1;
        if (!stdin.isTTY) return; }
      console.log('已进入 Agent 对话。看到“你：”后直接输入任务；/help 查看操作，/quit 退出。');
      prompt();
      for await (const line of lines) {
        const message = line.trim(); if (!message) { prompt(); continue; }
        try {
          if (message === '/quit' || message === '/exit') break;
          if (message === '/help') console.log(help);
          else if (message === '/resume') await perform();
          else if (message === '/intake') await workflow('intake');
          else if (message.startsWith('/review ')) {
            const [kind, previousOutputId, runId, extra] = message.slice(8).trim().split(/\s+/u);
            if (!kind || !previousOutputId || extra) throw new Error('用法：/review opponent_response|new_evidence|hearing_preparation 上一版底稿ID [当前运行ID]');
            await workflow(kind, previousOutputId, runId);
          }
          else if (message === '/status') {
            if (sessionId) show(await agent.read({ caseId: selected.id, sessionId })); else console.log('尚未开始会话。');
          } else if (message === '/materials') console.log(JSON.stringify(await workspace.contents(selected.id), null, 2));
          else if (message.startsWith('/attach ')) {
            const path = resolve(message.slice(8).trim().replace(/^"|"$/gu, '')); attached.push(path); console.log(`已选择附件：${path}`);
          } else await perform(message);
        } catch (error) { console.error(error instanceof Error ? error.message : '任务失败。'); }
        prompt();
      }
      console.log('已退出法律 Agent。');
    } finally { await agent.close(); }
  } finally { process.removeListener('SIGINT', interrupt); rl.close(); }
}
if (import.meta.main) {
  try { await runAgentCommand(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Agent启动失败。'); process.exitCode = 1; }
}
