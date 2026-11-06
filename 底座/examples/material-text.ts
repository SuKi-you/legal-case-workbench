import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  createRuntime, CASE_CAPABILITIES, MATERIAL_CAPABILITIES, caseIdSchema, resolvedReferenceSchema, sourceReferenceSchema,
  textHashSchema, textVersionSchema, textVersionsSchema, textVersionViewSchema,
  type CapabilityRef,
} from '../src/index.ts';

const draftSchema = z.strictObject({
  format: z.literal('law-agent-edit-draft@1'), dataDir: z.string(), materialId: z.uuid(),
  baseVersionId: z.uuid(), baseTextSha256: textHashSchema, caseId: caseIdSchema.optional(),
});
const help = `直接编辑文字（在底座目录中运行）：
npm.cmd run materials:text -- versions --material <材料ID>
npm.cmd run materials:text -- export --material <材料ID> --version <版本ID> --file ./runtime-data/edits/text.txt
在 VS Code 中打开导出的 UTF-8 文本，修改后按 Ctrl+S。
npm.cmd run materials:text -- save --file ./runtime-data/edits/text.txt --editor "你的称呼"
npm.cmd run materials:text -- cite --material <材料ID> --version <版本ID> --quote "6000元"
npm.cmd run materials:text -- resolve --material <材料ID> --reference <引用ID>
同一句出现多次时，cite 增加 --start <UTF-16起始位置>。所有命令可增加 --data-dir <数据目录>。
案件内文字增加 --case <案件ID>；导出后的草稿会记住所属案件，save 可直接沿用。`;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`请提供 --${name}。`);
  return value;
}
function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
async function physicalLocation(path: string): Promise<string> {
  const tail: string[] = [];
  let ancestor = resolve(path);
  while (true) {
    try { return resolve(await realpath(ancestor), ...tail.reverse()); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      tail.push(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export async function runMaterialTextCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'data-dir': { type: 'string' }, case: { type: 'string' }, material: { type: 'string' }, version: { type: 'string' },
    file: { type: 'string' }, editor: { type: 'string' }, note: { type: 'string' },
    quote: { type: 'string' }, start: { type: 'string' }, reference: { type: 'string' },
  } });
  const command = positionals[0] ?? 'help';
  if (command === 'help') { console.log(help); return; }
  if (positionals.length !== 1 || !['versions', 'export', 'save', 'cite', 'resolve'].includes(command)) {
    throw new Error(help);
  }
  const file = values.file ? resolve(values.file) : undefined;
  const metadataFile = file ? `${file}.meta.json` : undefined;
  const draft = command === 'save'
    ? draftSchema.parse(JSON.parse(decodeUtf8(await readFile(required(metadataFile, 'file')))))
    : undefined;
  const dataDir = resolve(values['data-dir'] ?? draft?.dataDir ?? './runtime-data');
  if (draft && dataDir !== resolve(draft.dataDir)) throw new Error('草稿属于另一数据目录，请核对 --data-dir。');
  const requestedCaseId = values.case === undefined ? undefined : caseIdSchema.parse(values.case);
  if (draft && requestedCaseId !== undefined && requestedCaseId !== draft.caseId) {
    throw new Error('草稿属于另一案件，不能通过 --case 改变其归属。');
  }
  const caseId = requestedCaseId ?? draft?.caseId;
  const capabilities = caseId ? CASE_CAPABILITIES : MATERIAL_CAPABILITIES;
  if (file && (command === 'save' || command === 'export')) {
    for (const managedDirectory of ['materials', 'cases']) {
      const pathInMaterials = relative(
        await physicalLocation(join(dataDir, managedDirectory)), await physicalLocation(file),
      );
      if (!isAbsolute(pathInMaterials) && pathInMaterials !== '..' && !pathInMaterials.startsWith(`..${sep}`)) {
        throw new Error('编辑草稿必须放在 materials 原件目录以外，也不能写入案件受管目录，例如使用 runtime-data/edits/text.txt。');
      }
    }
  }
  const runtime = await createRuntime({ dataDir });
  const call = async (ref: CapabilityRef, input: Record<string, unknown>): Promise<unknown> => {
    const result = await runtime.invoke(ref, caseId ? { ...input, caseId } : input);
    if (result.status === 'error') throw new Error(`${result.error.code}: ${result.error.message}`);
    if (result.status !== 'success') throw new Error(result.reason);
    return result.data;
  };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  try {
    if (command === 'versions') {
      print(textVersionsSchema.parse(await call(capabilities.listVersions, {
        materialId: required(values.material, 'material'),
      })));
    } else if (command === 'export') {
      const target = required(file, 'file');
      const view = textVersionViewSchema.parse(await call(capabilities.readVersion, {
        materialId: required(values.material, 'material'), versionId: required(values.version, 'version'),
      }));
      await mkdir(dirname(target), { recursive: true });
      const meta = draftSchema.parse({
        format: 'law-agent-edit-draft@1', dataDir, materialId: view.material.id,
        baseVersionId: view.version.id, baseTextSha256: view.version.textSha256,
        ...(caseId ? { caseId } : {}),
      });
      // Export never overwrites an existing file or a saved original.
      await writeFile(`${target}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
      try { await writeFile(target, view.version.text, { flag: 'wx' }); }
      catch (error) {
        await unlink(`${target}.meta.json`);
        throw error;
      }
      print({ editableFile: target, originalPath: view.originalPath, ...meta,
        message: '在 VS Code 中编辑 editableFile 并按 Ctrl+S，然后运行 save 命令；meta.json 保留基准版本。' });
    } else if (command === 'save' && draft) {
      const revision = textVersionSchema.parse(await call(capabilities.saveRevision, {
        materialId: draft.materialId, baseVersionId: draft.baseVersionId, baseTextSha256: draft.baseTextSha256,
        text: decodeUtf8(await readFile(required(file, 'file'))), editor: required(values.editor, 'editor'),
        ...(values.note === undefined ? {} : { note: values.note }),
      }));
      print(revision);
      // Only the editable draft advances its base; persisted history is append-only.
      const temporary = `${metadataFile}.${randomUUID()}.tmp`;
      let ownTemporary = false;
      try {
        const handle = await open(temporary, 'wx');
        ownTemporary = true;
        try {
          await handle.writeFile(`${JSON.stringify({ ...draft,
            baseVersionId: revision.id, baseTextSha256: revision.textSha256,
          }, null, 2)}\n`);
        } finally { await handle.close(); }
        await rename(temporary, metadataFile!);
      } catch {
        throw new Error(`修订已保存（${revision.id}），但草稿基准更新失败。请重新导出该版本再继续编辑。`);
      } finally {
        if (ownTemporary) await unlink(temporary).catch(() => {});
      }
    } else if (command === 'cite') {
      const request = { materialId: required(values.material, 'material'), versionId: required(values.version, 'version') };
      const view = textVersionViewSchema.parse(await call(capabilities.readVersion, request));
      const quote = required(values.quote, 'quote');
      let start = view.version.text.indexOf(quote);
      if (values.start !== undefined) {
        if (!/^(0|[1-9]\d*)$/.test(values.start)) throw new Error('--start 必须为非负整数。');
        start = Number(values.start);
      } else if (start >= 0 && view.version.text.indexOf(quote, start + 1) >= 0) {
        throw new Error('摘录出现多次，请用 --start 明确指定位置。');
      }
      if (start < 0) throw new Error('指定版本中没有这段摘录。');
      print(sourceReferenceSchema.parse(await call(capabilities.createReference, {
        ...request, start, end: start + quote.length, quote,
      })));
    } else if (command === 'resolve') {
      print(resolvedReferenceSchema.parse(await call(capabilities.resolveReference, {
        materialId: required(values.material, 'material'), referenceId: required(values.reference, 'reference'),
      })));
    }
  } finally { await runtime.stop(); }
}

if (import.meta.main) {
  try { await runMaterialTextCommand(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
