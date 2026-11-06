import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CaseRollback } from '../../../底座/src/cases/rollback.ts';
import { CaseStore } from '../../../底座/src/cases/store.ts';
import { CaseWorkspace } from '../../../底座/src/cases/workspace.ts';
import { createDeepSeekModel, loadDeepSeekConfig } from '../../../底座/src/information/deepseek.ts';
import { organizeCaseInformation } from '../../../底座/src/information/service.ts';
import { LoopRunStore } from '../../../底座/src/loops/store.ts';
import { createTesseractOcr } from '../../../底座/src/materials/tesseract.ts';
import { buildNodeReview, nodeReviewKindSchema } from '../../../底座/src/node-review/index.ts';
import { createCaseOutput, listCaseOutputs, readCaseOutput } from '../../../底座/src/outputs/store.ts';
import { createLaborPlugin } from '../../../劳动法插件/src/index.ts';
import {
  attachment, authorize, bufferResponse, enableStreaming, errorResponse, json, MAX_TEXT_LENGTH, MAX_UPLOAD_BYTES,
  readJson, RequestError, requestPath, serveStatic, UPLOAD_EXTENSIONS,
} from './http.mjs';
import { loadHostedAccess } from './hosted.mjs';
import { attachmentType, saveUpload } from './uploads.mjs';

const { z } = createRequire(new URL('../../../底座/package.json', import.meta.url))('zod');
const APP = fileURLToPath(new URL('..', import.meta.url));
const ACTOR = '网页承办人';
const uuid = z.uuid().transform((id) => id.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const label = z.string().trim().min(1).max(200);
const versionText = z.string().max(MAX_TEXT_LENGTH).refine((text) => text.isWellFormed() && !text.includes('\u0000'));
const originalText = versionText.refine((text) => text.trim().length > 0);
const revisionNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const caseFields = z.strictObject({
  title: label,
  caseNumber: label.optional(),
  description: z.string().max(8000).optional(),
  stage: label.max(100).optional(),
});
const casePatch = caseFields.partial().extend({
  caseNumber: label.nullable().optional(),
  expectedRevision: revisionNumber,
  status: z.enum(['active', 'paused', 'closed']).optional(),
  note: z.string().max(1000).optional(),
});
const uploadRequest = z.union([
  z.strictObject({ sourceLabel: label, text: originalText }),
  z.strictObject({ sourceLabel: label, fileName: z.string().min(1).max(180),
    base64: z.string().min(1).max(4 * Math.ceil(MAX_UPLOAD_BYTES / 3)) }),
]);
const saveRevisionRequest = z.strictObject({
  baseVersionId: uuid, baseTextSha256: hash, text: versionText, note: z.string().max(1000).optional(),
});
const intakeRequest = z.strictObject({
  goal: label.max(200).optional(), consent: z.boolean().optional(), reuseRunId: uuid.optional(),
  selections: z.array(z.strictObject({ materialId: uuid, versionId: uuid })).min(1).max(100).optional(),
  sourceKinds: z.record(uuid, z.enum(['party_statement', 'document_record'])).optional(),
});
const nodeRequest = z.strictObject({ baselineRunId: uuid, currentRunId: uuid, kind: nodeReviewKindSchema });
const outputRequest = z.strictObject({
  runId: uuid, previousOutputId: uuid.optional(), nodeReviewKind: nodeReviewKindSchema.optional(), baselineRunId: uuid.optional(),
});
const checkpointRequest = z.strictObject({ label });
const rollbackPreviewRequest = z.strictObject({ checkpointId: uuid });
const rollbackRequest = rollbackPreviewRequest.extend({ expectedRevision: revisionNumber, previewToken: hash, note: z.string().max(1000).optional() });
const OUTPUT_TYPES = {
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const emptyRequest = z.strictObject({});

function missing() {
  return new RequestError(404, 'NOT_FOUND', '找不到请求的页面或记录。');
}

function currentVersions(versions) {
  const parents = new Set(versions.flatMap((version) => version.kind === 'revision' ? [version.baseVersionId] : []));
  return versions.filter((version) => !parents.has(version.id));
}

function publicAttempt(attempt) {
  return attempt.status === 'failed'
    ? { ...attempt, error: { code: attempt.error.code, message: attempt.error.code === 'NO_TEXT'
      ? '未识别出可读文字。' : '图片识别失败。请检查图片和本地 OCR 语言包后再试。' } }
    : attempt;
}

async function selectSources(workspace, contents, requested, exactScope = false) {
  const explicit = new Map(requested?.map((item) => [item.materialId, item.versionId]) ?? []);
  if ((requested && explicit.size !== requested.length)
    || [...explicit.keys()].some((id) => !contents.materials.some((material) => material.id === id))) {
    throw new RequestError(400, 'INVALID_SELECTION', '每份材料只能指定一个当前文字版本，且必须属于本案。');
  }
  const sources = [];
  const unreadMaterialIds = [];
  for (const material of contents.materials) {
    const leaves = currentVersions(await workspace.listVersions({ caseId: contents.case.id, materialId: material.id }));
    const selection = explicit.get(material.id);
    if (leaves.length === 0 && !selection) {
      unreadMaterialIds.push(material.id);
      continue;
    }
    if (exactScope && !selection) {
      throw new RequestError(409, 'MATERIAL_SELECTION_CHANGED', '有新增的可读材料。请刷新材料范围，再确认本次提交。');
    }
    const version = selection ? leaves.find((item) => item.id === selection) : leaves.length === 1 ? leaves[0] : undefined;
    if (!version) {
      throw new RequestError(409, 'VERSION_SELECTION_REQUIRED', '材料有多个文字分支或已更新，请指定当前版本再整理。');
    }
    sources.push({ materialId: material.id, versionId: version.id, textSha256: version.textSha256 });
  }
  return { sources, unreadMaterialIds };
}

async function createCaseRouter({ dataDir, model, imageReader, requireModelConsent, plugin, actor, maxUploadBytes }) {
  const cases = new CaseStore(dataDir);
  await cases.initialize();
  const workspace = new CaseWorkspace(dataDir, cases);
  const rollback = new CaseRollback(cases, workspace);
  const runs = new LoopRunStore(dataDir, cases);
  const profile = plugin.profiles?.find((item) => item.id === 'labor.intake');
  const reviewer = plugin.reviewers?.find((item) => item.profileId === profile?.id) ?? plugin.reviewers?.[0];
  if (!profile || !reviewer) throw new Error('The labor intake profile and reviewer are required.');
  const pending = new Set();

  async function writeCase(caseId, operation) {
    if (pending.has(caseId)) {
      throw new RequestError(409, 'CASE_BUSY', '本案正在处理另一项操作。完成后再试。');
    }
    pending.add(caseId);
    try { return await operation(); }
    finally { pending.delete(caseId); }
  }

  async function intake(caseId, input, signal) {
    if (!model) throw new RequestError(503, 'MODEL_NOT_CONFIGURED', '请在本机底座的 .env.local 中配置 DeepSeek 并重启工作台。');
    if (requireModelConsent && !input.consent) {
      throw new RequestError(400, 'MODEL_CONSENT_REQUIRED', '确认可将所选材料文字发往已配置的模型后再整理。');
    }
    if (requireModelConsent && !input.selections) {
      throw new RequestError(400, 'MODEL_SCOPE_REQUIRED', '请确认本次提交给模型的材料和文字版本。');
    }
    const contents = await workspace.contents(caseId);
    const { sources } = await selectSources(workspace, contents, input.selections, Boolean(input.selections));
    if (!sources.length) throw new RequestError(422, 'NO_TEXT_MATERIALS', '请先添加文字材料或对图片执行 OCR。');
    if (sources.length > 100) throw new RequestError(422, 'MATERIAL_LIMIT', '一次整理最多支持 100 份文字材料。');
    return organizeCaseInformation({
      dataDir, caseId, model, reviewer, signal, allowPartialReads: true, reuseRunId: input.reuseRunId,
      plan: {
        goal: input.goal ?? '劳动争议接案与材料整理',
        selections: sources.map(({ materialId, versionId }) => ({ materialId, versionId })),
        sourceKinds: input.sourceKinds, needs: profile.needs, readingMode: profile.readingMode ?? 'batch',
        limits: { maxRounds: 4, maxReads: Math.max(12, sources.length) }, maxModelCalls: 96,
      },
    });
  }

  async function reviewNode(caseId, input) {
    const [baseline, current, contents] = await Promise.all([
      runs.read({ caseId, runId: input.baselineRunId }), runs.read({ caseId, runId: input.currentRunId }),
      workspace.contents(caseId),
    ]);
    let scope;
    try { scope = await selectSources(workspace, contents, current.sources); }
    catch (error) {
      if (error instanceof RequestError) throw new RequestError(409, 'AGENT_OUTPUT_STALE', '材料或版本已变化，请按当前材料重新整理。');
      throw error;
    }
    return buildNodeReview({
      kind: input.kind, baseline, current, currentScope: scope.sources, unreadMaterialIds: scope.unreadMaterialIds,
      unparsedAttachmentIds: contents.files.map((file) => file.id), contribute: plugin.contributeNodeReview,
    });
  }

  async function createOutput(caseId, input, signal) {
    const run = await runs.read({ caseId, runId: input.runId });
    const scope = { dataDir, caseId };
    let previousOutputId = input.previousOutputId;
    if (input.baselineRunId && previousOutputId) {
      const previous = await readCaseOutput({ ...scope, outputId: previousOutputId });
      if (previous?.manifest.runId !== input.baselineRunId) {
        throw new RequestError(400, 'OUTPUT_BASELINE_MISMATCH', '选择的基线整理与上一版底稿不一致。');
      }
    }
    if (input.nodeReviewKind && input.baselineRunId && !previousOutputId) {
      const review = await reviewNode(caseId, { baselineRunId: input.baselineRunId, currentRunId: run.id, kind: input.nodeReviewKind });
      if (review.scope.missingSources.length || review.scope.unexpectedSources.length) {
        throw new RequestError(409, 'AGENT_OUTPUT_STALE', '材料或版本已变化，请按当前材料重新整理。');
      }
      const outputs = await listCaseOutputs(scope);
      previousOutputId = outputs.find(({ runId }) => runId === input.baselineRunId)?.outputId;
      if (!previousOutputId) {
        const baseline = await runs.read({ caseId, runId: input.baselineRunId });
        const record = await cases.read(caseId);
        const manifest = await createCaseOutput({
          ...scope, runId: baseline.id, signal, expectedRevision: record.revision,
          sections: await plugin.contributeOutput?.(baseline),
        });
        previousOutputId = manifest.outputId;
      }
    }
    const record = await cases.read(caseId);
    const sections = await plugin.contributeOutput?.(run);
    return createCaseOutput({
      ...scope, runId: run.id, previousOutputId,
      node: input.nodeReviewKind, sections, signal, expectedRevision: record.revision,
      requireCurrentSources: true, contributeNodeReview: plugin.contributeNodeReview,
    });
  }

  async function materialRoute(req, res, method, caseId, parts) {
    if (!parts.length && method === 'POST') {
      const input = await readJson(req, uploadRequest);
      if ('base64' in input && Buffer.byteLength(input.base64, 'base64') > maxUploadBytes) {
        throw new RequestError(413, 'UPLOAD_TOO_LARGE', '单份文件超过当前工作台的上传上限。');
      }
      return json(res, await writeCase(caseId, () => saveUpload(workspace, caseId, input)), 201);
    }
    const [id, action, version, ...tail] = parts;
    if (!id || tail.length) throw missing();
    const materialId = uuid.parse(id);
    const scope = { caseId, materialId };
    if (!action && method === 'GET') {
      const [{ material, text, ocrAttempts }, versions] = await Promise.all([
        workspace.readMaterial(scope), workspace.listVersions(scope),
      ]);
      return json(res, { material, text, ocrAttempts: ocrAttempts.map(publicAttempt), versions,
        originalUrl: '/api/cases/' + caseId + '/materials/' + materialId + '/original' });
    }
    if (action === 'original' && !version && method === 'GET') {
      const { material, originalPath } = await workspace.readMaterial(scope);
      return attachment(res, await readFile(originalPath), material.original.file, material.original.mediaType,
        { inline: material.original.kind === 'image' });
    }
    if (action === 'versions' && version && method === 'GET') {
      const result = await workspace.readVersion({ ...scope, versionId: uuid.parse(version) });
      return json(res, { material: result.material, version: result.version });
    }
    if (action === 'ocr' && !version && method === 'POST') {
      await readJson(req, emptyRequest, { optional: true });
      const attempt = await writeCase(caseId, async () => {
        const { material } = await workspace.readMaterial(scope);
        if (material.original.kind !== 'image') {
          throw new RequestError(422, 'IMAGE_REQUIRED', 'OCR 适用于图片材料。');
        }
        if ((await workspace.listVersions(scope)).length) {
          throw new RequestError(409, 'OCR_ALREADY_SAVED', '已有文字版本，可直接核对和修订。');
        }
        return workspace.recognize(scope, imageReader);
      });
      return json(res, publicAttempt(attempt), 201);
    }
    if (action === 'revisions' && !version && method === 'POST') {
      const input = await readJson(req, saveRevisionRequest);
      const saved = await writeCase(caseId, async () => {
        const leaf = currentVersions(await workspace.listVersions(scope)).find((item) => item.id === input.baseVersionId);
        if (!leaf || leaf.textSha256 !== input.baseTextSha256) {
          throw new RequestError(409, 'STALE_TEXT_VERSION', '当前文字版本已变化。请切换到最新版本后再修改。');
        }
        return workspace.saveRevision({ ...scope, ...input, editor: actor });
      });
      return json(res, saved, 201);
    }
    throw missing();
  }

  async function caseRoute(req, res, method, parts, signal, { uploadParts, stagedUploads } = {}) {
    if (parts.length === 0) {
      if (method === 'GET') {
        const { cases: records, unavailable } = await cases.list();
        return json(res, { cases: records,
          unavailable: unavailable.map(({ caseId }) => ({ caseId, reason: '无法读取本地案件记录。' })) });
      }
      if (method === 'POST') return json(res, await cases.create({ ...await readJson(req, caseFields), actor }), 201);
      throw missing();
    }
    const [id, resource, ...tail] = parts;
    const caseId = uuid.parse(id);
    if (resource === 'upload-parts' && uploadParts && method === 'POST' && tail.length === 1) {
      await cases.read(caseId);
      const { input, cleanup } = await uploadParts.assemble({ req, caseId, uploadId: tail[0], account: actor, signal });
      stagedUploads.push(cleanup);
      const result = await saveUpload(workspace, caseId, uploadRequest.parse(input));
      return json(res, result, 201);
    }
    if (resource === undefined) {
      if (method === 'GET') return json(res, await workspace.contents(caseId));
      if (method === 'PATCH') {
        const input = await readJson(req, casePatch);
        return json(res, await writeCase(caseId, () => cases.update({ ...input, caseId, actor })));
      }
    }
    if (resource === 'materials') return materialRoute(req, res, method, caseId, tail);
    if (resource === 'sources' && !tail.length && method === 'GET') {
      const contents = await workspace.contents(caseId);
      const materials = [];
      for (const { id: materialId, sourceLabel } of contents.materials) {
        const versions = currentVersions(await workspace.listVersions({ caseId, materialId }))
          .map(({ id, kind, createdAt, note }) => ({ id, kind, createdAt, note }));
        materials.push({ materialId, sourceLabel, versions });
      }
      return json(res, { materials, caseRevision: contents.case.revision });
    }
    if (resource === 'files' && tail.length === 2 && tail[1] === 'original' && method === 'GET') {
      const { file, originalPath } = await workspace.readFile({ caseId, fileId: uuid.parse(tail[0]) });
      return attachment(res, await readFile(originalPath), file.fileName, attachmentType(file.fileName));
    }
    if (resource === 'runs') {
      if (method === 'GET' && tail.length === 1) return json(res, await runs.read({ caseId, runId: uuid.parse(tail[0]) }));
      if (method === 'GET' && !tail.length) {
        const { workspace: state } = await cases.readState(caseId);
        const list = await Promise.all((state?.loopRuns ?? []).map(({ runId }) => runs.read({ caseId, runId })));
        return json(res, { runs: list });
      }
      if (method === 'POST' && !tail.length) {
        const input = await readJson(req, intakeRequest, { optional: true });
        return json(res, await writeCase(caseId, () => intake(caseId, input, signal)), 201);
      }
    }
    if (resource === 'node-reviews' && !tail.length && method === 'POST') {
      return json(res, await reviewNode(caseId, await readJson(req, nodeRequest)));
    }
    if (resource === 'outputs') {
      if (!tail.length && method === 'GET') return json(res, { outputs: await listCaseOutputs({ dataDir, caseId }) });
      if (!tail.length && method === 'POST') {
        const input = await readJson(req, outputRequest);
        return json(res, await writeCase(caseId, () => createOutput(caseId, input, signal)), 201);
      }
      if (method === 'GET' && tail.length >= 1 && tail.length <= 2) {
        const [id, format] = tail;
        if (format && !Object.hasOwn(OUTPUT_TYPES, format)) throw missing();
        const { paths, ...result } = await readCaseOutput({ dataDir, caseId, outputId: uuid.parse(id) });
        if (!format) return json(res, result);
        return attachment(res, await readFile(paths[format]), '案卷底稿.' + format, OUTPUT_TYPES[format]);
      }
    }
    if (resource === 'checkpoints' && !tail.length) {
      if (method === 'GET') return json(res, { checkpoints: await rollback.listCheckpoints(caseId) });
      if (method === 'POST') {
        const input = await readJson(req, checkpointRequest);
        return json(res, await writeCase(caseId, () => rollback.createCheckpoint({ ...input, caseId, actor })), 201);
      }
    }
    if (resource === 'rollback' && method === 'POST') {
      if (tail.length === 1 && tail[0] === 'preview') {
        return json(res, await rollback.preview({ ...await readJson(req, rollbackPreviewRequest), caseId }));
      }
      if (!tail.length) {
        const input = await readJson(req, rollbackRequest);
        return json(res, await writeCase(caseId, () => rollback.apply({ ...input, caseId, actor })));
      }
    }
    if (resource === 'history' && method === 'GET' && !tail.length) return json(res, { events: await cases.history(caseId) });
    throw missing();
  }

  return caseRoute;
}

/** Shared local and platform handler over the same file-backed case services. */
export async function createWorkbenchHandler({
  dataDir = join(APP, 'runtime-data'), staticRoot = join(APP, 'public'), model,
  ocr, ocrOptions, requireModelConsent = false, plugin = createLaborPlugin(), hosted,
  openWorkspace, platformProxy = false, uploadParts, pathOf = requestPath, publicDemo = false,
} = {}) {
  if ((platformProxy || openWorkspace) && (!hosted || typeof openWorkspace !== 'function')) {
    throw new Error('Platform hosting requires authentication and durable workspace storage.');
  }
  dataDir = resolve(dataDir);
  const imageReader = ocr ?? createTesseractOcr({ cachePath: join(dataDir, 'ocr-cache'), ...ocrOptions });
  const maxUploadBytes = publicDemo ? 2 * 1024 * 1024 : MAX_UPLOAD_BYTES;
  const routerOptions = { model, imageReader, requireModelConsent: Boolean(hosted) || requireModelConsent, plugin, maxUploadBytes };
  const localRouter = hosted ? undefined : await createCaseRouter({ ...routerOptions, dataDir, actor: ACTOR });
  const accountRouters = new Map();

  async function routerFor(account) {
    if (!hosted) return localRouter;
    if (!accountRouters.has(account)) {
      const router = createCaseRouter({
        ...routerOptions, dataDir: join(dataDir, 'accounts', account), actor: account,
      }).catch((error) => {
        accountRouters.delete(account);
        throw error;
      });
      accountRouters.set(account, router);
    }
    return accountRouters.get(account);
  }

  async function routeCase(req, res, method, parts, signal, account) {
    if (!openWorkspace) {
      const caseRoute = await routerFor(account);
      return caseRoute(req, res, method, parts, signal);
    }
    const [id, resource, uploadId, partIndex, ...tail] = parts;
    if (uploadParts && method === 'POST' && resource === 'upload-parts' && uploadId && partIndex && !tail.length) {
      return uploadParts.stage({ req, res, caseId: uuid.parse(id), uploadId, partIndex, account, signal });
    }
    const workspace = await openWorkspace(account, { signal });
    const stagedUploads = [];
    try {
      const caseRoute = await createCaseRouter({ ...routerOptions, dataDir: workspace.dataDir, actor: account });
      const preview = method === 'POST' && (resource === 'node-reviews' || (resource === 'rollback' && uploadId === 'preview'));
      if (method === 'GET' || preview) return await caseRoute(req, res, method, parts, signal);

      const pendingResponse = bufferResponse();
      await caseRoute(req, pendingResponse, method, parts, signal, { uploadParts, stagedUploads });
      if (pendingResponse.status < 200 || pendingResponse.status >= 300 || !pendingResponse.status) {
        throw new Error('Case mutation did not prepare a success response.');
      }
      if (signal.aborted) return;
      await workspace.commit();
      if (!signal.aborted) return await pendingResponse.flush(res);
    } finally {
      // Cleanup cannot invalidate a durable commit or replace an already transmitted reply.
      for (const clean of stagedUploads) await clean().catch(() => {});
      await workspace.close().catch(() => {});
    }
  }

  async function handle(req, res, port) {
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const path = pathOf(req);
      authorize(req, res, port, hosted?.origin, { platformProxy, path });
      const account = hosted ? await hosted.authenticate(req, res, path, controller.signal) : undefined;
      if (platformProxy) enableStreaming(res);
      const method = req.method;
      if (method === 'GET' && path === '/api/config') {
        return json(res, { modelConfigured: Boolean(model), acceptedUploads: UPLOAD_EXTENSIONS, maxUploadBytes,
          ...(publicDemo && { publicDemo: true }),
          ...(uploadParts && { uploadPartBytes: uploadParts.partBytes }),
        });
      }
      if (path === '/api/cases' || path.startsWith('/api/cases/')) {
        const parts = path.slice('/api/cases'.length).split('/').slice(1);
        if (parts.some((part) => !part)) throw missing();
        return await routeCase(req, res, method, parts, controller.signal, account);
      }
      if (method === 'GET' && await serveStatic(res, staticRoot, path)) return;
      throw missing();
    } catch (error) {
      errorResponse(res, error);
    }
  }
  return { handle, close: () => imageReader.close() };
}

export async function createWorkbenchServer(options) {
  const { handle, close } = await createWorkbenchHandler(options);
  const server = createServer({ requestTimeout: 30_000 }, (req, res) => handle(req, res, server.address()?.port));
  server.once('close', () => { void close().catch(() => {}); });
  return server;
}

async function start() {
  try { process.loadEnvFile(fileURLToPath(new URL('../../../底座/.env.local', import.meta.url))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rawPort = process.env.LAW_WEB_PORT ?? '8787';
  if (!/^\d{1,5}$/u.test(rawPort) || Number(rawPort) > 65_535) throw new Error('Invalid LAW_WEB_PORT.');
  const hosted = await loadHostedAccess().catch((error) => {
    process.stderr.write(error.message + '\n');
    throw error;
  });
  let model;
  if (process.env.DEEPSEEK_API_KEY) {
    try { model = createDeepSeekModel(loadDeepSeekConfig()); }
    catch { process.stderr.write('DeepSeek 配置不可用，请检查底座 .env.local 后重启。\n'); }
  }
  const server = await createWorkbenchServer({
    dataDir: process.env.LAW_WEB_DATA_DIR || undefined, model, requireModelConsent: true, hosted,
  });
  server.on('error', (error) => {
    process.stderr.write(error.code === 'EADDRINUSE'
      ? '工作台端口已占用。请关闭占用程序或设置 LAW_WEB_PORT。\n'
      : '工作台无法启动。请检查本地端口和数据目录。\n');
    process.exitCode = 1;
  });
  server.listen(Number(rawPort), '127.0.0.1', () => {
    process.stdout.write('案卷工作台 ' + (hosted?.origin.origin ?? 'http://127.0.0.1:' + server.address().port) + '\n');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  start().catch(() => { process.stderr.write('工作台启动失败。请检查本地配置和数据目录。\n'); process.exitCode = 1; });
}
