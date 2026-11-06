import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createOutputFixture } from './output-fixtures.ts';
import { createCaseOutput, readCaseOutput } from '../src/outputs/store.ts';

export async function runOutputDemo(args: string[]) {
  const { values } = parseArgs({ args, options: { 'data-dir': { type: 'string', default: './runtime-data' } } });
  const dataDir = resolve(values['data-dir']), fixture = await createOutputFixture(dataDir);
  const manifest = await createCaseOutput({ dataDir, caseId: fixture.record.id, runId: fixture.run.id,
    sections: [{ id: 'test.review-notes', title: '承办复核事项', provider: { id: 'example.output-review', version: '1.0.0' },
      paragraphs: [{ text: '请对照两份金额记载的原件，保留双方陈述后再判断差异原因。', findingIds: fixture.run.findings.filter((finding) => finding.record?.value.kind === 'money').map((finding) => finding.id) }] }] });
  const output = await readCaseOutput({ dataDir, caseId: fixture.record.id, outputId: manifest.outputId });
  console.log(JSON.stringify({ fictionalOnly: true, usesActualLlm: false, caseId: fixture.record.id, runId: fixture.run.id,
    outputId: manifest.outputId, currentInputMatches: output.currentInputMatches, paths: output.paths }, null, 2));
  return output;
}
if (import.meta.main) {
  try { await runOutputDemo(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : '导出演示失败。'); process.exitCode = 1; }
}
