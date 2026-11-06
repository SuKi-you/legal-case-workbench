import { defineCapability, HOST_API_VERSION } from '../src/index.ts';
import type { PluginDefinition } from '../src/index.ts';
import { LOCATE_QUOTE, REPORT_QUOTE, quoteMatchSchema, quoteRequestSchema } from './contracts.ts';

// This plugin knows the shared contract and has no provider-specific imports.
export const quoteConsumerPlugin: PluginDefinition = {
  manifest: {
    id: 'example.quote-consumer',
    version: '1.0.0',
    apiVersion: HOST_API_VERSION,
    requires: [LOCATE_QUOTE],
  },
  capabilities: [defineCapability({
    ...REPORT_QUOTE,
    input: quoteRequestSchema,
    output: quoteMatchSchema,
    async execute(input, context) {
      const child = await context.invoke(LOCATE_QUOTE, input);
      switch (child.status) {
        case 'success':
          return { status: 'success', data: quoteMatchSchema.parse(child.data) };
        case 'needs_input':
        case 'not_applicable':
          return { status: child.status, reason: child.reason };
        case 'error':
          // A host error is not a valid handler outcome. Make the failure explicit;
          // the host turns this throw into EXECUTION_FAILED for the consumer call.
          throw new Error(`Dependency ${LOCATE_QUOTE.id}@${LOCATE_QUOTE.version} failed: ${child.error.code}: ${child.error.message}`);
      }
    },
  })],
};
