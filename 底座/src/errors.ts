export type HostErrorCode =
  | 'CONFIG_INVALID'
  | 'API_VERSION_UNSUPPORTED'
  | 'DUPLICATE_PLUGIN'
  | 'CAPABILITY_CONFLICT'
  | 'DEPENDENCY_MISSING'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'DEPENDENCY_CYCLE'
  | 'PLUGIN_START_FAILED';

/** Startup is atomic: a failed host is not returned to its caller. */
export class HostError extends Error {
  readonly code: HostErrorCode;
  readonly details: unknown;

  constructor(code: HostErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.details = details;
  }
}
