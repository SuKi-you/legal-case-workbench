import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { organizeCaseInformation, informationPlanSchema } from '../src/information/service.ts';
import { createDeepSeekModel, loadDeepSeekConfig } from '../src/information/deepseek.ts';
import { LoopRunStore } from '../src/loops/store.ts';

const help = `信息整理与核对（在底座目录中运行）：
npm.cmd run information -- run --case <案件ID> --plan ./plan.json
npm.cmd run information -- show --case <案件ID> --run <循环ID>
可加 --data-dir <目录>，默认 ./runtime-data。模型仅在run时调用DeepSeek，密钥从本机配置读取。
plan.json包含goal、selections:[{materialId,versionId}]、needs及可选sourceKinds/bindings/limits。
sourceKinds是用户对来源的标注，不证明材料真实性。show只读取已保存记录。`;
export async function runInformationCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    case: { type: 'string' }, plan: { type: 'string' }, run: { type: 'string' },
    'data-dir': { type: 'string', default: './runtime-data' },
  } });
  const command = positionals[0] ?? 'help';
  if (command === 'help') { console.log(help); return; }
  if (positionals.length !== 1 || !values.case) throw new Error(help);
  if (command === 'show') {
    if (!values.run) throw new Error('请提供 --run。');
    console.log(JSON.stringify(await new LoopRunStore(values['data-dir']).read({ caseId: values.case, runId: values.run }), null, 2));
  } else if (command === 'run') {
    if (!values.plan) throw new Error('请提供 --plan。');
    const plan = informationPlanSchema.parse(JSON.parse(await readFile(values.plan, 'utf8')));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    try {
      const run = await organizeCaseInformation({ dataDir: values['data-dir'], caseId: values.case, plan,
        model: createDeepSeekModel(loadDeepSeekConfig()), signal: controller.signal });
      console.log(JSON.stringify(run, null, 2));
    } finally { process.removeListener('SIGINT', cancel); }
  } else throw new Error(help);
}
if (import.meta.main) {
  try { await runInformationCommand(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : '信息整理失败。'); process.exitCode = 1; }
}
