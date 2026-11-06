import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { InvocationError } from './contracts.ts';
import { isRecord } from './plan.ts';

export function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'Unprintable thrown value.';
  }
}

type ValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: InvocationError };

/** Consume Standard Schema directly; the host does not import a validator library. */
export async function validate(
  schema: StandardSchemaV1,
  value: unknown,
  stage: 'input' | 'output',
): Promise<ValidationResult> {
  try {
    const result: unknown = await schema['~standard'].validate(value);
    if (!isRecord(result)) throw new Error('Validator did not return a result object.');
    if (result.issues !== undefined) {
      if (!Array.isArray(result.issues)) throw new Error('Validator issues must be an array.');
      const issues = result.issues.map((issue: unknown) => {
        if (!isRecord(issue) || typeof issue.message !== 'string'
          || (issue.path !== undefined && !Array.isArray(issue.path))) {
          throw new Error('Validator returned a malformed issue.');
        }
        const path = ((issue.path ?? []) as unknown[]).map((segment) => {
          const key = isRecord(segment) ? segment.key : segment;
          return typeof key === 'number' ? key : String(key);
        });
        return { message: issue.message, path };
      });
      return {
        ok: false,
        error: {
          code: stage === 'input' ? 'INPUT_INVALID' : 'OUTPUT_INVALID',
          message: `Capability ${stage} does not satisfy its schema.`,
          stage,
          issues,
        },
      };
    }
    if (!('value' in result)) throw new Error('Validator success result is missing value.');
    return { ok: true, value: result.value };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'VALIDATOR_FAILED', message: errorMessage(error), stage },
    };
  }
}
