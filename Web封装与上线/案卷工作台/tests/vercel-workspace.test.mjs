import assert from 'node:assert/strict';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createBlobWorkspace } from '../vercel/workspace.mjs';

function mockBlob() {
  class BlobPreconditionFailedError extends Error {}
  const objects = new Map();
  let revision = 0;
  return {
    objects,
    BlobPreconditionFailedError,
    async get(path, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      const stored = objects.get(path);
      if (!stored) return null;
      const { bytes, etag } = stored;
      return {
        statusCode: 200,
        blob: { etag, size: bytes.length },
        stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      };
    },
    async put(path, bytes, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.addRandomSuffix, false);
      const stored = objects.get(path);
      if (options.allowOverwrite) {
        if (stored?.etag !== options.ifMatch) throw new BlobPreconditionFailedError();
      } else {
        assert.equal(options.ifMatch, undefined);
        if (stored) throw new Error('pathname already used');
      }
      const etag = '"' + ++revision + '"';
      objects.set(path, { etag, bytes: Buffer.from(bytes) });
      return { etag };
    },
  };
}

async function putFile(workspace, path, bytes) {
  const file = join(workspace.dataDir, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

test('private snapshots persist binary files, isolate accounts, and reject lost updates', async () => {
  const blob = mockBlob();
  const openWorkspace = createBlobWorkspace({ blob, prefix: 'test-workbench/v1' });
  const data = Buffer.from([0, 17, 44, 128, 255, 10]);
  const path = 'cases/demo/material.bin';
  const first = await openWorkspace('alice');
  const concurrentCreate = await openWorkspace('alice');
  try {
    assert.notEqual(first.dataDir, concurrentCreate.dataDir);
    await putFile(first, path, data);
    await putFile(concurrentCreate, path, 'concurrent create');
    await first.commit();
    await assert.rejects(() => concurrentCreate.commit(), { code: 'WORKSPACE_CONFLICT', status: 409 });
  } finally {
    await Promise.all([first.close(), concurrentCreate.close()]);
  }
  await first.close();
  await assert.rejects(() => stat(first.dataDir), { code: 'ENOENT' });

  const reopen = createBlobWorkspace({ blob, prefix: 'test-workbench/v1' });
  const newWrite = await reopen('alice');
  const staleWrite = await reopen('alice');
  const stranger = await reopen('bob');
  try {
    assert.deepEqual(await readFile(join(newWrite.dataDir, path)), data);
    await assert.rejects(() => stat(join(stranger.dataDir, path)), { code: 'ENOENT' });
    await putFile(newWrite, path, 'committed change');
    await putFile(staleWrite, path, 'stale change');
    await putFile(stranger, path, 'uncommitted change');
    await newWrite.commit();
    await assert.rejects(() => staleWrite.commit(), { code: 'WORKSPACE_CONFLICT', status: 409 });
  } finally {
    await Promise.all([newWrite.close(), staleWrite.close(), stranger.close()]);
  }
  const final = await reopen('alice');
  try {
    assert.equal(await readFile(join(final.dataDir, path), 'utf8'), 'committed change');
    assert.deepEqual([...blob.objects.keys()], ['test-workbench/v1/alice.gz']);
  } finally {
    await final.close();
  }
});

test('over-quota and corrupt snapshots fail without committing data', async () => {
  const blob = mockBlob();
  const openWorkspace = createBlobWorkspace({ blob });
  const excessive = await openWorkspace('alice');
  try {
    const file = await open(join(excessive.dataDir, 'too-large'), 'wx');
    try { await file.truncate(64 * 1024 * 1024); } finally { await file.close(); }
    await assert.rejects(() => excessive.commit(), { code: 'WORKSPACE_QUOTA', status: 413 });
    assert.equal(blob.objects.size, 0);
  } finally {
    await excessive.close();
  }
  const seed = await openWorkspace('alice');
  const entry = 'cases/test';
  try {
    await putFile(seed, entry, 'fixture');
    await seed.commit();
  } finally {
    await seed.close();
  }
  const stored = blob.objects.get('law-workbench/v1/alice.gz');
  const archive = gunzipSync(stored.bytes);
  const position = archive.indexOf(entry);
  assert.ok(position > 0);
  assert.equal(Buffer.byteLength('../escapes'), Buffer.byteLength(entry));
  archive.write('../escapes', position);
  stored.bytes = gzipSync(archive);
  await assert.rejects(() => openWorkspace('alice'), { code: 'WORKSPACE_SNAPSHOT_INVALID', status: 503 });
});
