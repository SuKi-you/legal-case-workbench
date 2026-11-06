import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CapabilityContext, PluginDefinition } from '../src/contracts.ts';
import { CaseStore } from '../src/cases/store.ts';
import { CaseWorkspace } from '../src/cases/workspace.ts';
import { ExecutionStore } from '../src/execution/store.ts';
import { createRuntime } from '../src/runtime.ts';
import { IntakeLoop, LoopError } from '../src/loops/engine.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import { loopCheckpointSchema, loopDeclarationSchema, loopReviewSchema, type LoopCheckpoint, type LoopSource, type LoopStartInput } from '../src/loops/contracts.ts';
import { createLoopExamplePlugins, EXAMPLE_LOOP_REFS, EXAMPLE_LOOP_TEXTS } from '../examples/loop-fixtures.ts';

const interrupted = new Error('test-only process interruption');
const code = (value: string) => (error: unknown) => error instanceof LoopError && error.code === value;
async function fixture(t: TestContext, strategy: 'follow-up' | 'read-together' = 'follow-up', maxReads = 12) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-loop-resume-'));
  const cases = new CaseStore(directory), workspace = new CaseWorkspace(directory, cases), executions = new ExecutionStore(directory, cases);
  const record = await cases.create({ title: '虚构恢复循环测试案', actor: '测试用户' }), sessionId = randomUUID();
  const sources: LoopSource[] = [];
  for (const material of Object.values(EXAMPLE_LOOP_TEXTS)) {
    const saved = await workspace.registerText({ caseId: record.id, ...material });
    const { version } = await workspace.readVersion({ caseId: record.id, materialId: saved.id, versionId: saved.id });
    sources.push({ materialId: saved.id, versionId: version.id, textSha256: version.textSha256 });
  }
  const calls = { declare: 0, read: 0, review: 0 };
  const makePlugins = (): PluginDefinition[] => createLoopExamplePlugins(strategy).map((plugin) => ({ ...plugin,
    capabilities: plugin.capabilities.map((capability) => ({ ...capability, execute: async (input, context) => {
      if (capability.id === EXAMPLE_LOOP_REFS.declare.id) calls.declare += 1;
      if (capability.id === EXAMPLE_LOOP_REFS.read.id) calls.read += 1;
      if (capability.id === EXAMPLE_LOOP_REFS.review.id) calls.review += 1;
      return capability.execute(input, context);
    } })),
  }));
  const hosts: Awaited<ReturnType<typeof createRuntime>>[] = [];
  const openHost = async (plugins = makePlugins()) => {
    const host = await createRuntime({ dataDir: directory, plugins }); hosts.push(host); return host;
  };
  t.after(async () => { for (const host of hosts) await host.stop(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const request: LoopStartInput = { caseId: record.id, goal: '保留已有陈述、按步骤恢复并继续核对', sources,
    ...EXAMPLE_LOOP_REFS, limits: { maxRounds: 4, maxReads } };
  let revision = (await cases.read(record.id)).revision;
  let snapshotId: string | null = null;
  const persist = async (checkpoint: LoopCheckpoint) => {
    const saved = await executions.save({ caseId: record.id, sessionId, expectedRevision: revision,
      previousSnapshotId: snapshotId, payload: { checkpoint: JSON.parse(JSON.stringify(checkpoint)) } });
    revision = saved.caseRevision; snapshotId = saved.snapshot.id;
  };
  const latest = async () => loopCheckpointSchema.parse((await new ExecutionStore(directory).loadLatest({ caseId: record.id, sessionId })).snapshot.payload.checkpoint);
  return { directory, cases, workspace, executions, record, request, sources, calls, makePlugins, openHost, persist, latest,
    revision: () => revision, setRevision: (next: number) => { revision = next; } };
}

test('a completed read checkpoint persists with the case and resumes on a new host without rereading it', async (t) => {
  const data = await fixture(t), firstHost = await data.openHost();
  await assert.rejects(new IntakeLoop(firstHost).run(data.request, { currentCaseRevision: data.revision, onCheckpoint: async (checkpoint) => {
    await data.persist(checkpoint);
    if (checkpoint.rounds.length === 0 && checkpoint.pendingAttempts.length === 1) throw interrupted;
  } }), (error) => error === interrupted);
  assert.deepEqual(data.calls, { declare: 1, read: 1, review: 0 });
  const saved = await data.latest(); assert.equal(saved.findings.length, 1); assert.equal(saved.pendingAttempts.length, 1);
  await firstHost.stop();
  const run = await new IntakeLoop(await data.openHost()).run(data.request, {
    resume: saved, currentCaseRevision: data.revision, onCheckpoint: data.persist,
  });
  assert.equal(run.status, 'completed'); assert.equal(run.id, saved.runId); assert.equal(run.createdAt, saved.createdAt);
  assert.deepEqual(data.calls, { declare: 1, read: 2, review: 2 });
  assert.equal(run.findings.length, 2); assert.equal(run.rounds.length, 2);
  assert.equal(run.baseCaseRevision, data.revision());
  await new LoopRunStore(data.directory).save(run);
  assert.deepEqual((await new LoopRunStore(data.directory).read({ caseId: data.record.id, runId: run.id })).findings, run.findings);
});

test('a checkpoint after professional review starts the next round without repeating the saved review', async (t) => {
  const data = await fixture(t);
  await assert.rejects(new IntakeLoop(await data.openHost()).run(data.request, { currentCaseRevision: data.revision, onCheckpoint: async (checkpoint) => {
    await data.persist(checkpoint);
    if (checkpoint.rounds.length === 1 && checkpoint.pendingAttempts.length === 0 && !checkpoint.outcome) throw interrupted;
  } }), (error) => error === interrupted);
  assert.deepEqual(data.calls, { declare: 1, read: 1, review: 1 });
  const run = await new IntakeLoop(await data.openHost()).run(data.request, { resume: await data.latest(),
    currentCaseRevision: data.revision, onCheckpoint: data.persist });
  assert.equal(run.status, 'completed'); assert.deepEqual(data.calls, { declare: 1, read: 2, review: 2 });
  assert.deepEqual(run.rounds.map((round) => round.number), [1, 2]);
});

test('resuming inside a multi-read round keeps its first read and completes only the remaining requests', async (t) => {
  const data = await fixture(t);
  const plugins = () => data.makePlugins().map((plugin) => ({ ...plugin, capabilities: plugin.capabilities.map((capability) =>
    capability.id !== EXAMPLE_LOOP_REFS.declare.id ? capability : { ...capability, execute: async (input: unknown, context: CapabilityContext) => {
      const original = await capability.execute(input, context);
      if (original.status !== 'success') return original;
      const declaration = loopDeclarationSchema.parse(original.data), notice = declaration.requests[0]!;
      return { status: 'success' as const, data: { ...declaration, requests: [
        { ...notice, sources: [data.sources[0]!] },
        { ...notice, instruction: '读取补充陈述中的后续工作安排说法，保留否定表达。', sources: [data.sources[1]!] },
      ] } };
    } }),
  }));
  await assert.rejects(new IntakeLoop(await data.openHost(plugins())).run(data.request, { currentCaseRevision: data.revision,
    onCheckpoint: async (checkpoint) => { await data.persist(checkpoint); if (checkpoint.pendingAttempts.length === 1) throw interrupted; },
  }), (error) => error === interrupted);
  const saved = await data.latest(); assert.equal(saved.requests.length, 2); assert.equal(saved.pendingAttempts.length, 1);
  const run = await new IntakeLoop(await data.openHost(plugins())).run(data.request, { resume: saved,
    currentCaseRevision: data.revision, onCheckpoint: data.persist });
  assert.equal(run.status, 'completed'); assert.equal(run.rounds.length, 1); assert.equal(run.rounds[0]!.attempts.length, 2);
  assert.deepEqual(data.calls, { declare: 1, read: 2, review: 1 });
  assert.equal(new Set(run.rounds[0]!.attempts.flatMap((attempt) => attempt.findingIds)).size, 2);
});

test('a completed outcome checkpoint reloads its result without additional declaration, reading or review calls', async (t) => {
  const data = await fixture(t, 'read-together');
  await assert.rejects(new IntakeLoop(await data.openHost()).run(data.request, { currentCaseRevision: data.revision, onCheckpoint: async (checkpoint) => {
    await data.persist(checkpoint); if (checkpoint.outcome) throw interrupted;
  } }), (error) => error === interrupted);
  const saved = await data.latest(); assert.equal(saved.outcome?.status, 'completed');
  const before = structuredClone(data.calls);
  const run = await new IntakeLoop(await data.openHost()).run(data.request, { resume: saved, currentCaseRevision: data.revision });
  assert.equal(run.status, 'completed'); assert.deepEqual(data.calls, before); assert.equal(run.id, saved.runId);
});

test('a genuine stalled outcome resumes without repeating already completed work', async (t) => {
  const data = await fixture(t);
  const plugins = () => data.makePlugins().map((plugin) => ({ ...plugin, capabilities: plugin.capabilities.map((capability) =>
    capability.id !== EXAMPLE_LOOP_REFS.review.id ? capability : { ...capability, execute: async (input: unknown, context: CapabilityContext) => {
      const original = await capability.execute(input, context);
      if (original.status !== 'success') return original;
      const review = loopReviewSchema.parse(original.data);
      const request = (input as { attempts: Array<{ request: unknown }> }).attempts[0]!.request;
      return { status: 'success' as const, data: { ...review, nextRequests: [request] } };
    } }),
  }));
  await assert.rejects(new IntakeLoop(await data.openHost(plugins())).run(data.request, { currentCaseRevision: data.revision,
    onCheckpoint: async (checkpoint) => { await data.persist(checkpoint); if (checkpoint.outcome) throw interrupted; },
  }), (error) => error === interrupted);
  const saved = await data.latest(); assert.equal(saved.outcome?.status, 'stalled');
  const before = structuredClone(data.calls);
  const run = await new IntakeLoop(await data.openHost(plugins())).run(data.request, { resume: saved, currentCaseRevision: data.revision });
  assert.equal(run.status, 'stalled'); assert.deepEqual(data.calls, before);
});

test('cancellation preserves the last completed read and restarting does not reset its read budget', async (t) => {
  const data = await fixture(t, 'follow-up', 1), controller = new AbortController();
  await assert.rejects(new IntakeLoop(await data.openHost()).run(data.request, { signal: controller.signal,
    currentCaseRevision: data.revision, onCheckpoint: async (checkpoint) => {
      await data.persist(checkpoint); if (checkpoint.pendingAttempts.length === 1) controller.abort('test interruption');
    } }), code('LOOP_CANCELLED'));
  assert.deepEqual(data.calls, { declare: 1, read: 1, review: 0 });
  const run = await new IntakeLoop(await data.openHost()).run(data.request, { resume: await data.latest(),
    currentCaseRevision: data.revision, onCheckpoint: data.persist });
  assert.equal(run.status, 'limit_reached'); assert.equal(data.calls.read, 1); assert.equal(data.calls.review, 1);
  assert.equal(run.rounds.flatMap((round) => round.attempts).length, 1);
});

test('changed goal, selected sources, budgets or provider versions cannot reuse a checkpoint', async (t) => {
  const data = await fixture(t);
  await assert.rejects(new IntakeLoop(await data.openHost()).run(data.request, { currentCaseRevision: data.revision, onCheckpoint: async (checkpoint) => {
    await data.persist(checkpoint); throw interrupted;
  } }), (error) => error === interrupted);
  const saved = await data.latest();
  for (const input of [
    { ...data.request, goal: '另一个任务' },
    { ...data.request, sources: data.sources.slice(0, 1) },
    { ...data.request, limits: { maxRounds: 4, maxReads: 10 } },
  ]) await assert.rejects(new IntakeLoop(await data.openHost()).run(input, { resume: saved, currentCaseRevision: data.revision }), code('LOOP_RESUME_CHANGED'));
  const changed = data.makePlugins().map((plugin) => plugin.manifest.id === 'example.intake-reader-test'
    ? { ...plugin, manifest: { ...plugin.manifest, version: 'new-prompt-version' } } : plugin);
  await assert.rejects(new IntakeLoop(await data.openHost(changed)).run(data.request, { resume: saved, currentCaseRevision: data.revision }), code('LOOP_RESUME_CHANGED'));
  assert.deepEqual(data.calls, { declare: 1, read: 0, review: 0 });
});

test('source bytes changed outside the managed API are rejected before resumed work executes', async (t) => {
  const data = await fixture(t);
  await assert.rejects(new IntakeLoop(await data.openHost()).run(data.request, { currentCaseRevision: data.revision, onCheckpoint: async (checkpoint) => {
    await data.persist(checkpoint); throw interrupted;
  } }), (error) => error === interrupted);
  const saved = await data.latest();
  const material = await data.workspace.readMaterial({ caseId: data.record.id, materialId: data.sources[0]!.materialId });
  await writeFile(material.originalPath, '被外部改写的原文');
  await assert.rejects(new IntakeLoop(await data.openHost()).run(data.request, { resume: saved, currentCaseRevision: data.revision }),
    (error) => error instanceof LoopError && ['LOOP_CAPABILITY_FAILED', 'LOOP_SOURCE_CHANGED'].includes(error.code));
  assert.deepEqual(data.calls, { declare: 1, read: 0, review: 0 });
});

test('resumed trace rejects repeated or unbacked work and cannot forge a completed outcome', async (t) => {
  const data = await fixture(t);
  await assert.rejects(new IntakeLoop(await data.openHost()).run(data.request, { currentCaseRevision: data.revision, onCheckpoint: async (checkpoint) => {
    await data.persist(checkpoint); if (checkpoint.pendingAttempts.length === 1) throw interrupted;
  } }), (error) => error === interrupted);
  const saved = await data.latest();
  const mutations: Array<{ name: string; change: (checkpoint: LoopCheckpoint) => void }> = [
    { name: 'duplicate pending read', change: (checkpoint) => { checkpoint.pendingAttempts.push(structuredClone(checkpoint.pendingAttempts[0]!)); } },
    { name: 'undeclared finding topic', change: (checkpoint) => { checkpoint.findings[0]!.needId = 'foreign.need'; } },
    { name: 'orphaned finding', change: (checkpoint) => { checkpoint.pendingAttempts[0]!.findingIds = []; } },
    { name: 'unexamined citation', change: (checkpoint) => { checkpoint.pendingAttempts[0]!.examined = []; } },
    { name: 'completed without review', change: (checkpoint) => { checkpoint.outcome = { status: 'completed', reason: '伪造完成' }; } },
    { name: 'stalled with unfinished reads', change: (checkpoint) => { checkpoint.outcome = { status: 'stalled', reason: '伪造停滞' }; } },
  ];
  for (const item of mutations) await t.test(item.name, async () => {
    const checkpoint = structuredClone(saved); item.change(checkpoint);
    await assert.rejects(new IntakeLoop(await data.openHost()).run(data.request, { resume: checkpoint, currentCaseRevision: data.revision }), code('LOOP_RESUME_INVALID'));
  });
  const malformed = { ...saved, pendingAttempts: 'invalid' } as unknown as LoopCheckpoint;
  await assert.rejects(new IntakeLoop(await data.openHost()).run(data.request, { resume: malformed, currentCaseRevision: data.revision }));
  assert.deepEqual(data.calls, { declare: 1, read: 1, review: 0 });
});
