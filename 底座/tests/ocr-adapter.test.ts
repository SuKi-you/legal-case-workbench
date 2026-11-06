import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTesseractOcr } from '../src/materials/tesseract.ts';

test('OCR can be closed before use without starting a worker or downloading models', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-ocr-idle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ocr = createTesseractOcr({ cachePath: join(directory, 'unused-cache') });
  assert.deepEqual(ocr.engine, { id: 'tesseract.js', version: '7.0.0', languages: ['chi_sim', 'eng'] });
  const stop = ocr.close();
  assert.strictEqual(ocr.close(), stop);
  await stop;
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(ocr.recognize(Buffer.alloc(0)), /closed/);
});

test('missing local OCR model rejects, permits retry, and drains before closing', { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-ocr-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ocr = createTesseractOcr({
    cachePath: join(directory, 'cache'),
    langPath: join(directory, 'nonexistent-local-models'),
    languages: ['eng'],
    timeoutMs: 5_000,
  });
  t.after(() => ocr.close());
  const image = Buffer.from('not reached: initialization fails before recognition');
  // These exercise the library's formerly hanging initialization failure path,
  // without network access or fabricated OCR text. Both accepted jobs must settle.
  const first = assert.rejects(ocr.recognize(image), /ENOENT/);
  const retry = assert.rejects(ocr.recognize(image), /ENOENT/);
  const stop = ocr.close();
  await assert.rejects(ocr.recognize(image), /closed/);
  await Promise.all([first, retry, stop]);
});

test('OCR initialization has a finite timeout and its process is cleaned up', { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-ocr-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ocr = createTesseractOcr({
    cachePath: join(directory, 'cache'),
    langPath: join(directory, 'missing-local-models'),
    timeoutMs: 1,
  });
  t.after(() => ocr.close());
  await assert.rejects(ocr.recognize(Buffer.from('x')), /timed out/);
  await ocr.close();
});

test('a failed child-process spawn settles cleanup without waiting for an exit event', { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-ocr-spawn-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ocr = createTesseractOcr({ cachePath: join(directory, 'cache'), timeoutMs: 1_000 });
  t.after(() => ocr.close());
  const executable = process.execPath;
  try {
    // This test file runs in its own Node test process; restore before returning.
    process.execPath = join(directory, 'missing-node-executable.exe');
    await assert.rejects(ocr.recognize(Buffer.from('x')), /ENOENT/);
  } finally { process.execPath = executable; }
  await ocr.close();
});
