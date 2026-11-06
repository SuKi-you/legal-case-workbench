import { copyFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const web = 'Web封装与上线/案卷工作台';
const cloud = web + '/vercel';
const files = ['底座/package.json', '底座/package-lock.json', '劳动法插件/package.json'];

async function gather(relative, extensions) {
  const source = join(sourceRoot, relative);
  if (!(await lstat(source)).isDirectory()) throw Error('目录无效：' + relative);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(entry.name)) throw Error('文件名超出发布范围：' + entry.name);
    const path = relative + '/' + entry.name;
    if (entry.isDirectory()) await gather(path, extensions);
    else if (entry.isFile() && extensions.has(extname(entry.name))) files.push(path);
    else throw Error('文件超出发布范围：' + path);
  }
}

async function prepare(target) {
  await gather('底座/src', new Set(['.ts']));
  await gather('劳动法插件/src', new Set(['.ts']));
  await gather(web + '/server', new Set(['.mjs']));
  await gather(web + '/public', new Set(['.html', '.css', '.js', '.svg', '.png', '.jpg', '.webp', '.woff2']));

  const cloudModules = ['workspace.mjs', 'upload-parts.mjs', 'public-demo.mjs', 'api/workbench.mjs'];
  for (const module of cloudModules) files.push(cloud + '/' + module);
  const rootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'vercel.json'];
  const mapping = [
    ...files.map((path) => [path, path]),
    ...rootFiles.map((path) => [cloud + '/' + path, path]),
  ];
  for (const [source] of mapping) {
    if (!(await lstat(join(sourceRoot, source))).isFile()) throw Error('发布文件不是普通文件：' + source);
  }

  await mkdir(target);
  for (const [source, destination] of mapping) {
    const path = join(target, destination);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(join(sourceRoot, source), path);
  }
  await mkdir(join(target, 'api'));
  await writeFile(join(target, 'api', 'workbench.mjs'),
    "export { default } from '../" + cloud + "/api/workbench.mjs';\n");
  await writeFile(join(target, '.gitignore'), '/node_modules/\n/.vercel/\n/.env*\n/static/\n');
  await writeFile(join(target, '.vercelignore'), '.env*\n**/.env*\n.vercel/\n.git/\n**/node_modules/\n');
  console.log('Vercel 发布目录 ' + target);
}

if (process.argv.length !== 3) {
  console.error('用法 node prepare.mjs <尚不存在的发布目录>');
  process.exitCode = 1;
} else {
  prepare(resolve(process.argv[2])).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
