import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createRuntime } from '../src/runtime.ts';
import { CASE_CAPABILITIES, caseRecordSchema, caseCheckpointSchema, rollbackPreviewSchema, rollbackResultSchema } from '../src/cases/contracts.ts';
import { CaseStore } from '../src/cases/store.ts';
import { materialSchema } from '../src/materials/contracts.ts';
import { textVersionViewSchema } from '../src/materials/text-contracts.ts';
import { IntakeLoop } from '../src/loops/engine.ts';
import { LoopRunStore } from '../src/loops/store.ts';
import { loopReviewSchema, type LoopRun, type LoopSource } from '../src/loops/contracts.ts';
import { createInformationPlugins } from '../src/information/plugins.ts';
import type { JsonModel } from '../src/information/model.ts';
import { informationAnalysisSchema, type InformationRecord, type StructuredNeed } from '../src/information/contracts.ts';
import type { CapabilityRef, PluginDefinition, PluginHost } from '../src/contracts.ts';
import { createLoopExamplePlugins, EXAMPLE_LOOP_REFS, EXAMPLE_LOOP_TEXTS } from '../examples/loop-fixtures.ts';

const first = '陈某（工号E001）称：流水T001于2026年9月10日实付8000元。';
const agreeing = '工号E001的陈某补充说：流水T001于2026年9月10日实付8000元。';
const differing = '陈某（工号E001）又称：流水T001于2026年9月10日实付6000元。';
const need: StructuredNeed = {
  id: 'test.transfer-amount', question: '陈某2026年9月这笔款项实付多少？', reason: '保留金额、同笔事项及原文出处，检查记载是否一致。',
  spec: { topic: 'transfer.amount', subject: 'employee_id:E001', object: null,
    period: '2026-09', basis: '实付', requiredFields: ['subject', 'event.key', 'time', 'value', 'period', 'basis'],
    minimumSupport: 'statement', applicable: true },
};

/**
 * Scripted test-only model. It recognizes this fixture's transfer grammar; it
 * does not claim to be an actual LLM or a general natural-language reader.
 */
function scriptedModel(onRead?: () => Promise<void>) {
  const calls: Array<{ id: string; text: string; label: string }> = [];
  const model: JsonModel = {
    id: 'scripted-information-workflow-test', model: 'fixture-only',
    complete: async ({ system, user }) => {
      if (system.includes('INFORMATION_SEMANTIC_REVIEW')) {
        const { items } = JSON.parse(user) as { items: unknown[] };
        return { verdicts: items.map((_, index) => ({ index, relevant: true, supported: true, rolesCorrect: true, polarityCorrect: true, reason: 'fixture-only semantic gate reply' })) };
      }
      const payload = JSON.parse(user) as { needs: StructuredNeed[]; segment: { id: string; text: string; sourceLabel: string } };
      const segment = payload.segment;
      calls.push({ id: segment.id, text: segment.text, label: segment.sourceLabel });
      await onRead?.();
      if (payload.needs[0]?.spec?.topic !== 'transfer.amount') return { items: [] };
      const items = segment.text.split('。').filter(Boolean).flatMap((sentence) => {
        const quote = `${sentence}。`;
        const amount = /实付(\d+)元/u.exec(quote)?.[1];
        if (!amount || !quote.includes('陈某') || !quote.includes('工号E001') || !quote.includes('流水T001')
          || !quote.includes('2026年9月10日')) return [];
        const entity = { name: '陈某', kind: 'person' as const, identity: { scheme: '工号', value: 'E001' } };
        const record: InformationRecord = {
          topic: 'transfer.amount', subject: entity, attributedTo: structuredClone(entity), object: null,
          event: { type: 'fixture-free-phrase', key: 'T001', description: '同笔转账记载' },
          time: { raw: '2026年9月10日', start: null, end: null, precision: 'unknown' },
          value: { kind: 'money', raw: `${amount}元`, normalized: 'do-not-trust-this-fixture-value', unit: null },
          polarity: 'affirmed', period: '2026-09', basis: '实付', origin: 'party_statement', qualifiers: {}, uncertainty: [],
        };
        return [{ statement: `当事人陈述的T001金额为${amount}元（${segment.sourceLabel}）。`, record,
          quotes: [{ segmentId: segment.id, quote, occurrence: null }] }];
      });
      return { items };
    },
  };
  return { model, calls };
}

async function invoke(host: PluginHost, ref: CapabilityRef, input: unknown): Promise<unknown> {
  const result = await host.invoke(ref, input);
  if (result.status !== 'success') assert.fail(JSON.stringify(result));
  return result.data;
}

type Factory = ReturnType<typeof createInformationPlugins>;
async function fixture(t: TestContext, options: {
  texts?: readonly string[]; needs?: readonly StructuredNeed[]; model?: JsonModel;
  documentIndices?: readonly number[];
  transform?: (factory: Factory) => PluginDefinition[];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-information-workflow-'));
  const script = scriptedModel();
  const sourceKinds: Record<string, 'party_statement' | 'document_record'> = {};
  const factory = createInformationPlugins({ model: options.model ?? script.model, needs: options.needs ?? [need], extraction: { sourceKinds } });
  const host = await createRuntime({ dataDir: directory, plugins: options.transform?.(factory) ?? factory.plugins });
  const hosts = [host];
  t.after(async () => {
    for (const active of hosts) await active.stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const record = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, { title: '虚构信息整理集成案', actor: '测试用户' }));
  const sources: LoopSource[] = [];
  for (const [index, text] of (options.texts ?? [first, `${agreeing}${differing}`]).entries()) {
    const material = materialSchema.parse(await invoke(host, CASE_CAPABILITIES.registerText, {
      caseId: record.id, sourceLabel: `测试材料${index + 1}`, text,
    }));
    if (options.documentIndices?.includes(index)) sourceKinds[material.id] = 'document_record';
    const { version } = textVersionViewSchema.parse(await invoke(host, CASE_CAPABILITIES.readVersion, {
      caseId: record.id, materialId: material.id, versionId: material.id,
    }));
    sources.push({ materialId: material.id, versionId: version.id, textSha256: version.textSha256 });
  }
  const start = { caseId: record.id, goal: '按声明需求整理材料中的金额及相关记载，核对出处和差异。', sources, ...factory.refs };
  return { directory, host, hosts, factory, sources, start, calls: script.calls, record };
}

async function restore(host: PluginHost, caseId: string, checkpointId: string) {
  const preview = rollbackPreviewSchema.parse(await invoke(host, CASE_CAPABILITIES.previewRollback, { caseId, checkpointId }));
  return rollbackResultSchema.parse(await invoke(host, CASE_CAPABILITIES.applyRollback, {
    caseId, checkpointId, expectedRevision: preview.expectedRevision, previewToken: preview.token, actor: '测试用户',
  }));
}

test('all four information abilities work together across two targeted reading rounds without a real network model', async (t) => {
  const { host, start, sources, calls } = await fixture(t);
  const run = await new IntakeLoop(host).run(start);
  assert.equal(run.rounds.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.id.startsWith(`${sources[0]!.materialId}/`));
  assert.ok(calls[1]!.id.startsWith(`${sources[1]!.materialId}/`));
  assert.equal(run.rounds[0]!.attempts[0]!.examined.length, 1);
  assert.equal(run.rounds[1]!.attempts[0]!.examined.length, 1);
  const firstCoverage = run.rounds[0]!.review.analysis!.needs[0]!;
  assert.equal(firstCoverage.coverage, 'found');
  assert.equal(firstCoverage.satisfaction, 'satisfied');
  assert.equal(firstCoverage.unread.length, 1);
  assert.equal(run.rounds[0]!.review.assessments[0]!.status, 'unresolved', 'An obtained statement cannot hide unread selected sources.');
  assert.match(run.rounds[0]!.review.nextRequests[0]!.reason, /已有陈述继续保留/);
  assert.deepEqual(run.rounds[0]!.review.nextRequests[0]!.sources, [sources[1]]);
  assert.equal(run.findings.length, 3);
  for (const finding of run.findings) {
    assert.equal(finding.record!.subject!.identity!.scheme, 'employee_id');
    assert.equal(finding.record!.event.type, 'transfer.amount');
    assert.equal(finding.record!.time.start, '2026-09-10');
    assert.equal(finding.record!.value.unit, 'CNY');
    for (const citation of finding.citations) {
      const { version } = textVersionViewSchema.parse(await invoke(host, CASE_CAPABILITIES.readVersion, {
        caseId: run.caseId, materialId: citation.materialId, versionId: citation.versionId,
      }));
      assert.equal(version.text.slice(citation.start, citation.end), citation.quote);
      assert.equal(version.textSha256, citation.textSha256);
    }
  }
  assert.deepEqual(run.findings.map((finding) => finding.record!.value.normalized), ['8000', '8000', '6000']);
  const analysis = informationAnalysisSchema.parse(run.information);
  assert.ok(analysis.entities.some((group) => group.names.includes('陈某') && group.findingIds.length === 3));
  assert.ok(analysis.relations.some((relation) => relation.kind === 'equivalent_claim' && relation.findingIds.length === 2));
  assert.ok(analysis.relations.some((relation) => relation.kind === 'same_event'));
  assert.ok(analysis.conflicts.some((conflict) => conflict.classification === 'inconsistent' && conflict.field === 'value'));
  assert.equal(analysis.needs[0]!.coverage, 'found');
  assert.equal(analysis.needs[0]!.consistency, 'conflicting');
  assert.equal(analysis.needs[0]!.satisfaction, 'needs_review');
  assert.equal(analysis.needs[0]!.unread.length, 0);
  assert.equal(run.status, 'needs_review');
  assert.deepEqual(run.information, run.rounds[1]!.review.analysis);
});

test('a statement remains available while a later selected document supplies requested support', async (t) => {
  const documentedNeed = structuredClone(need); documentedNeed.spec!.minimumSupport = 'document';
  const { host, start } = await fixture(t, { texts: [first, agreeing], needs: [documentedNeed], documentIndices: [1] });
  const run = await new IntakeLoop(host).run(start);
  assert.equal(run.rounds.length, 2);
  assert.equal(run.rounds[0]!.review.analysis!.needs[0]!.support, 'statement_only');
  assert.equal(run.rounds[0]!.review.analysis!.needs[0]!.coverage, 'found');
  assert.ok(run.rounds[0]!.review.analysis!.needs[0]!.missingFields.includes('document_support'));
  assert.equal(run.rounds[0]!.review.assessments[0]!.status, 'unresolved');
  assert.equal(run.status, 'completed');
  assert.equal(run.information!.needs[0]!.support, 'document_supported');
  assert.equal(run.information!.needs[0]!.satisfaction, 'satisfied');
  assert.equal(run.findings[0]!.record!.origin, 'party_statement');
  assert.equal(run.findings[1]!.record!.origin, 'document_record');
});

test('structured information and per-round analysis survive restart, whole-case rollback and undo', async (t) => {
  const { directory, host, hosts, start } = await fixture(t);
  const checkpoint = caseCheckpointSchema.parse(await invoke(host, CASE_CAPABILITIES.createCheckpoint, {
    caseId: start.caseId, label: '信息整理之前', actor: '测试用户',
  }));
  const run = await new IntakeLoop(host).run(start);
  await new LoopRunStore(directory).save(run);
  await host.stop();
  const restarted = await createRuntime({ dataDir: directory }); hosts.push(restarted);
  const loaded = await new LoopRunStore(directory).read({ caseId: run.caseId, runId: run.id });
  assert.deepEqual(loaded, run);
  assert.equal(loaded.information!.needs[0]!.consistency, 'conflicting');
  const rolled = await restore(restarted, run.caseId, checkpoint.id);
  await assert.rejects(new LoopRunStore(directory).read({ caseId: run.caseId, runId: run.id }), /LOOP_RUN_NOT_ACTIVE/);
  await restore(restarted, run.caseId, rolled.undoCheckpoint.id);
  assert.deepEqual(await new LoopRunStore(directory).read({ caseId: run.caseId, runId: run.id }), run);
  assert.equal((await new CaseStore(directory).history(run.caseId)).filter((event) => event.kind === 'rolled_back').length, 2);
});

test('an examined source with no matching information produces an explicit gap rather than fake completion', async (t) => {
  const { host, start } = await fixture(t, { texts: ['本材料仅记载会议地址，没有付款信息。'] });
  const run = await new IntakeLoop(host).run(start);
  assert.equal(run.status, 'needs_review');
  assert.deepEqual(run.findings, []);
  const coverage = run.information!.needs[0]!;
  assert.equal(coverage.coverage, 'not_found_in_examined');
  assert.equal(coverage.satisfaction, 'needs_information');
  assert.equal(coverage.examined.length, 1);
  assert.equal(coverage.unread.length, 0);
  assert.ok(coverage.missingFields.includes('information'));
  assert.ok(coverage.nextActions.some((action) => action.kind === 'clarify' && action.needId === need.id));
  assert.match(coverage.reason, /不等于案件中不存在/);
});

test('a concurrent profile save invalidates model work before it can become a current structured run', async (t) => {
  let host!: PluginHost, caseId = '', changed = false;
  const script = scriptedModel(async () => {
    if (changed) return;
    changed = true;
    const current = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.read, { caseId }));
    await invoke(host, CASE_CAPABILITIES.update, { caseId, expectedRevision: current.revision, actor: '另一窗口', stage: '并发资料更新' });
  });
  const data = await fixture(t, { model: script.model }); host = data.host; caseId = data.start.caseId;
  await assert.rejects(new IntakeLoop(host).run(data.start), /LOOP_SOURCE_CHANGED/);
  assert.equal((await new CaseStore(data.directory).read(caseId)).stage, '并发资料更新');
  assert.deepEqual((await new CaseStore(data.directory).readState(caseId)).workspace?.loopRuns ?? [], []);
});

function alteredReview(factory: Factory, change: (review: ReturnType<typeof loopReviewSchema.parse>) => void): PluginDefinition[] {
  return factory.plugins.map((plugin) => ({ ...plugin, capabilities: plugin.capabilities.map((capability) => capability.id !== factory.refs.review.id ? capability : {
    ...capability,
    execute: async (input, context) => {
      const outcome = await capability.execute(input, context);
      if (outcome.status !== 'success') return outcome;
      const review = loopReviewSchema.parse(outcome.data);
      change(review);
      return { status: 'success', data: review };
    },
  }) }));
}

test('the engine rejects a satisfied professional assessment contradicted by its own analysis', async (t) => {
  const { host, start } = await fixture(t, { texts: [first], transform: (factory) => alteredReview(factory, (review) => {
    review.analysis!.needs[0]!.satisfaction = 'needs_review';
  }) });
  await assert.rejects(new IntakeLoop(host).run(start), /INFORMATION_REVIEW_INCONSISTENT/);
});

test('the engine rejects forged information links even when their schema and existing assessment look valid', async (t) => {
  const { host, start } = await fixture(t, { texts: [first], transform: (factory) => alteredReview(factory, (review) => {
    review.analysis!.relations.push({ id: 'forged-link', kind: 'same_event', status: 'confirmed',
      findingIds: [review.assessments[0]!.findingIds[0]!, randomUUID()], reason: '不存在的记录不得参与关系。' });
  }) });
  await assert.rejects(new IntakeLoop(host).run(start), /INFORMATION_REFERENCE_INVALID/);
});

test('storage rejects top-level information differing from the final round and keeps case history unchanged', async (t) => {
  const { directory, host, start } = await fixture(t, { texts: [first] });
  const run = await new IntakeLoop(host).run(start);
  assert.equal(run.status, 'completed');
  const before = await new CaseStore(directory).read(start.caseId);
  const forged = structuredClone(run);
  forged.information!.needs[0]!.reason = '这段说明没有出现在最终复核结果中。';
  await assert.rejects(new LoopRunStore(directory).save(forged), /LOOP_RUN_INVALID/);
  assert.deepEqual(await new CaseStore(directory).read(start.caseId), before);
  assert.deepEqual((await new CaseStore(directory).readState(start.caseId)).workspace?.loopRuns ?? [], []);
  await new LoopRunStore(directory).save(run);
  assert.deepEqual(await new LoopRunStore(directory).read({ caseId: run.caseId, runId: run.id }), run);
});

test('previous unstructured loop providers and stored records remain compatible without new fields', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-legacy-information-'));
  const host = await createRuntime({ dataDir: directory, plugins: createLoopExamplePlugins() });
  t.after(async () => {
    await host.stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const record = caseRecordSchema.parse(await invoke(host, CASE_CAPABILITIES.create, { title: '旧版兼容虚构案', actor: '测试用户' }));
  const sources: LoopSource[] = [];
  for (const fixture of Object.values(EXAMPLE_LOOP_TEXTS)) {
    const material = materialSchema.parse(await invoke(host, CASE_CAPABILITIES.registerText, { caseId: record.id, ...fixture }));
    const { version } = textVersionViewSchema.parse(await invoke(host, CASE_CAPABILITIES.readVersion, { caseId: record.id, materialId: material.id, versionId: material.id }));
    sources.push({ materialId: material.id, versionId: material.id, textSha256: version.textSha256 });
  }
  const run: LoopRun = await new IntakeLoop(host).run({ caseId: record.id, goal: '读取旧版陈述', sources, ...EXAMPLE_LOOP_REFS });
  assert.equal(run.status, 'completed');
  assert.equal(run.information, undefined);
  assert.ok(run.findings.every((finding) => finding.record === undefined));
  assert.ok(run.rounds.every((round) => round.review.analysis === undefined));
  await new LoopRunStore(directory).save(run);
  assert.deepEqual(await new LoopRunStore(directory).read({ caseId: run.caseId, runId: run.id }), run);
});
