import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { ExecutionStore } from '../src/execution/store.ts';
import { agentStateSchema } from '../src/agent/contracts.ts';

const execute = promisify(execFile), cli = fileURLToPath(new URL('../examples/agent.ts', import.meta.url));
const project = fileURLToPath(new URL('..', import.meta.url));
const fixtureKey = 'only-loopback-agent-cli-key';
type WirePayload = { messages: { role: string; content: string }[] };
type PlannerPayload = { task: { id: string; goal: string }; observations: { stepId: string; taskId: string; toolId: string; result: unknown }[]; tools: { id: string }[] };
const outcome = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-terminal-cli-')), dataDir = join(directory, 'data');
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const cases = new CaseStore(dataDir), workspace = new CaseWorkspace(dataDir, cases);
  const record = await cases.create({ title: '终端虚构案件', actor: '自动验收' });
  await workspace.registerText({ caseId: record.id, sourceLabel: '虚构原话', text: '主管口头说让我别来了。' });
  return { directory, dataDir, caseId: record.id };
}
async function serverFor(t: TestContext, planner?: (value: PlannerPayload) => unknown) {
  const calls: WirePayload[] = [];
  const server = createServer((request, response: ServerResponse) => {
    void (async () => {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WirePayload; calls.push(payload);
      const system = payload.messages.find((item) => item.role === 'system')!.content;
      const user = JSON.parse(payload.messages.find((item) => item.role === 'user')!.content) as PlannerPayload;
      let value: unknown;
      if (system.includes('LEGAL_AGENT_REPLY_REVIEW')) value = { supported: true, necessary: true, reason: '只对本地确定性夹具核查机制' };
      else {
        assert.match(system, /LEGAL_AGENT_ACTION/);
        if (planner) value = planner(user);
        else {
          const observations = user.observations.filter((item) => item.taskId === user.task.id);
          value = observations.length > 0 ? { kind: 'reply', message: '已读取当前案件资料。', evidenceStepIds: observations.map((item) => item.stepId) }
            : { kind: 'tool', toolId: user.task.goal.includes('材料') ? 'case.materials' : 'case.overview', toolVersion: 1, arguments: {}, reason: '查看实际存储的案件信息' };
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(JSON.stringify(outcome(value)));
    })().catch(() => { if (!response.headersSent) response.writeHead(500, { Connection: 'close' }); response.end('fixture request failed'); });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); };
  t.after(stop); return { calls, baseUrl: `http://127.0.0.1:${address.port}`, stop };
}
/** A whitelist deliberately excludes the user's keys, .env files and Node startup flags. */
function environment(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'LANG', 'LC_ALL', 'ComSpec', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...values };
}
function command(args: string[], env = environment()) {
  return execute(process.execPath, [cli, ...args], { cwd: project, env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
}
function modelEnvironment(baseUrl: string) {
  return environment({ DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: baseUrl, DEEPSEEK_MODEL: 'local-agent-fixture', DEEPSEEK_TIMEOUT_MS: '3000' });
}
function interactive(args: string[], input: string, env = environment()): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI input did not finish within 20 seconds.\n${stdout}\n${stderr}`)); }, 20000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    child.stderr.on('data', (text: string) => { stderr += text; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') { clearTimeout(timer); child.kill(); reject(error); } });
    // Deliver all lines before startup has completed. The picker and following
    // conversation must share one buffered reader instead of losing later lines.
    child.stdin.end(input);
  });
}
async function rejected(command_: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(command_, (error: unknown) => {
    assert.ok(error instanceof Error); const detail = error as Error & { stdout?: string; stderr?: string; code?: number };
    assert.notEqual(detail.code, 0); const output = `${detail.stdout ?? ''}\n${detail.stderr ?? ''}`;
    assert.match(output, pattern); assert.equal(output.includes(fixtureKey), false); return true;
  });
}

test('agent CLI executes two real tool turns across processes and reads status and sessions fully offline', async (t) => {
  const f = await fixture(t), server = await serverFor(t), env = modelEnvironment(server.baseUrl);
  const first = await command(['--case', f.caseId, '--once', '请查看案件概况', '--data-dir', f.dataDir], env);
  assert.match(first.stdout, /case\.overview/); assert.match(first.stdout, /任务 completed/);
  const stored = (await new ExecutionStore(f.dataDir).list(f.caseId))[0]!;
  const state = agentStateSchema.parse(stored.snapshot.payload);
  const second = await command(['--case', f.caseId, '--session', state.id, '--once', '再列出材料', '--data-dir', f.dataDir], env);
  assert.match(second.stdout, /case\.materials/); assert.match(second.stdout, /任务 completed/); assert.equal(server.calls.length, 6);
  await server.stop();
  const status = await command(['--case', f.caseId, '--session', state.id, '--status', '--data-dir', f.dataDir]);
  const restored = agentStateSchema.parse(JSON.parse(status.stdout));
  assert.equal(restored.tasks.length, 2); assert.deepEqual(restored.steps.map((item) => item.toolId), ['case.overview', 'case.materials']);
  assert.equal(restored.messages.filter((item) => item.role === 'assistant').length, 2);
  const sessions = await command(['--case', f.caseId, '--sessions', '--data-dir', f.dataDir]);
  const listed = agentStateSchema.array().parse(JSON.parse(sessions.stdout)); assert.equal(listed.length, 1); assert.equal(listed[0]!.id, state.id);
});

test('CLI help and input errors work without loading model configuration', async (t) => {
  const f = await fixture(t);
  assert.match((await command(['--help'])).stdout, /法律 Agent 终端/);
  await rejected(command(['--definitely-not-an-option']), /Unknown option|unknown option/u);
  await rejected(command(['--case', f.caseId, '--status', '--data-dir', f.dataDir]), /--status需要--session/);
  await rejected(command(['--case', f.caseId, '--once', '查看资料', '--data-dir', f.dataDir]), /DEEPSEEK_KEY_MISSING/);
  assert.equal((await new ExecutionStore(f.dataDir).list(f.caseId)).length, 0);
});

test('an invalid model-selected tool fails the one-shot command without claiming a successful task', async (t) => {
  const f = await fixture(t), server = await serverFor(t, () => ({ kind: 'tool', toolId: 'invented.tool', toolVersion: 1, arguments: {}, reason: '错误夹具' }));
  await rejected(command(['--case', f.caseId, '--once', '执行任务', '--data-dir', f.dataDir], modelEnvironment(server.baseUrl)), /TOOL_NOT_FOUND/);
  assert.equal(server.calls.length, 1);
  const state = agentStateSchema.parse((await new ExecutionStore(f.dataDir).list(f.caseId))[0]!.snapshot.payload);
  assert.equal(state.tasks[0]!.status, 'failed'); assert.equal(state.steps.length, 0);
  await rejected(command(['--case', f.caseId, '--session', state.id, '--resume', '--data-dir', f.dataDir], modelEnvironment(server.baseUrl)), /TOOL_NOT_FOUND/);
  assert.equal(server.calls.length, 2);
});

test('explicit local plugin modules contribute tools to the same CLI executor', async (t) => {
  const f = await fixture(t), modulePath = join(f.directory, 'local-plugin.mjs');
  await writeFile(modulePath, `export default { id: 'test.cli-extension', version: '1', tools: [{
    id: 'plugin.snapshot', version: 1, description: '本地插件读取案例', effect: 'read', inputSchema: { type: 'object' },
    input: { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } },
    execute: async (_, context) => ({ boundCaseId: context.caseId, marker: 'actual-plugin-result' })
  }] };`, 'utf8');
  const server = await serverFor(t, (input) => {
    assert.ok(input.tools.some((tool) => tool.id === 'plugin.snapshot'));
    const observation = input.observations.find((item) => item.taskId === input.task.id && item.toolId === 'plugin.snapshot');
    return observation ? { kind: 'reply', message: '已使用本地插件读取。', evidenceStepIds: [observation.stepId] }
      : { kind: 'tool', toolId: 'plugin.snapshot', toolVersion: 1, arguments: {}, reason: '调用已安装的插件能力' };
  });
  await command(['--case', f.caseId, '--once', '请使用插件读取', '--plugin', modulePath, '--data-dir', f.dataDir], modelEnvironment(server.baseUrl));
  const state = agentStateSchema.parse((await new ExecutionStore(f.dataDir).list(f.caseId))[0]!.snapshot.payload);
  assert.equal(state.tasks[0]!.status, 'completed'); assert.deepEqual(state.steps[0]!.result, { boundCaseId: f.caseId, marker: 'actual-plugin-result' });
});

test('invalid case choices stay in the picker and buffered conversation input survives selection', async (t) => {
  const f = await fixture(t), server = await serverFor(t);
  const result = await interactive(['--data-dir', f.dataDir], 'A\n选择A\n1\n/status\n/quit\n', modelEnvironment(server.baseUrl));
  assert.equal(result.code, 0, result.stderr);
  assert.equal((result.stdout.match(/选择案件（序号 \/ 名称 \/ ID，q 退出）：/gu) ?? []).length, 3);
  assert.equal((result.stdout.match(/没有找到这个案件/gu) ?? []).length, 2);
  assert.match(result.stdout, /已打开：终端虚构案件/u);
  assert.match(result.stdout, /尚未开始会话/u);
  assert.equal(result.stderr, ''); assert.equal(server.calls.length, 0);
  assert.equal((await new ExecutionStore(f.dataDir).list(f.caseId)).length, 0);
});

test('case picker accepts a unique title or full case ID without model calls', async (t) => {
  const f = await fixture(t), server = await serverFor(t);
  for (const choice of ['终端虚构案件', f.caseId]) {
    const result = await interactive(['--data-dir', f.dataDir], `${choice}\n/status\n/quit\n`, modelEnvironment(server.baseUrl));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /已打开：终端虚构案件/u);
    assert.match(result.stdout, /尚未开始会话/u);
  }
  assert.equal(server.calls.length, 0);
});

test('ambiguous names re-prompt and picker quit or EOF exit before model configuration', async (t) => {
  const f = await fixture(t);
  await new CaseStore(f.dataDir).create({ title: '终端虚构案件补充', actor: '自动验收' });
  const ambiguous = await interactive(['--data-dir', f.dataDir], '终端\nq\n');
  assert.equal(ambiguous.code, 0, ambiguous.stderr);
  assert.match(ambiguous.stdout, /名称匹配了多个案件/u);
  assert.doesNotMatch(ambiguous.stderr, /DEEPSEEK_KEY_MISSING/u);
  const eof = await interactive(['--data-dir', f.dataDir], '');
  assert.equal(eof.code, 0, eof.stderr);
  assert.doesNotMatch(eof.stderr, /DEEPSEEK_KEY_MISSING/u);
  assert.equal((await new ExecutionStore(f.dataDir).list(f.caseId)).length, 0);
});
