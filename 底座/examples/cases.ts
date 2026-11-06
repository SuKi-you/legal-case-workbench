import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { createRuntime, CASE_CAPABILITIES, caseRecordSchema, type CapabilityRef } from '../src/index.ts';

const help = `案件工作区（在底座目录中执行）：
npm.cmd run cases -- create --title "陈某劳动争议" --actor "张律师"
npm.cmd run cases -- list
npm.cmd run cases -- list --query "陈某" --status active
npm.cmd run cases -- open --case <案件ID>
npm.cmd run cases -- mark --case <案件ID> --stage "材料整理中" --status active --note "已收到补充材料"
npm.cmd run cases -- history --case <案件ID>
npm.cmd run cases -- checkpoint --case <案件ID> --label "材料核对后"
npm.cmd run cases -- checkpoints --case <案件ID>
npm.cmd run cases -- rollback-preview --case <案件ID> --checkpoint <保存点ID>
npm.cmd run cases -- rollback --case <案件ID> --checkpoint <保存点ID> --expected-revision <预览版本号> --preview-token <预览token>
npm.cmd run cases -- add-text --case <案件ID> --label "接案记录" --text "需要保存的文字"
npm.cmd run cases -- add-text --case <案件ID> --path ./notes.txt --label "接案记录"
npm.cmd run cases -- add-image --case <案件ID> --path ./photo.png
npm.cmd run cases -- ocr --case <案件ID> --material <材料ID>
npm.cmd run cases -- add-file --case <案件ID> --path ./document.pdf
npm.cmd run cases -- take-file --case <案件ID> --file-id <附件ID> --out ./runtime-data/exports/document.pdf
npm.cmd run cases -- take-material --case <案件ID> --material <材料ID> --out ./runtime-data/exports/original.txt
状态：active=在办，paused=暂停，closed=结案。阶段为自定义文字，结案后仍可存取。
所有操作可加 --data-dir <数据目录>。mark 可加 --expected-revision <打开时的版本号>，冲突时拒绝覆盖。
案件内文字的直接编辑与引用：npm.cmd run materials:text -- help，然后增加 --case <案件ID>。`;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`请提供 --${name}。`);
  return value;
}

export async function runCasesCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'data-dir': { type: 'string', default: './runtime-data' }, case: { type: 'string' },
    title: { type: 'string' }, number: { type: 'string' }, description: { type: 'string' },
    actor: { type: 'string', default: '本地用户' }, stage: { type: 'string' }, status: { type: 'string' },
    note: { type: 'string' }, query: { type: 'string' }, 'expected-revision': { type: 'string' },
    text: { type: 'string' }, path: { type: 'string' }, label: { type: 'string' },
    material: { type: 'string' }, 'file-id': { type: 'string' }, out: { type: 'string' },
    checkpoint: { type: 'string' }, 'preview-token': { type: 'string' },
  } });
  const command = positionals[0] ?? 'help';
  if (command === 'help') { console.log(help); return; }
  const commands = ['create', 'list', 'open', 'mark', 'update', 'history', 'add-text', 'add-image',
    'read-material', 'ocr', 'add-file', 'read-file', 'take-file', 'take-material',
    'checkpoint', 'checkpoints', 'rollback-preview', 'rollback'];
  if (positionals.length !== 1 || !commands.includes(command)) throw new Error(help);
  const runtime = await createRuntime({ dataDir: values['data-dir'] });
  const call = async (ref: CapabilityRef, input: unknown): Promise<unknown> => {
    const result = await runtime.invoke(ref, input);
    if (result.status === 'error') throw new Error(`${result.error.code}: ${result.error.message}`);
    if (result.status !== 'success') throw new Error(result.reason);
    return result.data;
  };
  let result: unknown;
  try {
    if (command === 'create') {
      result = await call(CASE_CAPABILITIES.create, {
        title: required(values.title, 'title'), actor: values.actor,
        ...(values.number === undefined ? {} : { caseNumber: values.number }),
        ...(values.description === undefined ? {} : { description: values.description }),
        ...(values.stage === undefined ? {} : { stage: values.stage }),
      });
    } else if (command === 'list') {
      result = await call(CASE_CAPABILITIES.list, {
        ...(values.query === undefined ? {} : { query: values.query }),
        ...(values.status === undefined ? {} : { status: values.status }),
      });
    } else {
      const caseId = required(values.case, 'case');
      if (command === 'open') result = await call(CASE_CAPABILITIES.contents, { caseId });
      else if (command === 'history') result = await call(CASE_CAPABILITIES.history, { caseId });
      else if (command === 'checkpoint') result = await call(CASE_CAPABILITIES.createCheckpoint, {
        caseId, label: required(values.label, 'label'), actor: values.actor,
      });
      else if (command === 'checkpoints') result = await call(CASE_CAPABILITIES.listCheckpoints, { caseId });
      else if (command === 'rollback-preview') result = await call(CASE_CAPABILITIES.previewRollback, {
        caseId, checkpointId: required(values.checkpoint, 'checkpoint'),
      });
      else if (command === 'rollback') {
        const expected = required(values['expected-revision'], 'expected-revision');
        if (!/^[1-9]\d*$/.test(expected)) throw new Error('--expected-revision 必须为预览中的正整数版本号。');
        result = await call(CASE_CAPABILITIES.applyRollback, {
          caseId, checkpointId: required(values.checkpoint, 'checkpoint'), expectedRevision: Number(expected),
          previewToken: required(values['preview-token'], 'preview-token'), actor: values.actor,
          ...(values.note === undefined ? {} : { note: values.note }),
        });
      }
      else if (command === 'mark' || command === 'update') {
        const current = caseRecordSchema.parse(await call(CASE_CAPABILITIES.read, { caseId }));
        if (values['expected-revision'] !== undefined && !/^[1-9]\d*$/.test(values['expected-revision'])) {
          throw new Error('--expected-revision 必须为正整数。');
        }
        result = await call(CASE_CAPABILITIES.update, {
          caseId, actor: values.actor,
          expectedRevision: values['expected-revision'] === undefined ? current.revision : Number(values['expected-revision']),
          ...(values.title === undefined ? {} : { title: values.title }),
          ...(values.number === undefined ? {} : { caseNumber: values.number }),
          ...(values.description === undefined ? {} : { description: values.description }),
          ...(values.stage === undefined ? {} : { stage: values.stage }),
          ...(values.status === undefined ? {} : { status: values.status }),
          ...(values.note === undefined ? {} : { note: values.note }),
        });
      } else if (command === 'add-text') {
        if ((values.text === undefined) === (values.path === undefined)) throw new Error('--text 和 --path 请提供其中一个。');
        const text = values.path === undefined ? values.text!
          : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(values.path));
        result = await call(CASE_CAPABILITIES.registerText, {
          caseId, sourceLabel: values.label ?? (values.path ? basename(values.path) : '文字记录'), text,
        });
      } else if (command === 'add-image' || command === 'add-file') {
        const path = required(values.path, 'path');
        result = await call(command === 'add-image' ? CASE_CAPABILITIES.registerImage : CASE_CAPABILITIES.importFile, {
          caseId, path, sourceLabel: values.label ?? basename(path),
        });
      } else if (command === 'read-material' || command === 'ocr') {
        result = await call(command === 'ocr' ? CASE_CAPABILITIES.recognize : CASE_CAPABILITIES.readMaterial, {
          caseId, materialId: required(values.material, 'material'),
        });
      } else if (command === 'read-file') {
        result = await call(CASE_CAPABILITIES.readFile, { caseId, fileId: required(values['file-id'], 'file-id') });
      } else if (command === 'take-file') {
        result = await call(CASE_CAPABILITIES.exportFile, {
          caseId, fileId: required(values['file-id'], 'file-id'), destination: required(values.out, 'out'),
        });
      } else if (command === 'take-material') {
        result = await call(CASE_CAPABILITIES.exportMaterial, {
          caseId, materialId: required(values.material, 'material'), destination: required(values.out, 'out'),
        });
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { await runtime.stop(); }
}

if (import.meta.main) {
  try { await runCasesCommand(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
