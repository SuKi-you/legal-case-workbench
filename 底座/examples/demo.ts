import type { InvocationResult, StopResult } from '../src/index.ts';
import { createDemoHost, loadDemoConfig } from './configuration.ts';
import type { DemoConfig } from './configuration.ts';
import { REPORT_QUOTE } from './contracts.ts';

const fictionalText = '虚构记录：🌙小舟在周三收到一枚蓝色书签。';
export const DEMO_CASES: readonly { readonly label: string; readonly input: unknown }[] = [
  {
    label: 'success',
    input: { sourceId: 'fictional-note-1', text: fictionalText, quote: '一枚蓝色书签' },
  },
  {
    label: 'needs_input',
    input: { sourceId: 'fictional-note-1', text: fictionalText },
  },
  {
    label: 'not_applicable',
    input: { sourceId: 'fictional-note-1', text: fictionalText, quote: '红色信封' },
  },
  {
    label: 'INPUT_INVALID',
    input: { sourceId: 123, text: fictionalText, quote: '一枚蓝色书签' },
  },
];

export async function runDemo(config?: DemoConfig) {
  const selectedConfig = config ?? await loadDemoConfig();
  const host = await createDemoHost(selectedConfig);
  const capabilities = host.listCapabilities();
  const cases: { label: string; input: unknown; result: InvocationResult }[] = [];
  let stopResult: StopResult;
  try {
    for (const scenario of DEMO_CASES) {
      // This caller is unchanged when configuration selects another provider.
      const result = await host.invoke(REPORT_QUOTE, scenario.input);
      cases.push({ ...scenario, result });
    }
  } finally {
    stopResult = await host.stop();
  }
  return { config: selectedConfig, capabilities, cases, stopResult };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--config')) {
    throw new Error('用法：npm run demo -- [--config examples/configs/alternate.json]');
  }
  const report = await runDemo(await loadDemoConfig(args[1]));
  console.log(JSON.stringify({ config: report.config, capabilities: report.capabilities }, null, 2));
  for (const { label, result } of report.cases) {
    console.log(JSON.stringify({ label, result }, null, 2));
  }
  console.log(JSON.stringify({ lifecycle: report.stopResult }, null, 2));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
