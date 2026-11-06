import { parseArgs } from 'node:util';
import { createCaseOutput, exportCaseOutput, listCaseOutputs, readCaseOutput } from '../src/outputs/store.ts';
import type { OutputFormat } from '../src/outputs/contracts.ts';

const help = `成果整理与导出（无需调用模型）：
npm.cmd run outputs -- create --case <案件ID> --run <整理运行ID>
npm.cmd run outputs -- list --case <案件ID>
npm.cmd run outputs -- show --case <案件ID> --output <底稿ID>
npm.cmd run outputs -- export --case <案件ID> --output <底稿ID> --format docx --out <文件路径>
可选 --data-dir <目录>（默认./runtime-data）；create可加 --previous <上一版底稿ID>。
export支持md、docx、json，不覆盖已有文件。show输出固定版本底稿并标记其与当前案件输入是否一致。`;
export async function runOutputCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    case: { type: 'string' }, run: { type: 'string' }, output: { type: 'string' }, previous: { type: 'string' },
    format: { type: 'string', default: 'docx' }, out: { type: 'string' }, 'data-dir': { type: 'string', default: './runtime-data' },
  } });
  const command = positionals[0] ?? 'help';
  if (command === 'help') { console.log(help); return; }
  if (positionals.length !== 1 || !values.case) throw new Error(help);
  const scope = { dataDir: values['data-dir'], caseId: values.case };
  if (command === 'create') {
    if (!values.run) throw new Error('请提供 --run。');
    console.log(JSON.stringify(await createCaseOutput({ ...scope, runId: values.run,
      ...(values.previous ? { previousOutputId: values.previous } : {}) }), null, 2));
  } else if (command === 'list') console.log(JSON.stringify(await listCaseOutputs(scope), null, 2));
  else if (command === 'show') {
    if (!values.output) throw new Error('请提供 --output。');
    const output = await readCaseOutput({ ...scope, outputId: values.output });
    console.log(JSON.stringify({ manifest: output.manifest, currentInputMatches: output.currentInputMatches,
      analysisCoversCurrentInput: output.analysisCoversCurrentInput, sourceCoverage: output.sourceCoverage, paths: output.paths }, null, 2));
    console.log(output.markdown);
  } else if (command === 'export') {
    if (!values.output || !values.out || !['md', 'docx', 'json'].includes(values.format)) throw new Error(help);
    console.log(JSON.stringify(await exportCaseOutput({ ...scope, outputId: values.output, format: values.format as OutputFormat, destination: values.out }), null, 2));
  } else throw new Error(help);
}
if (import.meta.main) {
  try { await runOutputCommand(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : '底稿操作失败。'); process.exitCode = 1; }
}
