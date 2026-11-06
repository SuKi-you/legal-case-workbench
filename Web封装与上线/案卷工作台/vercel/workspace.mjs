import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { RequestError } from '../server/http.mjs';

const zip = promisify(gzip);
const unzip = promisify(gunzip);
const magic = Buffer.from('law-workbench-snapshot-v1\n');
const entryHeaderBytes = 8;
const end = Buffer.alloc(entryHeaderBytes);
const directoryMarker = 0xffffffff;
const maxPathBytes = 512;
const maxEntries = 8192;
const maxSnapshotBytes = 64 * 1024 * 1024;
const maxActiveWorkspaces = 4;
const accountPattern = /^[a-z][a-z0-9_-]{0,31}$/u;
const prefixPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}){0,3}$/u;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function quota(limit) {
  return new RequestError(413, 'WORKSPACE_QUOTA', '当前工作区已达到 ' + (limit / 1024 / 1024) + ' MiB 上限或存储条目数上限。');
}

function unreadable() {
  return new RequestError(503, 'WORKSPACE_SNAPSHOT_INVALID', '无法读取已保存的工作区快照，请联系管理员。');
}

function conflict() {
  return new RequestError(409, 'WORKSPACE_CONFLICT', '工作区刚刚被其他请求更新，请刷新后重试。');
}

function unavailable() {
  return new RequestError(503, 'WORKSPACE_STORAGE_UNAVAILABLE', '工作区存储暂时不可用，请稍后重试。');
}

function safeParts(path) {
  const parts = path.split('/');
  return parts.length <= 32 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..'
    && !/[. ]$/u.test(part) && !/[\\:\u0000-\u001f\u007f<>|?*"]/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
    ? parts : undefined;
}

async function encodeDirectory(dataDir, limit) {
  // Each entry stores two big-endian lengths, then its UTF-8 path and raw file bytes.
  // A directory uses a reserved length. Eight zero bytes mark the end.
  const chunks = [magic];
  let bytes = magic.length + end.length;
  let count = 0;
  function addHeader(name, size) {
    const dataBytes = size === directoryMarker ? 0 : size;
    bytes += entryHeaderBytes + name.length + dataBytes;
    if (++count > maxEntries || bytes > limit) throw quota(limit);
    const header = Buffer.allocUnsafe(entryHeaderBytes);
    header.writeUInt32BE(name.length);
    header.writeUInt32BE(size, 4);
    chunks.push(header, name);
  }
  async function collect(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const name = prefix + entry.name;
      const encodedName = Buffer.from(name);
      if (encodedName.length > maxPathBytes || !safeParts(name)) throw quota(limit);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        addHeader(encodedName, directoryMarker);
        await collect(path, name + '/');
        continue;
      }
      if (!entry.isFile()) throw unreadable();
      const { size } = await lstat(path);
      if (size >= directoryMarker) throw quota(limit);
      addHeader(encodedName, size);
      const file = await readFile(path);
      if (file.length !== size) throw conflict();
      chunks.push(file);
    }
  }
  await collect(dataDir, '');
  chunks.push(end);
  return zip(Buffer.concat(chunks, bytes));
}

async function decodeDirectory(dataDir, stream, limit, compressedLimit) {
  const chunks = [];
  let compressedBytes = 0;
  for await (const chunk of stream) {
    compressedBytes += chunk.byteLength;
    if (compressedBytes > compressedLimit) throw unreadable();
    chunks.push(Buffer.from(chunk));
  }
  let archive;
  try {
    archive = await unzip(Buffer.concat(chunks, compressedBytes), { maxOutputLength: limit });
  } catch {
    throw unreadable();
  }
  if (!archive.subarray(0, magic.length).equals(magic)) throw unreadable();
  let offset = magic.length;
  let entries = 0;
  while (offset + entryHeaderBytes <= archive.length) {
    const nameBytes = archive.readUInt32BE(offset);
    const fileBytes = archive.readUInt32BE(offset + 4);
    offset += entryHeaderBytes;
    if (nameBytes === 0 && fileBytes === 0 && offset === archive.length) return;
    const nameEnd = offset + nameBytes;
    const isDirectory = fileBytes === directoryMarker;
    const fileEnd = nameEnd + (isDirectory ? 0 : fileBytes);
    if (++entries > maxEntries || !nameBytes || nameBytes > maxPathBytes || fileEnd > archive.length) throw unreadable();
    const parts = safeParts(utf8.decode(archive.subarray(offset, nameEnd)));
    if (!parts) throw unreadable();
    const path = join(dataDir, ...parts);
    await mkdir(isDirectory ? path : dirname(path), { recursive: true, mode: 0o700 });
    if (!isDirectory) await writeFile(path, archive.subarray(nameEnd, fileEnd), { flag: 'wx', mode: 0o600 });
    offset = fileEnd;
  }
  throw unreadable();
}

function preconditionFailed(blob, error) {
  return (typeof blob.BlobPreconditionFailedError === 'function' && error instanceof blob.BlobPreconditionFailedError)
    || error?.name === 'BlobPreconditionFailedError';
}

/** Prepare an isolated, disposable filesystem for one authenticated request. */
export function createBlobWorkspace({ blob, token, prefix = 'law-workbench/v1', snapshotLimit = maxSnapshotBytes }) {
  if (typeof blob?.get !== 'function' || typeof blob?.put !== 'function'
    || typeof prefix !== 'string' || !prefixPattern.test(prefix)
    || !Number.isSafeInteger(snapshotLimit) || snapshotLimit < 1024 * 1024 || snapshotLimit > maxSnapshotBytes) {
    throw new Error('Invalid private Blob workspace configuration.');
  }
  const compressedLimit = snapshotLimit + 1024 * 1024;
  let active = 0;
  return async function openWorkspace(account, { signal } = {}) {
    if (typeof account !== 'string' || !accountPattern.test(account)) throw new Error('Invalid workspace account.');
    if (active >= maxActiveWorkspaces) {
      throw new RequestError(503, 'WORKSPACE_BUSY', '当前工作区请求较多，请稍后重试。');
    }
    active += 1;
    const pathname = prefix + '/' + account + '.gz';
    const options = { access: 'private', ...(token ? { token } : {}), ...(signal ? { abortSignal: signal } : {}) };
    const readOptions = { ...options, useCache: false };
    let dataDir;
    let etag;
    let saving;
    let closing;

    function close() {
      closing ??= (async () => {
        try {
          await saving?.catch(() => {});
          if (dataDir) {
            if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('law-web-blob-')) {
              throw new Error('Unexpected temporary workspace location.');
            }
            await rm(dataDir, { recursive: true, force: true });
          }
        } finally {
          active -= 1;
        }
      })();
      return closing;
    }

    try {
      dataDir = await mkdtemp(join(tmpdir(), 'law-web-blob-'));
      const snapshot = await blob.get(pathname, readOptions).catch(() => { throw unavailable(); });
      if (snapshot !== null) {
        etag = snapshot.blob?.etag;
        try {
          if (snapshot.statusCode !== 200 || !snapshot.stream || typeof etag !== 'string' || !etag) throw unreadable();
          if (snapshot.blob.size > compressedLimit) throw unreadable();
          await decodeDirectory(dataDir, snapshot.stream, snapshotLimit, compressedLimit);
        } catch {
          await snapshot.stream?.cancel?.().catch(() => {});
          throw unreadable();
        }
      }
    } catch (error) {
      await close();
      throw error;
    }

    async function save() {
      signal?.throwIfAborted();
      const archive = await encodeDirectory(dataDir, snapshotLimit);
      signal?.throwIfAborted();
      try {
        await blob.put(pathname, archive, {
          ...options, contentType: 'application/gzip', addRandomSuffix: false, allowOverwrite: Boolean(etag),
          ...(etag ? { ifMatch: etag } : {}),
        });
      } catch (error) {
        if (preconditionFailed(blob, error)) throw conflict();
        if (!etag && !signal?.aborted) {
          // An initial create can lose a race with another request. Never fall back
          // to an unconditional overwrite, even when the SDK error is generic.
          const existing = await blob.get(pathname, readOptions).catch(() => null);
          if (existing?.statusCode === 200) {
            await existing.stream?.cancel?.().catch(() => {});
            throw conflict();
          }
        }
        throw unavailable();
      }
    }

    return {
      dataDir,
      commit() {
        if (closing) throw new Error('Workspace is closed.');
        saving ??= save();
        return saving;
      },
      close,
    };
  };
}
