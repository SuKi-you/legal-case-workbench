import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdtemp, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const web = 'Web封装与上线/案卷工作台';
const deploy = web + '/deploy';
const included = [
  '底座/package.json', '底座/package-lock.json', '劳动法插件/package.json', web + '/package.json',
  ...['Dockerfile', 'Dockerfile.dockerignore', 'Caddyfile', 'compose.yaml', 'compose.env.example',
    'workbench.env.example', 'make-account.mjs', 'pack.mjs', 'README.md'].map((name) => deploy + '/' + name),
];

async function tree(relative, extensions) {
  if (!(await lstat(join(root, relative))).isDirectory()) throw new Error('源码路径不是普通目录：' + relative);
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(entry.name)) {
      throw new Error('源码树中存在未许可的文件名：' + entry.name);
    }
    const path = relative + '/' + entry.name;
    if (entry.isDirectory()) await tree(path, extensions);
    else if (entry.isFile() && extensions.has(extname(entry.name))) included.push(path);
    else throw new Error('源码树中存在未许可的文件类型：' + path);
  }
}

async function main() {
  if (process.argv.length !== 3 || !process.argv[2].endsWith('.tar.gz')) {
    throw new Error('用法为 node pack.mjs <输出路径.tar.gz>。');
  }
  const output = resolve(process.argv[2]);
  await tree('底座/src', new Set(['.ts']));
  await tree('劳动法插件/src', new Set(['.ts']));
  await tree(web + '/server', new Set(['.mjs']));
  await tree(web + '/public', new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.webp', '.woff2']));
  for (const path of included) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error('不是普通文件：' + path);
  }
  const temp = await mkdtemp(join(tmpdir(), 'law-workbench-release-'));
  const archive = join(temp, 'release.tar.gz');
  try {
    const result = spawnSync('tar', ['-czf', archive, '-C', root, ...included.sort()], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('打包失败，请确认 tar 可用。', { cause: result.error });
    const check = spawnSync('tar', ['-tzf', archive]);
    // Windows bsdtar can list UTF-8 PAX paths using the system's Chinese code page.
    const encodings = process.platform === 'win32' ? ['utf-8', 'gb18030'] : ['utf-8'];
    const verified = check.status === 0 && encodings.some((encoding) => {
      const entries = new TextDecoder(encoding).decode(check.stdout).trim().split(/\r?\n/u).sort();
      return JSON.stringify(entries) === JSON.stringify(included);
    });
    if (!verified) {
      throw new Error('发布包内容与白名单不一致。');
    }
    await copyFile(archive, output, constants.COPYFILE_EXCL);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    process.stdout.write(output + '\n' + included.length + ' files\nSHA-256 ' + digest + '\n');
  } finally {
    await unlink(archive).catch(() => {});
    await rmdir(temp);
  }
}

main().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
