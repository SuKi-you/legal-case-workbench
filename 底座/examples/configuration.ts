import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createHost } from '../src/index.ts';
import { quoteConsumerPlugin } from './consumer.ts';
import { indexOfQuotePlugin } from './providers/index-of.ts';
import { scanQuotePlugin } from './providers/scan.ts';

const demoConfigSchema = z.strictObject({ quoteProvider: z.enum(['index-of', 'scan']) });
export type DemoConfig = z.infer<typeof demoConfigSchema>;

export async function loadDemoConfig(path?: string): Promise<DemoConfig> {
  const location = path ?? new URL('./configs/default.json', import.meta.url);
  return demoConfigSchema.parse(JSON.parse(await readFile(location, 'utf8')));
}

export function createDemoHost(config: DemoConfig) {
  const selected = demoConfigSchema.parse(config);
  const provider = selected.quoteProvider === 'index-of' ? indexOfQuotePlugin : scanQuotePlugin;
  // Exactly one provider is installed. The consumer stays identical for both.
  return createHost({ plugins: [quoteConsumerPlugin, provider] });
}
