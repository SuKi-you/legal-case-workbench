import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 300_000;
export const UPLOAD_EXTENSIONS = ['.txt', '.png', '.jpg', '.jpeg', '.pdf', '.docx'];
const MAX_BODY = 4 * Math.ceil(MAX_UPLOAD_BYTES / 3) + 8192;
const streamingResponses = new WeakSet();
const streamingThreshold = 1024 * 1024;
const chunkSize = 128 * 1024;
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(res, data, status = 200) {
  return send(res, JSON.stringify(data), 'application/json; charset=utf-8', status);
}

function send(res, data, contentType, status = 200) {
  const length = Buffer.byteLength(data);
  if (length > streamingThreshold && streamingResponses.has(res)) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    res.writeHead(status, { 'Content-Type': contentType });
    const chunks = function* () {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        yield bytes.subarray(offset, offset + chunkSize);
      }
    };
    return pipeline(Readable.from(chunks()), res);
  }
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': length });
  res.end(data);
}

export function enableStreaming(res) {
  streamingResponses.add(res);
}

/** Prepare a response without exposing success until durable storage accepts the write. */
export function bufferResponse() {
  let status;
  let contentType;
  let data;
  const headers = new Map();
  return {
    get status() { return status; },
    setHeader(name, value) { headers.set(name, value); },
    writeHead(code, responseHeaders) {
      status = code;
      contentType = responseHeaders['Content-Type'];
    },
    end(value) { data = value; },
    flush(res) {
      for (const [name, value] of headers) res.setHeader(name, value);
      return send(res, data, contentType, status);
    },
  };
}

export function authorize(req, res, port, publicOrigin, { platformProxy = false, path } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "img-src 'self' blob: data:", "style-src 'self' 'unsafe-inline'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '));
  const host = req.headers.host;
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
  if (publicOrigin) {
    if ((!platformProxy && !loopback) || host?.toLowerCase() !== publicOrigin.host || req.headers['x-forwarded-proto'] !== 'https') {
      throw new RequestError(403, 'PUBLIC_ORIGIN_REQUIRED', '请通过工作台配置的 HTTPS 地址访问。');
    }
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  } else if (!loopback || !['127.0.0.1', 'localhost', '[::1]']
    .map((name) => port === 80 ? name : name + ':' + port).includes(host?.toLowerCase())) {
    throw new RequestError(403, 'LOCAL_HOST_REQUIRED', '请从本机地址打开案卷工作台。');
  }
  // A user opening a shared home-page link is navigating, not invoking the case API.
  const externalEntry = publicOrigin && req.method === 'GET' && (path ?? req.url?.split('?', 1)[0]) === '/'
    && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
  const origin = req.headers.origin;
  if ((origin !== undefined && origin !== (publicOrigin?.origin ?? 'http://' + host))
    || (!externalEntry && ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']))) {
    throw new RequestError(403, 'CROSS_ORIGIN', '当前请求来自其他站点。');
  }
}

export function requestPath(req) {
  const target = req.url?.split('?', 1)[0] ?? '';
  if (!target.startsWith('/') || target.startsWith('//') || /[%\\]/u.test(target)
    || target.split('/').some((part) => part === '.' || part === '..')) {
    throw new RequestError(400, 'INVALID_PATH', '请求路径无效。');
  }
  return target;
}

export async function readJson(req, schema, { optional = false } = {}) {
  const type = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  const empty = req.headers['transfer-encoding'] === undefined && !Number(req.headers['content-length']);
  if (optional && empty) return schema.parse({});
  if (type !== 'application/json') throw new RequestError(415, 'JSON_REQUIRED', '请求须使用 JSON。');
  if (Number(req.headers['content-length']) > MAX_BODY) {
    throw new RequestError(413, 'UPLOAD_TOO_LARGE', '单份材料不得超过 15 MB。');
  }
  const buffers = [];
  let size = 0;
  for await (const buffer of req.iterator({ destroyOnReturn: false })) {
    size += buffer.length;
    if (size > MAX_BODY) {
      throw new RequestError(413, 'UPLOAD_TOO_LARGE', '单份材料不得超过 15 MB。');
    }
    buffers.push(buffer);
  }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers))); }
  catch { throw new RequestError(400, 'INVALID_JSON', '请求内容须为有效的 UTF-8 JSON。'); }
  return schema.parse(data);
}

export function attachment(res, data, name, type, { inline = false } = {}) {
  const encoded = encodeURIComponent(name).replace(/['()*]/gu, (char) => '%' + char.charCodeAt(0).toString(16));
  res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encoded);
  return send(res, data, type);
}

export async function serveStatic(res, root, path) {
  const relative = path === '/' ? 'index.html' : path.slice(1);
  const extension = /\.[a-z0-9]+$/u.exec(relative)?.[0];
  if (!Object.hasOwn(STATIC_TYPES, extension)
    || (!['index.html', 'app.js', 'styles.css', 'paper-link.js', 'favicon.svg'].includes(relative)
      && !/^assets\/[a-zA-Z0-9_-]+\.(?:svg|png|jpg|webp|woff2)$/u.test(relative))) return false;
  let bytes;
  try { bytes = await readFile(join(root, relative)); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await send(res, bytes, STATIC_TYPES[extension]);
  return true;
}

const validation = {
  CASE_REVISION_CONFLICT: [409, '案件已更新。刷新后再进行操作。'],
  CASE_WORKSPACE_CHANGED: [409, '案件已恢复到其他保存点。刷新后再进行操作。'],
  CASE_VERSION_CHANGED: [409, '当前材料的文字版本已变化，请刷新后核对。'],
  AGENT_OUTPUT_STALE: [409, '材料或文字版本已变化，请按当前材料重新整理。'],
  OUTPUT_STALE: [409, '保存期间案件已变化，请刷新后重新生成。'],
  OUTPUT_NODE_BASELINE_REQUIRED: [400, '请选择上一版接案底稿作为基线。'],
  NODE_REVIEW_RUN_INVALID: [400, '请选同一案件的较早整理为基线，庭前准备可使用同一次整理。'],
  INFORMATION_MODEL_BUDGET: [422, '本次整理达到模型调用上限。请分批核对或使用已保存的整理复用结果。'],
  INFORMATION_CANCELLED: [409, '整理已取消。'],
  DEEPSEEK_TIMEOUT: [504, 'DeepSeek 响应超时，请稍后重试。'],
  DEEPSEEK_HTTP_ERROR: [502, 'DeepSeek 拒绝请求。请检查本地密钥、模型配置和账户状态。'],
  DEEPSEEK_NETWORK_ERROR: [502, '无法连接 DeepSeek，请检查网络后重试。'],
};

export function errorResponse(res, error) {
  if (res.destroyed || res.writableEnded || res.headersSent) return;
  if (error instanceof RequestError) {
    json(res, { error: { code: error.code, message: error.message } }, error.status);
    return;
  }
  if (error?.name === 'ZodError' || (error instanceof Error && Array.isArray(error.issues))) {
    json(res, { error: { code: 'INVALID_INPUT', message: '输入缺失、格式错误或超出长度限制。' } }, 400);
    return;
  }
  const code = error?.code;
  if (Object.hasOwn(validation, code)) {
    const [status, message] = validation[code];
    json(res, { error: { code, message } }, status);
    return;
  }
  if (typeof code === 'string' && /^(?:CASE|MATERIAL|TEXT|REFERENCE|LOOP|OUTPUT|ROLLBACK|INFORMATION|DEEPSEEK|NODE_REVIEW)_[A-Z0-9_]+$/u.test(code)) {
    const status = /(?:NOT_FOUND|NOT_ACTIVE)/u.test(code) ? 404
      : /(?:CONFLICT|STALE|CHANGED|PENDING)/u.test(code) ? 409 : 422;
    const message = status === 404 ? '当前案件视图中找不到这条记录。'
      : status === 409 ? '当前案件视图已改变，请刷新后再试。'
        : '本次操作无法完成，请核对当前材料或整理范围。';
    json(res, { error: { code, message } }, status);
    return;
  }
  json(res, { error: { code: 'WORKBENCH_ERROR', message: '工作台未能完成操作。请稍后重试。' } }, 500);
}
