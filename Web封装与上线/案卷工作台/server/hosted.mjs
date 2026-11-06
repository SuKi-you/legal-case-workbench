import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { RequestError } from './http.mjs';

const derive = promisify(scrypt);
const usernamePattern = /^[a-z][a-z0-9_-]{0,31}$/u;
const saltPattern = /^[a-f0-9]{32}$/u;
const hashPattern = /^[a-f0-9]{128}$/u;
const hashLength = 64;
const maxPasswordBytes = 1024;
const maxConcurrentChecks = 16;
const noAccount = { salt: randomBytes(16), hash: randomBytes(hashLength) };

function parseAccounts(raw) {
  const accounts = JSON.parse(raw);
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts) || !Object.keys(accounts).length) {
    throw new Error('Expected a nonempty account object.');
  }
  return new Map(Object.entries(accounts).map(([username, account]) => {
    if (!usernamePattern.test(username) || !account || typeof account !== 'object'
      || Object.keys(account).length !== 2 || typeof account.salt !== 'string' || !saltPattern.test(account.salt)
      || typeof account.hash !== 'string' || !hashPattern.test(account.hash)) {
      throw new Error('Invalid account entry.');
    }
    return [username, { salt: Buffer.from(account.salt, 'hex'), hash: Buffer.from(account.hash, 'hex') }];
  }));
}

function readCredentials(header) {
  if (typeof header !== 'string' || header.length > 1420) return;
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/iu.exec(header)?.[1];
  if (!encoded) return;
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded) return;
  const separator = raw.indexOf(0x3a);
  if (separator < 1 || separator > 32) return;
  const username = raw.toString('utf8', 0, separator);
  const password = raw.subarray(separator + 1);
  if (!usernamePattern.test(username) || !password.length || password.length > maxPasswordBytes) return;
  return { username, password };
}

/** Load hashed accounts only when the local origin is served by a trusted TLS proxy. */
export async function loadHostedAccess(env = process.env) {
  const value = env.LAW_WEB_PUBLIC_ORIGIN;
  const file = env.LAW_WEB_ACCOUNTS_FILE;
  if (value === undefined && file === undefined) return;
  let origin;
  try {
    origin = parsePublicOrigin(value);
    if (!isAbsolute(file)) throw new Error();
  } catch {
    throw new Error('部署配置需同时提供 HTTPS 源地址和账号文件的绝对路径。');
  }

  let accounts;
  try {
    accounts = parseAccounts(await readFile(file, 'utf8'));
  } catch {
    throw new Error('无法读取部署账号。请检查账号文件和密码散列格式。');
  }

  return makeHostedAccess(origin, accounts);
}

function parsePublicOrigin(value) {
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || (value !== origin.origin && value !== origin.origin + '/')) throw new Error();
  return origin;
}

/** Vercel sets the production hostname independently of request headers. */
export function vercelPublicOrigin(env = process.env) {
  const explicitOrigin = env.LAW_WEB_PUBLIC_ORIGIN;
  const projectHost = env.VERCEL_PROJECT_PRODUCTION_URL;
  return parsePublicOrigin(explicitOrigin ?? (projectHost && 'https://' + projectHost));
}

export function loadVercelHostedAccess(env = process.env) {
  try {
    return makeHostedAccess(vercelPublicOrigin(env), parseAccounts(env.LAW_WEB_ACCOUNTS_JSON));
  } catch {
    throw new Error('云部署需要有效的 HTTPS 源地址和账号散列配置。');
  }
}

function makeHostedAccess(origin, accounts) {
  let activeChecks = 0;
  return {
    origin,
    async authenticate(req, res) {
      const credentials = readCredentials(req.headers.authorization);
      if (credentials) {
        if (activeChecks >= maxConcurrentChecks) {
          res.setHeader('Retry-After', '1');
          throw new RequestError(429, 'AUTH_BUSY', '登录请求较多，请稍后重试。');
        }
        activeChecks++;
        try {
          const account = accounts.get(credentials.username);
          const { salt, hash } = account ?? noAccount;
          const derived = await derive(credentials.password, salt, hashLength);
          if (timingSafeEqual(derived, hash) && account) return credentials.username;
        } finally {
          activeChecks--;
        }
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="Law Agent", charset="UTF-8"');
      throw new RequestError(401, 'AUTH_REQUIRED', '请使用分配给你的账号登录案卷工作台。');
    },
  };
}
