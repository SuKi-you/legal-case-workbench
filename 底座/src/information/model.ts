/** Only transport lives behind this port; interpretation and validation stay in the information module. */
export interface JsonModel {
  readonly id: string;
  readonly model: string;
  complete(input: { system: string; user: string; signal?: AbortSignal; reasoning?: 'none' | 'high' }): Promise<unknown>;
}
