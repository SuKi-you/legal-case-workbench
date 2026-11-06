import { join, resolve } from 'node:path';
import type { PluginDefinition, PluginHost } from './contracts.ts';
import { createHost } from './host.ts';
import type { OcrAdapter } from './materials/contracts.ts';
import { createMaterialPlugin } from './materials/plugin.ts';
import { MaterialStore } from './materials/store.ts';
import { createTesseractOcr } from './materials/tesseract.ts';
import { MaterialTextStore } from './materials/versions.ts';
import { SourceReferenceStore } from './materials/references.ts';
import { CaseStore } from './cases/store.ts';
import { CaseWorkspace } from './cases/workspace.ts';
import { createCasePlugin } from './cases/plugin.ts';
import { CaseRollback } from './cases/rollback.ts';

export interface RuntimeOptions {
  readonly dataDir: string;
  readonly ocr?: OcrAdapter;
  readonly plugins?: readonly PluginDefinition[];
}

/** One startup includes the common abilities; professional plugins are additional. */
export function createRuntime(options: RuntimeOptions): Promise<PluginHost> {
  const dataDir = resolve(options.dataDir);
  const store = new MaterialStore(dataDir);
  const ocr = options.ocr ?? createTesseractOcr({ cachePath: join(dataDir, 'ocr-cache') });
  const versions = new MaterialTextStore(dataDir, store);
  const references = new SourceReferenceStore(dataDir, versions);
  const cases = new CaseStore(dataDir);
  const workspace = new CaseWorkspace(dataDir, cases);
  const rollback = new CaseRollback(cases, workspace);
  return createHost({
    plugins: [
      createMaterialPlugin(store, ocr, { versions, references }),
      createCasePlugin(cases, workspace, ocr, rollback),
      ...(options.plugins ?? []),
    ],
  });
}
