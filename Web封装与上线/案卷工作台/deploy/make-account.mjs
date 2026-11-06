import { randomBytes, scryptSync } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const accountName = /^[a-z][a-z0-9_-]{0,31}$/u;
const accountHash = /^[a-f0-9]{128}$/u;
const accountSalt = /^[a-f0-9]{32}$/u;

async function readPassword() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 130) throw new Error('密码长度须在 16 到 128 字节之间。');
    chunks.push(chunk);
  }
  const password = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/u, '');
  if (Buffer.byteLength(password) < 16 || Buffer.byteLength(password) > 128 || /[\u0000-\u001f\u007f]/u.test(password)) {
    throw new Error('密码长度须在 16 到 128 字节之间，且不能含控制字符。');
  }
  return password;
}

async function readAccounts(path) {
  let contents;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const parsed = JSON.parse(contents);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Object.entries(parsed).every(([name, record]) => accountName.test(name) && record
      && accountSalt.test(record.salt) && accountHash.test(record.hash))) {
    throw new Error('账号文件格式无效，请先检查已有文件。');
  }
  return parsed;
}

async function main() {
  const [, , file, username] = process.argv;
  if (!file || !accountName.test(username || '') || process.argv.length !== 4 || process.stdin.isTTY) {
    throw new Error('用法为 node make-account.mjs <accounts.json> <用户名>，密码从标准输入传入。');
  }
  const target = resolve(file);
  const entries = await readAccounts(target);
  const password = await readPassword();
  const salt = randomBytes(16);
  const record = { salt: salt.toString('hex'), hash: scryptSync(password, salt, 64).toString('hex') };
  const temporary = join(dirname(target), '.' + basename(target) + '.' + randomBytes(8).toString('hex'));
  try {
    await writeFile(temporary, JSON.stringify({ ...entries, [username]: record }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  process.stdout.write('账号记录已保存。\n');
}

main().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
