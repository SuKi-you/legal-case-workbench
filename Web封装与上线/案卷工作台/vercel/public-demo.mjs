import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RequestError } from '../server/http.mjs';

const cookieName = '__Host-law-demo';
const accountPattern = /^demo_[a-f0-9]{24}$/u;
const prefixPattern = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;
const writableBrowsers = 20;
const dailyModelCalls = 24;
const maxLedgerBytes = 4096;

const unavailable = () => new RequestError(503, 'DEMO_LIMIT_UNAVAILABLE', '展示额度暂时无法核对，请稍后重试。');

function sign(secret, account) {
  return createHmac('sha256', secret).update('law-demo-v1:' + account).digest('hex');
}

function readAccount(header, secret) {
  if (typeof header !== 'string') return;
  const entries = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(cookieName + '='));
  if (entries.length !== 1) return;
  const value = entries[0].slice(cookieName.length + 1);
  const match = /^(demo_[a-f0-9]{24})\.([a-f0-9]{64})$/u.exec(value);
  if (!match) return;
  const [, account, signature] = match;
  if (timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(secret, account), 'hex'))) return account;
}

function isConflict(error) {
  return error?.name === 'BlobPreconditionFailedError' || error?.name === 'BlobAlreadyExistsError';
}

export function createPublicDemoAccess({ origin, secret, blob, token, prefix = 'law-workbench/v1' }) {
  const publicOrigin = new URL(origin);
  if (publicOrigin.protocol !== 'https:' || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash
    || publicOrigin.username || publicOrigin.password || typeof secret !== 'string' || Buffer.byteLength(secret) < 32
    || !prefixPattern.test(prefix) || typeof blob?.get !== 'function' || typeof blob?.put !== 'function') {
    throw new Error('公开展示需要 HTTPS 地址、签名密钥和私有 Blob 存储。');
  }
  const root = prefix + '/demo-access/';
  const options = { access: 'private', ...(token ? { token } : {}) };

  async function read(path, signal) {
    try {
      const result = await blob.get(path, { ...options, useCache: false, abortSignal: signal });
      if (result === null) return null;
      if (result.statusCode !== 200 || !result.stream || !result.blob?.etag || result.blob.size > maxLedgerBytes) {
        await result.stream?.cancel?.();
        throw unavailable();
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of result.stream) {
        length += chunk.byteLength;
        if (length > maxLedgerBytes) throw unavailable();
        chunks.push(chunk);
      }
      return { value: JSON.parse(Buffer.concat(chunks, length).toString('utf8')), etag: result.blob.etag };
    } catch {
      throw unavailable();
    }
  }

  async function update(name, change, signal) {
    const path = root + name + '.json';
    for (let attempt = 0; attempt < 8; attempt++) {
      signal?.throwIfAborted();
      const record = await read(path, signal);
      const next = change(record);
      if (next === undefined) return;
      try {
        await blob.put(path, JSON.stringify(next), {
          ...options, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: Boolean(record),
          ...(record ? { ifMatch: record.etag } : {}), abortSignal: signal,
        });
        return;
      } catch (error) {
        if (isConflict(error) || (!record && !signal?.aborted && await read(path, signal))) continue;
        throw unavailable();
      }
    }
    throw unavailable();
  }

  async function reserveWorkspace(account, signal) {
    await update('browsers', (record) => {
      const accounts = record ? record.value : [];
      if (!Array.isArray(accounts) || !accounts.every((entry) => typeof entry === 'string' && accountPattern.test(entry))) {
        throw unavailable();
      }
      if (accounts.includes(account)) return;
      if (accounts.length >= writableBrowsers) {
        throw new RequestError(429, 'DEMO_WORKSPACE_LIMIT', '可写展示工作区已满。');
      }
      return [...accounts, account];
    }, signal);
  }

  return {
    origin: publicOrigin,
    async authenticate(req, res, path, signal) {
      let account = readAccount(req.headers.cookie, secret);
      if (!account) {
        account = 'demo_' + randomBytes(12).toString('hex');
        if (path === '/' || path === '/api/cases' || path?.startsWith('/api/cases/')) {
          res.setHeader('Set-Cookie', `${cookieName}=${account}.${sign(secret, account)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
        }
      }
      // Any case mutation, including a staged upload, consumes a reserved slot.
      if ((path === '/api/cases' || path?.startsWith('/api/cases/'))
        && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        await reserveWorkspace(account, signal);
      }
      return account;
    },
    async reserveModelCall(signal) {
      await update('model-budget', (record) => {
        const previous = record?.value;
        if (record && (!previous || typeof previous.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(previous.day)
          || !Number.isSafeInteger(previous.calls) || previous.calls < 0 || previous.calls > dailyModelCalls)) {
          throw unavailable();
        }
        const day = new Date().toISOString().slice(0, 10);
        if (previous && previous.day > day) throw unavailable();
        const calls = previous?.day === day ? previous.calls : 0;
        if (calls >= dailyModelCalls) throw new RequestError(429, 'DEMO_MODEL_LIMIT', '今日 DeepSeek 展示额度已用完。');
        return { day, calls: calls + 1 };
      }, signal);
    },
  };
}
