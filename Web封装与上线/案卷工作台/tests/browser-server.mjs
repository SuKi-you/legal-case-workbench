// Starts a synthetic-only loopback server for the browser smoke run.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createWorkbenchServer } from '../server/index.mjs';
import { fixtureModel, fixtureOcr } from './fixtures.mjs';

const dataDir = await mkdtemp(join(tmpdir(), 'law-web-browser-'));
let ocr;
let server;
try {
  ocr = await fixtureOcr(dataDir);
  server = await createWorkbenchServer({ dataDir, ocr, model: fixtureModel(), requireModelConsent: true });
  const ready = once(server, 'listening');
  server.listen(Number(process.env.LAW_WEB_TEST_PORT ?? 0), '127.0.0.1');
  await ready;
  console.log(`http://127.0.0.1:${server.address().port}`);
  await new Promise((finish) => {
    process.stdin.once('data', finish);
    process.stdin.once('end', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.stdin.resume();
  });
} finally {
  process.stdin.pause();
  if (server?.listening) await new Promise((finish) => server.close(finish));
  await ocr?.close();
  assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
  await rm(dataDir, { recursive: true, force: true });
}
