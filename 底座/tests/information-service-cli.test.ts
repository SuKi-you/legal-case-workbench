import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { loopRunSchema } from '../src/loops/contracts.ts';
import { createDeepSeekModel } from '../src/information/deepseek.ts';
import { organizeCaseInformation, type InformationPlan } from '../src/information/service.ts';
import type { InformationRecord, StructuredNeed } from '../src/information/contracts.ts';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../examples/information.ts', import.meta.url));
const project = fileURLToPath(new URL('..', import.meta.url));
const fixtureKey = 'test-only-private-fixture-key';
const text = '张三（工号E001）称：2026年9月1日流水号T001实付6000元。';
const need: StructuredNeed = {
  id: 'service.payment', question: '张三这笔款项的实付金额是多少？', reason: '核对已记载金额及出处。',
  spec: { topic: 'payment.amount', subject: 'employee_id:E001', object: null, period: '2026-09', basis: '实付',
    requiredFields: ['subject', 'event.key', 'time', 'value', 'period', 'basis'], minimumSupport: 'statement', applicable: true },
};
type Payload = { model: string; messages: Array<{ role: string; content: string }> };
type SegmentInput = { needs: StructuredNeed[]; segment: { id: string; text: string } };
function extraction(payload: Payload) {
  const user = payload.messages.find((message) => message.role === 'user');
  assert.ok(user);
  const { segment, needs } = JSON.parse(user.content) as SegmentInput;
  assert.equal(segment.text, text);
  const entity = { name: '张三', kind: 'person' as const, identity: { scheme: 'employee_id', value: 'E001' } };
  const record: InformationRecord = {
    topic: needs[0]!.spec!.topic, subject: entity, object: null, attributedTo: entity,
    event: { type: 'free-form-model-description', key: 'T001', description: '同笔款项的金额记载' },
    time: { raw: '2026年9月1日', start: '2099-01-01', end: '2099-01-01', precision: 'date' },
    value: { kind: 'money', raw: '6000元', normalized: '999999', unit: 'USD' },
    period: '2026-09', basis: '实付', polarity: 'affirmed', origin: 'party_statement', qualifiers: {}, uncertainty: [],
  };
  return { items: [{ statement: '张三称流水T001实付6000元。', record,
    quotes: [{ segmentId: segment.id, quote: segment.text, occurrence: null }] }] };
}
function modelResponse(payload: Payload) {
  const semanticReview = payload.messages.some((message) => message.role === 'system' && message.content.includes('INFORMATION_SEMANTIC_REVIEW'));
  if (!semanticReview) return extraction(payload);
  const user = payload.messages.find((message) => message.role === 'user');
  assert.ok(user);
  const input = JSON.parse(user.content) as { items: unknown[] };
  return { verdicts: input.items.map((_item, index) => ({ index, relevant: true, supported: true, rolesCorrect: true,
    polarityCorrect: true, reason: '逐条比对测试原文，与所需事项和陈述方向一致。' })) };
}
function envelope(value: unknown) {
  return { id: 'loopback-test-completion', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] };
}

async function fixture(t: TestContext, materialCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-information-cli-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const dataDir = join(directory, 'data');
  const cases = new CaseStore(dataDir);
  const workspace = new CaseWorkspace(dataDir, cases);
  const record = await cases.create({ title: '虚构服务与终端测试案', actor: '测试用户' });
  const selections: InformationPlan['selections'] = [];
  for (let index = 0; index < materialCount; index += 1) {
    const material = await workspace.registerText({ caseId: record.id, sourceLabel: `虚构记录${index + 1}`, text });
    selections.push({ materialId: material.id, versionId: material.id });
  }
  const plan: InformationPlan = { goal: '核对款项记载并保留出处', selections, needs: [structuredClone(need)] };
  const planPath = join(directory, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  return { directory, dataDir, cases, caseId: record.id, plan, planPath };
}

async function serverFor(t: TestContext, handler?: (payload: Payload, request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const calls: Payload[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/chat/completions');
      const parts: Buffer[] = [];
      for await (const chunk of request) parts.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(parts).toString('utf8')) as Payload;
      calls.push(payload);
      if (handler) await handler(payload, request, response);
      else {
        response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        response.end(JSON.stringify(envelope(modelResponse(payload))));
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { Connection: 'close' });
      response.end('test server rejected a malformed fixture');
    });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  };
  t.after(stop);
  return { calls, baseUrl: `http://127.0.0.1:${address.port}`, stop };
}

/** Do not inherit model secrets or Node startup flags from the user's environment. */
function childEnvironment(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'LANG', 'LC_ALL', 'ComSpec', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(values)) if (value !== undefined) env[name] = value;
  return env;
}
function command(args: string[], env: NodeJS.ProcessEnv) {
  return execute(process.execPath, [cli, ...args], { cwd: project, env, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
}
async function rejectedWithoutKeyLeak(run: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    const details = error as Error & { stdout?: string; stderr?: string };
    const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`;
    assert.match(output, pattern);
    assert.equal(output.includes(fixtureKey), false);
    return true;
  });
}

test('the CLI runs through a loopback DeepSeek server and show restores its result without any model configuration', async (t) => {
  const data = await fixture(t);
  const model = await serverFor(t);
  const env = childEnvironment({ DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: model.baseUrl, DEEPSEEK_MODEL: 'test-model', DEEPSEEK_TIMEOUT_MS: '3000' });
  const { stdout } = await command(['run', '--case', data.caseId, '--plan', data.planPath, '--data-dir', data.dataDir], env);
  const run = loopRunSchema.parse(JSON.parse(stdout));
  assert.equal(run.status, 'completed');
  assert.equal(run.findings.length, 1);
  assert.equal(run.findings[0]!.record?.event.type, need.spec!.topic);
  assert.equal(run.findings[0]!.record?.time.start, '2026-09-01');
  assert.equal(run.findings[0]!.record?.value.normalized, '6000');
  assert.equal(run.findings[0]!.record?.value.unit, 'CNY');
  assert.equal(run.information?.needs[0]?.satisfaction, 'satisfied');
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls[0]?.model, 'test-model');
  assert.equal(stdout.includes(fixtureKey), false);
  const before = model.calls.length;
  await model.stop();
  const shown = await command(['show', '--case', data.caseId, '--run', run.id, '--data-dir', data.dataDir], childEnvironment());
  assert.deepEqual(loopRunSchema.parse(JSON.parse(shown.stdout)), run);
  assert.equal(model.calls.length, before);
  assert.equal(shown.stdout.includes(fixtureKey), false);
});

test('source annotations outside the selected case material scope fail without calling the model or saving a run', async (t) => {
  const data = await fixture(t);
  const model = await serverFor(t);
  const plan = { ...data.plan, sourceKinds: { [randomUUID()]: 'document_record' } };
  await writeFile(data.planPath, JSON.stringify(plan));
  const before = await data.cases.read(data.caseId);
  await rejectedWithoutKeyLeak(() => command(['run', '--case', data.caseId, '--plan', data.planPath, '--data-dir', data.dataDir],
    childEnvironment({ DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: model.baseUrl, DEEPSEEK_MODEL: 'test-model' })), /INFORMATION_SCOPE_INVALID/);
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await data.cases.read(data.caseId), before);
  assert.deepEqual((await data.cases.readState(data.caseId)).workspace?.loopRuns ?? [], []);
});

test('a two-call model budget rejects a two-source run instead of committing partially checked information', async (t) => {
  const data = await fixture(t, 2);
  const model = await serverFor(t);
  await writeFile(data.planPath, JSON.stringify({ ...data.plan, maxModelCalls: 2 }));
  const before = await data.cases.read(data.caseId);
  await rejectedWithoutKeyLeak(() => command(['run', '--case', data.caseId, '--plan', data.planPath, '--data-dir', data.dataDir],
    childEnvironment({ DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: model.baseUrl, DEEPSEEK_MODEL: 'test-model' })), /INFORMATION_MODEL_BUDGET/);
  assert.equal(model.calls.length, 2);
  assert.deepEqual(await data.cases.read(data.caseId), before);
  assert.deepEqual((await data.cases.readState(data.caseId)).workspace?.loopRuns ?? [], []);
});

test('model-output repair consumes the same call budget and never saves a rejected or partial result', async (t) => {
  const data = await fixture(t);
  let callsForAttempt = 0;
  const model = await serverFor(t, (payload, _request, response) => {
    callsForAttempt += 1;
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify(envelope(callsForAttempt === 1 ? { items: 'invalid extractor output' } : modelResponse(payload))));
  });
  const env = childEnvironment({ DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: model.baseUrl, DEEPSEEK_MODEL: 'test-model' });
  const args = ['run', '--case', data.caseId, '--plan', data.planPath, '--data-dir', data.dataDir];
  const before = await data.cases.read(data.caseId);
  await writeFile(data.planPath, JSON.stringify({ ...data.plan, maxModelCalls: 1 }));
  await rejectedWithoutKeyLeak(() => command(args, env), /INFORMATION_MODEL_BUDGET/);
  assert.equal(callsForAttempt, 1);
  assert.equal(model.calls.length, 1);
  assert.deepEqual(await data.cases.read(data.caseId), before);
  assert.deepEqual((await data.cases.readState(data.caseId)).workspace?.loopRuns ?? [], []);

  callsForAttempt = 0;
  await writeFile(data.planPath, JSON.stringify({ ...data.plan, maxModelCalls: 3 }));
  const { stdout } = await command(args, env);
  const run = loopRunSchema.parse(JSON.parse(stdout));
  assert.equal(callsForAttempt, 3);
  assert.equal(model.calls.length, 4);
  assert.equal(run.status, 'completed');
  assert.equal(run.findings.length, 1);
  assert.equal(run.findings[0]!.record?.value.normalized, '6000');
  assert.equal(run.information?.needs[0]?.satisfaction, 'satisfied');
  assert.equal(stdout.includes(fixtureKey), false);
});

test('a semantic review rejection cannot be saved even when the extractor satisfies the structured contract', async (t) => {
  const data = await fixture(t);
  const model = await serverFor(t, (payload, _request, response) => {
    const result = modelResponse(payload);
    if ('verdicts' in result) {
      result.verdicts = result.verdicts.map((verdict) => ({ ...verdict, rolesCorrect: false,
        reason: '测试复核拒绝：陈述角色尚未正确对应。' }));
    }
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify(envelope(result)));
  });
  const before = await data.cases.read(data.caseId);
  await rejectedWithoutKeyLeak(() => command(['run', '--case', data.caseId, '--plan', data.planPath, '--data-dir', data.dataDir],
    childEnvironment({ DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: model.baseUrl, DEEPSEEK_MODEL: 'test-model' })), /INFORMATION_SEMANTIC_REJECTED/);
  assert.equal(model.calls.length, 4);
  assert.deepEqual(await data.cases.read(data.caseId), before);
  assert.deepEqual((await data.cases.readState(data.caseId)).workspace?.loopRuns ?? [], []);
});

test('cancelling a service call while its loopback model request is pending cannot commit a current result', { timeout: 15000 }, async (t) => {
  const data = await fixture(t);
  let markStarted!: () => void;
  const started = new Promise<void>((done) => { markStarted = done; });
  const model = await serverFor(t, async (_payload, _request, response) => {
    markStarted();
    await new Promise<void>((done) => response.once('close', done));
  });
  const controller = new AbortController();
  const before = await data.cases.read(data.caseId);
  const pending = organizeCaseInformation({ dataDir: data.dataDir, caseId: data.caseId, plan: data.plan,
    model: createDeepSeekModel({ apiKey: fixtureKey, baseUrl: model.baseUrl, model: 'test-model', timeoutMs: 4000, maxRetries: 0 }),
    signal: controller.signal });
  const rejected = assert.rejects(pending, /INFORMATION_CANCELLED|DEEPSEEK_CANCELLED/);
  await started;
  controller.abort('private caller cancellation detail');
  await rejected;
  assert.equal(model.calls.length, 1);
  assert.deepEqual(await data.cases.read(data.caseId), before);
  assert.deepEqual((await data.cases.readState(data.caseId)).workspace?.loopRuns ?? [], []);
});

test('invalid plans, missing keys and service errors fail without printing credentials or accepting a run', async (t) => {
  const data = await fixture(t);
  const model = await serverFor(t, (_payload, _request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify({ error: `Untrusted upstream body ${fixtureKey}` }));
  });
  const args = ['run', '--case', data.caseId, '--plan', data.planPath, '--data-dir', data.dataDir];
  await writeFile(data.planPath, JSON.stringify({ goal: data.plan.goal, selections: data.plan.selections, needs: [] }));
  await rejectedWithoutKeyLeak(() => command(args, childEnvironment({ DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: model.baseUrl })), /needs/);
  assert.equal(model.calls.length, 0);
  await writeFile(data.planPath, JSON.stringify(data.plan));
  await rejectedWithoutKeyLeak(() => command(args, childEnvironment({ DEEPSEEK_BASE_URL: model.baseUrl })), /DEEPSEEK_KEY_MISSING/);
  assert.equal(model.calls.length, 0);
  await rejectedWithoutKeyLeak(() => command(args, childEnvironment({ DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: model.baseUrl, DEEPSEEK_MODEL: 'test-model' })), /DEEPSEEK_HTTP_ERROR.*401/);
  assert.equal(model.calls.length, 1);
  assert.deepEqual((await data.cases.readState(data.caseId)).workspace?.loopRuns ?? [], []);
});
