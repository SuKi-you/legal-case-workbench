import { z } from 'zod';

// These schemas belong to this fictional text example, not to the host API.
export const LOCATE_QUOTE = { id: 'example.locate-quote', version: 1 } as const;
export const REPORT_QUOTE = { id: 'example.report-quote', version: 1 } as const;

export const quoteRequestSchema = z.strictObject({
  sourceId: z.string().min(1),
  text: z.string(),
  // Missing or blank quotes are valid requests that need more user input.
  quote: z.string().optional(),
});

export const quoteMatchSchema = z.strictObject({
  sourceId: z.string().min(1),
  quote: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}).refine((match) => match.end === match.start + match.quote.length, {
  message: 'end must equal start + quote.length (UTF-16 code units)',
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type QuoteMatch = z.infer<typeof quoteMatchSchema>;
