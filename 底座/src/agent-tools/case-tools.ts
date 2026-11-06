import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CaseStore } from '../cases/store.ts';
import { CaseWorkspace, CaseWriteStaleError } from '../cases/workspace.ts';
import { createTesseractOcr } from '../materials/tesseract.ts';
import type { OcrAdapter } from '../materials/contracts.ts';
import { defineAgentTool, AgentToolError, type AgentTool, type AgentToolContext, type AgentToolReconciliation } from './contracts.ts';

const empty = z.strictObject({});
const materialInput = z.strictObject({ materialId: z.uuid() });
const statementInput = z.strictObject({ text: z.string().trim().min(1) });
const pathInput = z.strictObject({ path: z.string().min(1) });
const versionInput = z.strictObject({ materialId: z.uuid(), versionId: z.uuid(),
  start: z.number().int().nonnegative().default(0), maxChars: z.number().int().min(1).max(12000).default(6000) });
const receiptSchema = z.strictObject({ version: z.literal(1), caseId: z.uuid(), operationId: z.uuid(), toolId: z.string(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u), result: z.json() });
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const exists = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const requestHash = (toolId: string, value: unknown) => createHash('sha256').update(`${toolId}\n${canonical(value)}`).digest('hex');
const sourceLabel = (kind: string, context: AgentToolContext) => `${kind} [${context.operationId}]`;
const schemaOf = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string, unknown>;
function active(context: AgentToolContext): void {
  if (context.signal?.aborted) throw new AgentToolError('AGENT_CANCELLED', 'Tool execution was cancelled before saving.');
}

/** Narrow case facades. The model never receives a generic filesystem or shell tool. */
export function createCaseTools(options: { dataDir: string; ocr?: OcrAdapter }): AgentTool[] {
  const dataDir = resolve(options.dataDir), cases = new CaseStore(dataDir), workspace = new CaseWorkspace(dataDir, cases);
  const paths = (context: AgentToolContext) => {
    const root = cases.directory(context.caseId);
    return { directory: join(root, 'agent-operation-receipts'), receipt: join(root, 'agent-operation-receipts', `${context.operationId}.json`),
      lockDirectory: join(root, 'agent-operation-locks'), lock: join(root, 'agent-operation-locks', `${context.operationId}.lock`) };
  };
  const casOptions = (context: AgentToolContext) => context.expectedCaseRevision === undefined ? {} : { expectedRevision: context.expectedCaseRevision };
  async function authorizedPath(path: string, context: AgentToolContext): Promise<string> {
    const requested = await realpath(resolve(path));
    const permitted = await Promise.all((context.allowedPaths ?? []).map((entry) => realpath(resolve(entry))));
    const key = (entry: string) => process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (!permitted.some((entry) => key(entry) === key(requested))) throw new AgentToolError('TOOL_PATH_NOT_ATTACHED', 'Only a file explicitly attached to this task may be imported.');
    if (!(await stat(requested)).isFile()) throw new AgentToolError('TOOL_PATH_NOT_FILE', 'The attached path must be a file.');
    return requested;
  }
  function assertStatement(text: string, context: AgentToolContext): void {
    if (!context.userMessage.includes(text)) throw new AgentToolError('TOOL_STATEMENT_NOT_PROVIDED', 'A saved statement must be a literal excerpt from the current user message.');
  }
  async function inspect(toolId: string, input: unknown, context: AgentToolContext,
    validateResult: (result: unknown) => Promise<boolean>, findCommitted?: () => Promise<unknown | undefined>): Promise<AgentToolReconciliation> {
    await cases.read(context.caseId);
    const location = paths(context);
    try {
      const receipt = receiptSchema.parse(JSON.parse(await readFile(location.receipt, 'utf8')));
      if (receipt.caseId !== context.caseId || receipt.operationId !== context.operationId || receipt.toolId !== toolId
        || receipt.requestHash !== requestHash(toolId, input)) throw new AgentToolError('TOOL_OPERATION_MISMATCH', 'This operation ID was used for a different tool request.');
      return await validateResult(receipt.result) ? { status: 'completed', result: receipt.result }
        : { status: 'unknown', reason: 'The earlier write is outside the current case view; do not replay it after rollback.' };
    } catch (error) { if (!missing(error)) throw error; }
    const found = await findCommitted?.();
    if (found !== undefined) return { status: 'completed', result: found };
    try { await stat(location.lock); return { status: 'unknown', reason: 'A prior write started without a confirmed receipt; its outcome must be reconciled before retrying.' }; }
    catch (error) { if (!missing(error)) throw error; }
    return { status: 'not_started' };
  }
  async function perform(toolId: string, input: unknown, context: AgentToolContext,
    reconcile: () => Promise<AgentToolReconciliation>, execute: () => Promise<unknown>, preflight?: () => Promise<void>): Promise<unknown> {
    const previous = await reconcile();
    if (previous.status === 'completed') return previous.result;
    if (previous.status === 'unknown') throw new AgentToolError('TOOL_WRITE_UNCERTAIN', previous.reason ?? 'The previous write has an uncertain outcome.');
    active(context);
    const location = paths(context); await mkdir(location.lockDirectory, { recursive: true });
    let handle;
    try { handle = await open(location.lock, 'wx'); }
    catch (error) { if (exists(error)) throw new AgentToolError('TOOL_OPERATION_BUSY', 'This write operation is already running.'); throw error; }
    let started = false, confirmed = false, definitelyNotStarted = false;
    try {
      await handle.writeFile(JSON.stringify({ caseId: context.caseId, operationId: context.operationId, toolId, requestHash: requestHash(toolId, input) }));
      await handle.close(); handle = undefined;
      // Keep read-only validation under this operation's exclusive lock, but
      // before marking any possible external effect as started.
      const current = await cases.read(context.caseId);
      if (context.expectedCaseRevision !== undefined && current.revision !== context.expectedCaseRevision) {
        throw new CaseWriteStaleError();
      }
      await preflight?.();
      active(context); started = true;
      const result = await execute();
      const receipt = receiptSchema.parse({ version: 1, caseId: context.caseId, operationId: context.operationId, toolId,
        requestHash: requestHash(toolId, input), result });
      await mkdir(location.directory, { recursive: true });
      const temporary = join(location.directory, `${randomUUID()}.tmp`), temporaryHandle = await open(temporary, 'wx');
      try { await temporaryHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); } finally { await temporaryHandle.close(); }
      try { await link(temporary, location.receipt); }
      finally { await unlink(temporary).catch(() => {}); }
      confirmed = true; return result;
    } catch (error) {
      // CaseWorkspace uses this exact typed error only for its initial fence,
      // covering a case update between this preflight and the resource call.
      // A final CAS conflict, transport failure or lost acknowledgement remains
      // uncertain and must keep its marker for normal reconciliation.
      definitelyNotStarted = error instanceof CaseWriteStaleError;
      throw error;
    } finally {
      await handle?.close();
      // Uncertain in-flight writes retain a marker. A restart may inspect an
      // active material or receipt, but cannot blindly repeat an unknown write.
      if (!started || confirmed || definitelyNotStarted) await unlink(location.lock).catch(() => {});
    }
  }
  // Each imported item carries the executor's operation ID in its source label.
  // This identifies a committed result even if the process stopped before its receipt was written.
  async function materialByLabel(context: AgentToolContext, label: string) {
    const found = (await workspace.contents(context.caseId)).materials.filter((material) => material.sourceLabel === label);
    if (found.length > 1) throw new AgentToolError('TOOL_OPERATION_AMBIGUOUS', 'More than one material has this operation identifier.');
    return found[0];
  }
  async function fileByLabel(context: AgentToolContext, label: string) {
    const found = (await workspace.contents(context.caseId)).files.filter((file) => file.sourceLabel === label);
    if (found.length > 1) throw new AgentToolError('TOOL_OPERATION_AMBIGUOUS', 'More than one attachment has this operation identifier.');
    return found[0];
  }
  async function reconcileStatement(input: z.infer<typeof statementInput>, context: AgentToolContext) {
    assertStatement(input.text, context);
    const label = sourceLabel('用户补充陈述', context);
    const valid = async (candidate: unknown) => {
      if (!object(candidate) || typeof candidate.id !== 'string') return false;
      const current = await materialByLabel(context, label);
      if (!current || current.id !== candidate.id || current.original.kind !== 'text') return false;
      const view = await workspace.readVersion({ caseId: context.caseId, materialId: current.id, versionId: current.id });
      return view.version.text === input.text;
    };
    return inspect('user.statement.register', input, context, valid, async () => {
      const candidate = await materialByLabel(context, label);
      if (candidate && !await valid(candidate)) throw new AgentToolError('TOOL_OPERATION_MISMATCH', 'The committed statement differs from this request.');
      return candidate;
    });
  }
  async function reconcileImage(input: z.infer<typeof pathInput>, context: AgentToolContext) {
    const label = sourceLabel('用户图片附件', context);
    const valid = async (candidate: unknown) => object(candidate) && typeof candidate.id === 'string'
      && (await materialByLabel(context, label))?.id === candidate.id;
    return inspect('material.image.register', input, context, valid, () => materialByLabel(context, label));
  }
  async function reconcileFile(input: z.infer<typeof pathInput>, context: AgentToolContext) {
    const label = sourceLabel('用户原始附件', context);
    const valid = async (candidate: unknown) => object(candidate) && typeof candidate.id === 'string'
      && (await fileByLabel(context, label))?.id === candidate.id;
    return inspect('material.file.register', input, context, valid, () => fileByLabel(context, label));
  }
  async function reconcileOcr(input: z.infer<typeof materialInput>, context: AgentToolContext) {
    const view = await workspace.readMaterial({ caseId: context.caseId, ...input });
    if (view.material.original.kind !== 'image') throw new AgentToolError('TOOL_NOT_IMAGE', 'OCR requires a registered image material.');
    return inspect('image.ocr', input, context, async (candidate) => object(candidate) && typeof candidate.id === 'string'
      && view.ocrAttempts.some((attempt) => attempt.id === candidate.id && attempt.materialId === input.materialId));
  }
  return [
    defineAgentTool({ id: 'case.overview', version: 1, description: '查看当前案件资料与人工办理进度。', effect: 'read',
      input: empty, inputSchema: schemaOf(empty), execute: async (_, context) => cases.read(context.caseId) }),
    defineAgentTool({ id: 'case.materials', version: 1, description: '列出当前案件的材料、附件及明确可选的文字版本，不自动选择最新版本。', effect: 'read',
      input: empty, inputSchema: schemaOf(empty), execute: async (_, context) => {
        const contents = await workspace.contents(context.caseId);
        const materials = await Promise.all(contents.materials.map(async (material) => ({ ...material,
          versions: (await workspace.listVersions({ caseId: context.caseId, materialId: material.id })).map((version) => ({
            id: version.id, kind: version.kind, createdAt: version.createdAt, textSha256: version.textSha256,
          })),
        })));
        return { caseId: context.caseId, materials, files: contents.files };
      } }),
    defineAgentTool({ id: 'material.read', version: 1, description: '读取当前案件中明确指定的材料文字版本；长文按范围返回，hasMore明确说明是否仍有未读部分。', effect: 'read',
      input: versionInput, inputSchema: schemaOf(versionInput), execute: async (input, context) => {
        const { version, material } = await workspace.readVersion({ caseId: context.caseId, materialId: input.materialId, versionId: input.versionId });
        if (input.start > version.text.length) throw new AgentToolError('TOOL_RANGE_INVALID', 'The requested start is past the end of the text.');
        let start = input.start, end = Math.min(start + input.maxChars, version.text.length);
        const split = (offset: number) => version.text.charCodeAt(offset - 1) >= 0xd800 && version.text.charCodeAt(offset - 1) <= 0xdbff
          && version.text.charCodeAt(offset) >= 0xdc00 && version.text.charCodeAt(offset) <= 0xdfff;
        if (split(start)) start -= 1; if (split(end)) end += 1;
        return { caseId: context.caseId, materialId: material.id, versionId: version.id, sourceLabel: material.sourceLabel,
          textSha256: version.textSha256, start, end, totalChars: version.text.length, hasMore: end < version.text.length, text: version.text.slice(start, end) };
      } }),
    defineAgentTool({ id: 'user.statement.register', version: 1, description: '将用户本轮明确补充的案情原话登记为陈述材料。text须是用户输入中的逐字摘录，不得替用户编造或改写。', effect: 'write',
      input: statementInput, inputSchema: schemaOf(statementInput), reconcile: reconcileStatement,
      execute: (input, context) => perform('user.statement.register', input, context, () => reconcileStatement(input, context), async () => {
        assertStatement(input.text, context);
        return workspace.registerText({ caseId: context.caseId, sourceLabel: sourceLabel('用户补充陈述', context), text: input.text }, casOptions(context));
      }) }),
    defineAgentTool({ id: 'material.image.register', version: 1, description: '登记用户明确附加的PNG/JPEG照片，保留原图；路径必须来自本任务的附件清单。', effect: 'write',
      input: pathInput, inputSchema: schemaOf(pathInput), reconcile: reconcileImage,
      execute: (input, context) => {
        let path: string;
        return perform('material.image.register', input, context, () => reconcileImage(input, context), async () =>
          workspace.registerImage({ caseId: context.caseId, sourceLabel: sourceLabel('用户图片附件', context), path }, casOptions(context)),
        async () => { path = await authorizedPath(input.path, context); });
      } }),
    defineAgentTool({ id: 'material.file.register', version: 1, description: '保存用户明确附加的原始文件；PDF/Word等先原样保存，不据此声称已解析其内容。', effect: 'write',
      input: pathInput, inputSchema: schemaOf(pathInput), reconcile: reconcileFile,
      execute: (input, context) => {
        let path: string;
        return perform('material.file.register', input, context, () => reconcileFile(input, context), async () =>
          workspace.importFile({ caseId: context.caseId, sourceLabel: sourceLabel('用户原始附件', context), path }, casOptions(context)),
        async () => { path = await authorizedPath(input.path, context); });
      } }),
    defineAgentTool({ id: 'image.ocr', version: 1, description: '对当前案件的一张已登记图片执行OCR，保留识别结果和失败记录，识别文字仍须核对。', effect: 'write',
      input: materialInput, inputSchema: schemaOf(materialInput), reconcile: reconcileOcr,
      execute: (input, context) => perform('image.ocr', input, context, () => reconcileOcr(input, context), async () => {
        const ocr = options.ocr ?? createTesseractOcr({ cachePath: join(dataDir, 'ocr-cache') });
        try { active(context); return await workspace.recognize({ caseId: context.caseId, ...input }, ocr, casOptions(context)); }
        finally { if (!options.ocr) await ocr.close(); }
      }) }),
  ];
}
