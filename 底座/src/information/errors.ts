export class InformationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = 'InformationError'; this.code = code; }
}
