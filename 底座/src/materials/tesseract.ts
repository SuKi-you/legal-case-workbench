import { fork, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ocrOutputSchema, type OcrAdapter, type OcrOutput } from './contracts.ts';

export interface TesseractOptions {
  readonly cachePath: string;
  readonly languages?: readonly string[];
  readonly langPath?: string;
  /** Applies separately to initialization and each recognition operation. */
  readonly timeoutMs?: number;
}

const CHILD_ARGUMENT = '--law-agent-internal-ocr';
const require = createRequire(import.meta.url);
const { version } = require('tesseract.js/package.json') as { version: string };

function message(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return 'OCR failed with an unreadable error.'; }
}

interface Session {
  request(command: object): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Tesseract.js 7 can leave createWorker pending after loadLanguage fails, and
 * does not expose the worker until initialization succeeds. Isolating that
 * worker lets us terminate failed initialization as well as hung recognition.
 * This is private adapter plumbing, not a second application service.
 */
function createSession(timeoutMs: number, onExit: () => void): Session {
  const child: ChildProcess = fork(fileURLToPath(import.meta.url), [CHILD_ARGUMENT], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
  });
  let pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let closed = false;
  let finished = false;
  let closePromise: Promise<void> | undefined;
  // 'close' also fires when spawn fails; 'exit' alone does not cover that case.
  const completion = new Promise<void>((resolve) => {
    child.once('close', () => { finished = true; resolve(); });
  });
  const fail = (error: unknown) => {
    closed = true;
    pending?.reject(new Error(message(error)));
    pending = undefined;
    onExit();
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(`OCR worker exited (${signal ?? code}).`));
  child.on('message', (response: unknown) => {
    if (response === null || typeof response !== 'object') return;
    const result = response as { kind?: string; value?: unknown; error?: unknown };
    if (result.kind === 'error') fail(result.error);
    else if (result.kind === 'result') {
      pending?.resolve(result.value);
      pending = undefined;
    }
  });
  return {
    request(command) {
      if (closed) return Promise.reject(new Error('OCR worker is closed.'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(`OCR operation timed out after ${timeoutMs} ms.`), timeoutMs);
        pending = {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); },
        };
        child.send(command, (error) => { if (error) fail(error); });
      });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      // Killing this process also ends its Tesseract worker thread. No pid is
      // allocated when spawn fails, but its 'close' event still settles cleanup.
      if (!finished && child.pid !== undefined) child.kill();
      closePromise = completion;
      return closePromise;
    },
  };
}

/** Local OCR; only language model files are downloaded, never material images. */
export function createTesseractOcr(options: TesseractOptions): OcrAdapter {
  const languages = [...(options.languages ?? ['chi_sim', 'eng'])];
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (languages.length === 0 || languages.some((language) => !/^[a-z_]+$/i.test(language))) {
    throw new Error('OCR languages must contain Tesseract language codes.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid OCR timeout.');
  let session: Session | undefined;
  let queue = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const run = async (image: Buffer): Promise<OcrOutput> => {
    let active = session;
    try {
      if (!active) {
        await mkdir(options.cachePath, { recursive: true });
        active = createSession(timeoutMs, () => { if (session === active) session = undefined; });
        session = active;
        await active.request({ kind: 'init', options: { ...options, languages } });
      }
      return ocrOutputSchema.parse(await active.request({ kind: 'recognize', image }));
    } catch (error) {
      if (session === active) session = undefined;
      await active?.close();
      throw new Error(message(error));
    }
  };
  return {
    engine: { id: 'tesseract.js', version, languages: [...languages] },
    recognize(image) {
      if (closed) return Promise.reject(new Error('OCR adapter is closed.'));
      // Copy now: callers may reuse/mutate their buffer while waiting in queue.
      const bytes = Buffer.from(image);
      const result = queue.then(() => run(bytes));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = queue.then(async () => {
        const active = session;
        session = undefined;
        await active?.close();
      });
      return closePromise;
    },
  };
}

// The same entry works for Node's native .ts execution and built dist/*.js.
if (process.argv[2] === CHILD_ARGUMENT && process.send) {
  const fatal = (error: unknown) => {
    const response = { kind: 'error', error: message(error) };
    if (process.connected) process.send!(response, () => process.exit(1));
    else process.exit(1);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  process.on('disconnect', () => process.exit());
  let worker: import('tesseract.js').Worker | undefined;
  process.on('message', async (command: { kind: string; options?: TesseractOptions; image?: Buffer }) => {
    try {
      if (command.kind === 'init' && command.options) {
        const { createWorker } = await import('tesseract.js');
        worker = await createWorker([...(command.options.languages ?? ['chi_sim', 'eng'])], 1, {
          cachePath: command.options.cachePath,
          ...(command.options.langPath === undefined ? {} : { langPath: command.options.langPath }),
          // Without this, Tesseract throws outside its promise rejection path.
          errorHandler: fatal,
        });
        process.send!({ kind: 'result', value: null });
      } else if (command.kind === 'recognize' && worker && command.image) {
        const { data } = await worker.recognize(command.image, {}, { text: true, blocks: true });
        const output: OcrOutput = {
          text: data.text,
          confidence: data.confidence,
          lines: (data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => (
            paragraph.lines.map((line) => ({
              text: line.text, confidence: line.confidence, box: { ...line.bbox },
            }))
          ))),
        };
        process.send!({ kind: 'result', value: output });
      } else throw new Error('Invalid internal OCR command.');
    } catch (error) { fatal(error); }
  });
}
