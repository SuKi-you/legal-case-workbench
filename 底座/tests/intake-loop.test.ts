import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import {
  CASE_CAPABILITIES, caseRecordSchema, createRuntime, defineCapability, materialSchema,
  textVersionViewSchema, type CapabilityRef, type PluginDefinition, type PluginHost,
} from '../src/index.ts';
import { IntakeLoop, LoopError } from '../src/loops/engine.ts';
import {
  loopDeclarationInputSchema, loopDeclarationSchema, loopReadingInputSchema, loopReadingSchema,
  loopReviewInputSchema, loopReviewSchema, loopRunSchema,
  type LoopSource, type LoopStartInput,
} from '../src/loops/contracts.ts';

const refs = {
  declare: { id: 'loop-test.declare', version: 1 },
  read: { id: 'loop-test.read', version: 1 },
  review: { id: 'loop-test.review', version: 1 },
} as const;
const need = { id: 'test.notice', question: '材料怎样记载口头通知？', reason: '保留当事人已提供的陈述与出处。' };
const readRequest = { needId: need.id, instruction: '核对 口头通知', reason: '读取材料中的原话。' };
type DeclarationInput = z.infer<typeof loopDeclarationInputSchema>;
type Declaration = z.infer<typeof loopDeclarationSchema>;
type ReadingInput = z.infer<typeof loopReadingInputSchema>;
type Reading = z.infer<typeof loopReadingSchema>;
type ReviewInput = z.infer<typeof loopReviewInputSchema>;
type Review = z.infer<typeof loopReviewSchema>;
type Handlers = {
  declare?: (input: DeclarationInput) => Declaration | Promise<Declaration>;
  read?: (input: ReadingInput) => Reading | Promise<Reading>;
  review?: (input: ReviewInput) => Review | Promise<Review>;
};

function reading(input: ReadingInput): Reading {
  const document = input.documents[0]!;
  const quote = document.text.split('。')[0]!;
  return {
    examined: [{ materialId: document.materialId, versionId: document.versionId, textSha256: document.textSha256 }],
    candidates: [{ statement: `当事人陈述：${quote}`, citations: [{
      materialId: document.materialId, versionId: document.versionId, textSha256: document.textSha256,
      start: 0, end: quote.length, quote,
    }] }],
    note: '确定性测试读取器，只核对摘录，不作法律判断。',
  };
}
function satisfied(input: ReviewInput): Review {
  return { assessments: input.needs.map((item) => ({ needId: item.id, status: 'satisfied',
    findingIds: input.findings.map((finding) => finding.id), reason: '需求所需的原文记载已找到。' })), nextRequests: [] };
}
function unresolved(input: ReviewInput, instruction: string): Review {
  return { assessments: input.needs.map((item) => ({ needId: item.id, status: 'unresolved',
    findingIds: input.findings.map((finding) => finding.id), reason: '还有明确的问题需要补查。' })),
  nextRequests: [{ ...readRequest, instruction, reason: '补查理由，不改变需求本身。' }] };
}
async function call(host: PluginHost, ref: CapabilityRef, input: unknown): Promise<unknown> {
  const result = await host.invoke(ref, input);
  if (result.status !== 'success') assert.fail(JSON.stringify(result));
  return result.data;
}
async function fixture(t: TestContext, handlers: Handlers = {}, sourceText = '上周主管口头说让我别来了。此后公司没有安排工作。😀', extraPlugins: PluginDefinition[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), 'law-agent-loop-engine-'));
  const calls = { declare: [] as DeclarationInput[], read: [] as ReadingInput[], review: [] as ReviewInput[] };
  const host = await createRuntime({ dataDir, plugins: [{
    manifest: { id: 'loop-test.provider', version: 'test-1', apiVersion: 1 },
    capabilities: [
      defineCapability({ ...refs.declare, input: loopDeclarationInputSchema, output: loopDeclarationSchema,
        execute: async (input) => {
          calls.declare.push(structuredClone(input));
          return { status: 'success', data: await (handlers.declare?.(input) ?? { needs: [need], requests: [readRequest] }) };
        } }),
      defineCapability({ ...refs.read, input: loopReadingInputSchema, output: loopReadingSchema,
        execute: async (input) => {
          calls.read.push(structuredClone(input));
          return { status: 'success', data: await (handlers.read?.(input) ?? reading(input)) };
        } }),
      defineCapability({ ...refs.review, input: loopReviewInputSchema, output: loopReviewSchema,
        execute: async (input) => {
          calls.review.push(structuredClone(input));
          return { status: 'success', data: await (handlers.review?.(input) ?? satisfied(input)) };
        } }),
    ],
  }, ...extraPlugins] });
  t.after(async () => {
    await host.stop();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const record = caseRecordSchema.parse(await call(host, CASE_CAPABILITIES.create, { title: '虚构循环测试案', actor: '测试用户' }));
  const material = materialSchema.parse(await call(host, CASE_CAPABILITIES.registerText, {
    caseId: record.id, sourceLabel: '虚构当事人陈述', text: sourceText,
  }));
  const view = textVersionViewSchema.parse(await call(host, CASE_CAPABILITIES.readVersion, {
    caseId: record.id, materialId: material.id, versionId: material.id,
  }));
  const source: LoopSource = { materialId: material.id, versionId: material.id, textSha256: view.version.textSha256 };
  const input: LoopStartInput = { caseId: record.id, goal: '整理材料中已经提供的信息', sources: [source], ...refs };
  const engine = new IntakeLoop(host);
  return { dataDir, host, record, source, input, engine, calls, view };
}
const errorCode = (code: string) => (error: unknown) => error instanceof LoopError && error.code === code;

test('the intake loop freezes selected inputs, preserves provenance and stops when its needs are satisfied', async (t) => {
  const { host, record, source, input, engine, calls } = await fixture(t);
  const before = caseRecordSchema.parse(await call(host, CASE_CAPABILITIES.read, { caseId: record.id }));
  const run = loopRunSchema.parse(await engine.run(input));
  assert.equal(run.status, 'completed');
  assert.equal(run.baseCaseRevision, before.revision);
  assert.equal(run.rounds.length, 1);
  assert.equal(calls.declare.length, 1);
  assert.equal(calls.read.length, 1);
  assert.equal(calls.review.length, 1);
  assert.deepEqual(run.sources, [source]);
  assert.deepEqual(run.findings[0]?.citations[0], { ...source, start: 0, end: '上周主管口头说让我别来了'.length, quote: '上周主管口头说让我别来了' });
  assert.match(run.findings[0]!.statement, /当事人陈述/);
  assert.equal(run.providers.read.pluginId, 'loop-test.provider');
  assert.equal(run.providers.review.pluginVersion, 'test-1');
  assert.deepEqual(run.providers.declare.capability, refs.declare);
  assert.deepEqual(caseRecordSchema.parse(await call(host, CASE_CAPABILITIES.read, { caseId: record.id })), before,
    'Producing a loop result must not silently change materials or case progress.');
});

test('professional feedback schedules a second distinct read and identical evidence is retained only once', async (t) => {
  const { input, engine, calls } = await fixture(t, {
    review: (data) => data.round === 1 ? unresolved(data, '对照补充材料再次核对') : satisfied(data),
  });
  const run = await engine.run(input);
  assert.equal(run.status, 'completed');
  assert.equal(run.rounds.length, 2);
  assert.equal(calls.read.length, 2);
  assert.equal(calls.read[1]?.findings.length, 1);
  assert.equal(run.findings.length, 1);
  assert.deepEqual(run.rounds[0]?.attempts[0]?.findingIds, run.rounds[1]?.attempts[0]?.findingIds);
  assert.equal(run.rounds[1]?.attempts[0]?.request.reason, '补查理由，不改变需求本身。');
});

test('the same loop can switch to another reader provider through capability configuration alone', async (t) => {
  const alternateRef = { id: 'loop-test.alternate-read', version: 1 };
  let alternateReads = 0;
  const { input, engine, calls } = await fixture(t, {}, undefined, [{
    manifest: { id: 'loop-test.another-reader', version: 'reader-2', apiVersion: 1 },
    capabilities: [defineCapability({ ...alternateRef, input: loopReadingInputSchema, output: loopReadingSchema,
      execute: (data) => {
        alternateReads += 1;
        const result = reading(data);
        result.candidates[0]!.statement = `另一读取实现摘录：${result.candidates[0]!.citations[0]!.quote}`;
        return { status: 'success', data: result };
      } })],
  }]);
  const first = await engine.run(input);
  const second = await engine.run({ ...input, read: alternateRef });
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(calls.read.length, 1);
  assert.equal(alternateReads, 1);
  assert.equal(first.providers.read.pluginId, 'loop-test.provider');
  assert.equal(second.providers.read.pluginId, 'loop-test.another-reader');
  assert.equal(second.providers.read.pluginVersion, 'reader-2');
  assert.deepEqual(second.findings[0]?.citations, first.findings[0]?.citations);
});

test('a repeated read with only whitespace and reason changes stops as stalled instead of looping', async (t) => {
  const { input, engine, calls } = await fixture(t, {
    review: (data) => unresolved(data, '\n 核对   口头通知\t'),
  });
  const run = await engine.run(input);
  assert.equal(run.status, 'stalled');
  assert.equal(run.rounds.length, 1);
  assert.equal(calls.read.length, 1);
  assert.equal(calls.review.length, 1);
});

test('an unresolved review without a further reading task returns needs_review with its findings intact', async (t) => {
  const { input, engine, calls } = await fixture(t, {
    review: (data) => ({ ...unresolved(data, 'unused'), nextRequests: [] }),
  });
  const run = await engine.run(input);
  assert.equal(run.status, 'needs_review');
  assert.equal(run.findings.length, 1);
  assert.equal(calls.read.length, 1);
});

test('round and reading budgets both stop new work while retaining the professional review', async (t) => {
  for (const limits of [{ maxRounds: 2, maxReads: 10 }, { maxRounds: 10, maxReads: 1 }]) {
    await t.test(JSON.stringify(limits), async (child) => {
      const { input, engine, calls } = await fixture(child, {
        review: (data) => unresolved(data, `补查第${data.round + 1}轮`),
      });
      const run = await engine.run({ ...input, limits });
      assert.equal(run.status, 'limit_reached');
      assert.equal(calls.read.length, Math.min(limits.maxRounds, limits.maxReads));
      assert.equal(calls.review.length, calls.read.length);
      assert.equal(run.rounds.length, calls.review.length);
      assert.equal(run.rounds.at(-1)?.review.assessments[0]?.status, 'unresolved');
    });
  }
});

test('duplicate initial read instructions execute only once within the first round', async (t) => {
  const { input, engine, calls } = await fixture(t, {
    declare: () => ({ needs: [need], requests: [readRequest, { ...readRequest, instruction: '核对   口头通知', reason: '重复请求的新备注' }] }),
  });
  assert.equal((await engine.run(input)).status, 'completed');
  assert.equal(calls.read.length, 1);
});

test('an explicitly selected old text branch remains selected when a later revision exists', async (t) => {
  const { input, engine, host, record, source, calls } = await fixture(t);
  await call(host, CASE_CAPABILITIES.saveRevision, { caseId: record.id, materialId: source.materialId,
    baseVersionId: source.versionId, baseTextSha256: source.textSha256, text: '后来人工修订的另一分支。', editor: '测试用户' });
  const run = await engine.run(input);
  assert.equal(run.sources[0]?.versionId, source.versionId);
  assert.match(calls.read[0]!.documents[0]!.text, /上周主管口头说/);
  assert.doesNotMatch(run.findings[0]!.statement, /后来人工修订/);
});

test('wrong selected checksums and another case material are rejected before plugins receive documents', async (t) => {
  const { input, engine, host, calls } = await fixture(t);
  await assert.rejects(engine.run({ ...input, sources: [{ ...input.sources[0]!, textSha256: '0'.repeat(64) }] }), errorCode('LOOP_SOURCE_CHANGED'));
  const other = caseRecordSchema.parse(await call(host, CASE_CAPABILITIES.create, { title: '另一虚构案件', actor: '测试用户' }));
  const foreign = materialSchema.parse(await call(host, CASE_CAPABILITIES.registerText, { caseId: other.id, sourceLabel: '不属于本案', text: '其它案件材料。' }));
  await assert.rejects(engine.run({ ...input, sources: [{ materialId: foreign.id, versionId: foreign.id, textSha256: foreign.sha256 }] }), /MATERIAL_NOT_FOUND/);
  assert.equal(calls.declare.length, 0);
  assert.equal(calls.read.length, 0);
});

test('invalid quotation provenance is rejected before the professional reviewer sees it', async (t) => {
  const changes: { name: string; change: (result: Reading) => void }[] = [
    { name: 'invented quote', change: (result) => { result.candidates[0]!.citations[0]!.quote = '原文没有这句话'; } },
    { name: 'wrong range', change: (result) => { result.candidates[0]!.citations[0]!.start = 1; } },
    { name: 'wrong version hash', change: (result) => { result.candidates[0]!.citations[0]!.textSha256 = '1'.repeat(64); } },
    { name: 'unexamined source', change: (result) => { result.examined = []; } },
  ];
  for (const modification of changes) await t.test(modification.name, async (child) => {
    const { input, engine, calls } = await fixture(child, {
      read: (data) => { const result = reading(data); modification.change(result); return result; },
    });
    await assert.rejects(engine.run(input), errorCode('LOOP_CITATION_INVALID'));
    assert.equal(calls.review.length, 0);
  });
});

test('a reader cannot report examining unselected documents even without producing findings', async (t) => {
  const { input, engine } = await fixture(t, { read: () => ({
    examined: [{ materialId: randomUUID(), versionId: randomUUID(), textSha256: 'a'.repeat(64) }],
    candidates: [], note: '伪造的读取范围必须被拒绝。',
  }) });
  await assert.rejects(engine.run(input), errorCode('LOOP_PROTOCOL_INVALID'));
});

test('unread documents and empty candidates cannot be declared satisfied without a finding', async (t) => {
  const { input, engine } = await fixture(t, {
    read: () => ({ examined: [], candidates: [], note: '这次没有读取任何资料。' }),
    review: (data) => ({ assessments: data.needs.map((item) => ({ needId: item.id, status: 'satisfied', findingIds: [], reason: '无依据的满足必须拒绝。' })), nextRequests: [] }),
  });
  await assert.rejects(engine.run(input), errorCode('LOOP_PROTOCOL_INVALID'));
});

test('declarations and reviews cannot introduce duplicate needs, unknown needs or invented findings', async (t) => {
  const scenarios: { name: string; handlers: Handlers }[] = [
    { name: 'duplicate declared needs', handlers: { declare: () => ({ needs: [need, need], requests: [readRequest] }) } },
    { name: 'request for an unknown need', handlers: { declare: () => ({ needs: [need], requests: [{ ...readRequest, needId: 'undeclared' }] }) } },
    { name: 'review of unknown need', handlers: { review: (data) => {
      const result = satisfied(data); result.assessments[0]!.needId = 'undeclared'; return result;
    } } },
    { name: 'invented finding ID', handlers: { review: (data) => {
      const result = satisfied(data); result.assessments[0]!.findingIds = [randomUUID()]; return result;
    } } },
    { name: 'completed review also requests more reading', handlers: { review: (data) => ({ ...satisfied(data), nextRequests: [readRequest] }) } },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async (child) => {
    const { input, engine } = await fixture(child, scenario.handlers);
    await assert.rejects(engine.run(input), errorCode('LOOP_PROTOCOL_INVALID'));
  });
});

test('a review must assess every declared need rather than silently omit one', async (t) => {
  const { input, engine } = await fixture(t, {
    declare: () => ({ needs: [need, { ...need, id: 'test.follow-up', question: '之后是否还有安排？' }], requests: [readRequest] }),
    review: (data) => ({ assessments: [{ needId: need.id, status: 'satisfied', findingIds: data.findings.map((item) => item.id), reason: '只回答一个需求。' }], nextRequests: [] }),
  });
  await assert.rejects(engine.run(input), errorCode('LOOP_PROTOCOL_INVALID'));
});

test('a case save during reading invalidates the loop instead of producing a current result', async (t) => {
  let host!: PluginHost;
  const current = await fixture(t, { read: async (data) => {
    await call(host, CASE_CAPABILITIES.registerText, { caseId: data.caseId, sourceLabel: '运行中新增', text: '另一窗口新保存的材料。' });
    return reading(data);
  } });
  host = current.host;
  await assert.rejects(current.engine.run(current.input), errorCode('LOOP_SOURCE_CHANGED'));
  assert.equal(current.calls.review.length, 0);
});

test('changed physical originals are detected even if the case revision did not change', async (t) => {
  let originalPath = '';
  const current = await fixture(t, { read: async (data) => {
    await writeFile(originalPath, '外部修改破坏了原件。');
    return reading(data);
  } });
  originalPath = current.view.originalPath;
  await assert.rejects(current.engine.run(current.input), /CHANGED/);
});

test('plugin execution failures reject the run rather than masquerading as unresolved information', async (t) => {
  const { input, engine, calls } = await fixture(t, { read: () => { throw new Error('controlled reader failure'); } });
  await assert.rejects(engine.run(input), (error: unknown) => error instanceof LoopError
    && error.code === 'LOOP_CAPABILITY_FAILED' && /controlled reader failure/.test(error.message));
  assert.equal(calls.review.length, 0);
});
