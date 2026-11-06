import { defineCapability, type PluginDefinition } from '../contracts.ts';
import {
  MATERIAL_CAPABILITIES, materialRequestSchema, materialSchema, materialViewSchema,
  ocrAttemptSchema, registerImageSchema, registerTextSchema, type OcrAdapter,
} from './contracts.ts';
import { MaterialStore } from './store.ts';
import { MaterialTextStore } from './versions.ts';
import { SourceReferenceStore } from './references.ts';
import {
  createReferenceSchema, referenceRequestSchema, resolvedReferenceSchema, saveRevisionSchema,
  sourceReferenceSchema, textVersionRequestSchema, textVersionSchema, textVersionsSchema, textVersionViewSchema,
} from './text-contracts.ts';

/** A thin host adapter; the store and OCR interface remain usable without this host. */
export function createMaterialPlugin(
  store: MaterialStore,
  ocr: OcrAdapter,
  textServices?: { versions: MaterialTextStore; references: SourceReferenceStore },
): PluginDefinition {
  return {
    manifest: { id: 'builtin.materials', version: '0.2.0', apiVersion: 1 },
    setup: async ({ onDispose }) => {
      onDispose(() => ocr.close());
      await store.initialize();
    },
    capabilities: [
      defineCapability({
        ...MATERIAL_CAPABILITIES.registerText, input: registerTextSchema, output: materialSchema,
        execute: async (input) => ({ status: 'success', data: await store.registerText(input) }),
      }),
      defineCapability({
        ...MATERIAL_CAPABILITIES.registerImage, input: registerImageSchema, output: materialSchema,
        execute: async (input) => ({ status: 'success', data: await store.registerImage(input) }),
      }),
      defineCapability({
        ...MATERIAL_CAPABILITIES.read, input: materialRequestSchema, output: materialViewSchema,
        execute: async ({ materialId }) => ({ status: 'success', data: await store.read(materialId) }),
      }),
      defineCapability({
        ...MATERIAL_CAPABILITIES.recognize, input: materialRequestSchema, output: ocrAttemptSchema,
        execute: async ({ materialId }) => ({ status: 'success', data: await store.recognize(materialId, ocr) }),
      }),
      ...(textServices ? [
        defineCapability({
          ...MATERIAL_CAPABILITIES.listVersions, input: materialRequestSchema, output: textVersionsSchema,
          execute: async ({ materialId }) => ({ status: 'success', data: await textServices.versions.listVersions(materialId) }),
        }),
        defineCapability({
          ...MATERIAL_CAPABILITIES.readVersion, input: textVersionRequestSchema, output: textVersionViewSchema,
          execute: async (input) => ({ status: 'success', data: await textServices.versions.readVersion(input) }),
        }),
        defineCapability({
          ...MATERIAL_CAPABILITIES.saveRevision, input: saveRevisionSchema, output: textVersionSchema,
          execute: async (input) => ({ status: 'success', data: await textServices.versions.saveRevision(input) }),
        }),
        defineCapability({
          ...MATERIAL_CAPABILITIES.createReference, input: createReferenceSchema, output: sourceReferenceSchema,
          execute: async (input) => ({ status: 'success', data: await textServices.references.create(input) }),
        }),
        defineCapability({
          ...MATERIAL_CAPABILITIES.resolveReference, input: referenceRequestSchema, output: resolvedReferenceSchema,
          execute: async (input) => ({ status: 'success', data: await textServices.references.resolve(input) }),
        }),
      ] : []),
    ],
  };
}
