import { defineCapability, HOST_API_VERSION } from '../../src/index.ts';
import type { PluginDefinition } from '../../src/index.ts';
import { LOCATE_QUOTE, quoteMatchSchema, quoteRequestSchema } from '../contracts.ts';

export const indexOfQuotePlugin: PluginDefinition = {
  manifest: { id: 'example.quote-index-of', version: '1.0.0', apiVersion: HOST_API_VERSION },
  capabilities: [defineCapability({
    ...LOCATE_QUOTE,
    input: quoteRequestSchema,
    output: quoteMatchSchema,
    execute(input) {
      if (!input.quote?.trim()) {
        return { status: 'needs_input', reason: '请提供需要定位的原文片段。' };
      }
      const start = input.text.indexOf(input.quote);
      if (start < 0) {
        return { status: 'not_applicable', reason: '该文本中没有完全一致的片段。' };
      }
      return {
        status: 'success',
        data: { sourceId: input.sourceId, quote: input.quote, start, end: start + input.quote.length },
      };
    },
  })],
};
