import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeepSeekModel, loadDeepSeekConfig } from '../../../../底座/src/information/deepseek.ts';
import { errorResponse, RequestError, requestPath } from '../../server/http.mjs';
import { loadVercelHostedAccess, vercelPublicOrigin } from '../../server/hosted.mjs';
import { createWorkbenchHandler } from '../../server/index.mjs';
import { createBlobWorkspace } from '../workspace.mjs';
import { createUploadParts } from '../upload-parts.mjs';
import { createPublicDemoAccess } from '../public-demo.mjs';

export function vercelRequestPath(req) {
  const original = requestPath(req);
  if (original !== '/api/workbench') return original;
  const query = req.url.slice(original.length + 1);
  const paths = new URLSearchParams(query).getAll('__workbench_path');
  if (paths.length !== 1 || !/^\/[A-Za-z0-9/_.-]{0,1023}$/u.test(paths[0])) {
    throw new RequestError(400, 'INVALID_PATH', '请求路径无效。');
  }
  return requestPath({ url: paths[0] });
}

export async function createVercelHandler({ env = process.env, blob, model, ocr } = {}) {
  // New Vercel stores supply an ID for SDK-managed OIDC. Leave the
  // short-lived credential to the SDK so it can rotate automatically.
  const token = env.BLOB_STORE_ID ? undefined : env.BLOB_READ_WRITE_TOKEN;
  if (!env.BLOB_STORE_ID && !token) throw new Error('云部署需要配置专用的私有 Blob 存储。');
  blob ??= await import('@vercel/blob');
  const prefix = env.LAW_WEB_BLOB_PREFIX ?? 'law-workbench/v1';
  const demo = env.LAW_WEB_PUBLIC_DEMO_SECRET;
  const hosted = demo === undefined ? loadVercelHostedAccess(env)
    : createPublicDemoAccess({ origin: vercelPublicOrigin(env), secret: demo, blob, token, prefix });
  const configuredModel = model ?? (env.DEEPSEEK_API_KEY ? createDeepSeekModel({
    ...loadDeepSeekConfig(env), ...(demo !== undefined && { maxRetries: 0 }),
  }) : undefined);
  const activeModel = demo === undefined || !configuredModel ? configuredModel : {
    ...configuredModel,
    async complete(input) {
      await hosted.reserveModelCall(input.signal);
      return configuredModel.complete(input);
    },
  };
  return createWorkbenchHandler({
    hosted, platformProxy: true, pathOf: vercelRequestPath, publicDemo: demo !== undefined,
    dataDir: join(tmpdir(), 'law-workbench-runtime'),
    openWorkspace: createBlobWorkspace({ blob, token, prefix, ...(demo !== undefined && { snapshotLimit: 8 * 1024 * 1024 }) }),
    uploadParts: demo === undefined ? createUploadParts({ blob, token, prefix }) : undefined,
    model: activeModel,
    ocr,
  });
}

let handler;

export default async function workbench(req, res) {
  try {
    handler ??= createVercelHandler();
    const { handle } = await handler;
    await handle(req, res);
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    errorResponse(res, new RequestError(503, 'DEPLOYMENT_NOT_READY', '工作台暂未完成服务器配置。'));
  }
}
