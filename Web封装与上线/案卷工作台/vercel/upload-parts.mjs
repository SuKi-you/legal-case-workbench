import { MAX_UPLOAD_BYTES, RequestError, json, readJson } from '../server/http.mjs';

const PART_BYTES = 3 * 1024 * 1024;
const MAX_PARTS = Math.ceil(MAX_UPLOAD_BYTES / PART_BYTES);
const MAX_HEADER_BYTES = 512;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-z][a-z0-9_-]{0,31}$/u;
const PREFIX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}){0,3}$/u;
const TYPE = 'application/octet-stream';

function invalid(message = '分片上传请求无效。') {
  return new RequestError(400, 'INVALID_UPLOAD_PART', message);
}

function stale() {
  return new RequestError(409, 'UPLOAD_PART_CONFLICT', '上传已变更或已处理，请重新选择文件。');
}

const missing = () => new RequestError(409, 'UPLOAD_PART_MISSING', '上传分片尚未齐全，请重新上传。');
const broken = () => new RequestError(502, 'UPLOAD_STORAGE_ERROR', '暂存文件不可读取，请重新上传。');

async function collect(stream, limit, tooLarge) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw tooLarge();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function pack(header, bytes) {
  const encoded = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([length, encoded, bytes]);
}

function unpack(record) {
  if (record.length <= 4) throw broken();
  const length = record.readUInt32BE(0);
  if (length > MAX_HEADER_BYTES || 4 + length >= record.length) throw broken();
  let header;
  try { header = JSON.parse(record.toString('utf8', 4, 4 + length)); }
  catch { throw broken(); }
  const bytes = record.subarray(4 + length);
  if (!header || !UUID.test(header.caseId) || !UUID.test(header.uploadId)
    || typeof header.claimed !== 'boolean' || bytes.length > MAX_UPLOAD_BYTES) throw broken();
  return { header, bytes };
}

const completeRequest = {
  parse(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 4
      || typeof input.sourceLabel !== 'string' || !input.sourceLabel.trim() || input.sourceLabel.length > 200
      || typeof input.fileName !== 'string' || !input.fileName.length || input.fileName.length > 180
      || !Number.isSafeInteger(input.byteLength) || input.byteLength <= PART_BYTES || input.byteLength > MAX_UPLOAD_BYTES
      || input.partCount !== Math.ceil(input.byteLength / PART_BYTES)) throw invalid();
    return { ...input, sourceLabel: input.sourceLabel.trim() };
  },
};

/** One bounded private staging object per account. Committing a newer upload replaces any abandoned parts. */
export function createUploadParts({ blob, token, prefix = 'law-workbench/v1' }) {
  if (typeof prefix !== 'string' || !PREFIX.test(prefix)) throw new Error('Invalid upload Blob prefix.');
  const conflict = (error) => ['BlobPreconditionFailedError', 'BlobAlreadyExistsError'].includes(error?.name);
  const options = token === undefined ? {} : { token };

  function keyFor(account, caseId, uploadId) {
    if (typeof account !== 'string' || !ACCOUNT.test(account) || !UUID.test(caseId) || !UUID.test(uploadId)) throw invalid();
    return `${prefix}/upload-parts/${account}.bin`;
  }

  async function read(key, signal) {
    const record = await blob.get(key, { ...options, access: 'private', useCache: false, abortSignal: signal });
    if (record === null) return null;
    if (record.statusCode !== 200 || !record.stream || !record.blob?.etag) throw broken();
    return {
      ...unpack(await collect(record.stream, MAX_UPLOAD_BYTES + MAX_HEADER_BYTES + 4, broken)),
      etag: record.blob.etag,
    };
  }

  async function write(key, header, bytes, signal, etag) {
    try {
      return await blob.put(key, pack(header, bytes), {
        ...options,
        access: 'private',
        contentType: TYPE,
        addRandomSuffix: false,
        allowOverwrite: Boolean(etag),
        ...(etag ? { ifMatch: etag } : {}),
        abortSignal: signal,
      });
    } catch (error) {
      if (conflict(error)) throw stale();
      throw error;
    }
  }

  function sameUpload(record, caseId, uploadId) {
    return record?.header.caseId === caseId && record.header.uploadId === uploadId;
  }

  async function stage({ req, res, caseId, uploadId, partIndex, account, signal }) {
    const key = keyFor(account, caseId, uploadId);
    const index = Number(partIndex);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PARTS || String(index) !== partIndex) throw invalid();
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== TYPE) {
      throw new RequestError(415, 'OCTET_STREAM_REQUIRED', '分片需要以二进制上传。');
    }
    const tooLarge = () => new RequestError(413, 'UPLOAD_PART_TOO_LARGE', '文件分片超过大小限制。');
    if (Number(req.headers['content-length']) > PART_BYTES) throw tooLarge();
    const chunk = await collect(req.iterator({ destroyOnReturn: false }), PART_BYTES, tooLarge);
    if (!chunk.length) throw invalid();

    const current = await read(key, signal);
    const same = sameUpload(current, caseId, uploadId);
    const offset = index * PART_BYTES;
    if (same && current.header.claimed) throw stale();
    if (same && offset < current.bytes.length) {
      const previous = current.bytes.subarray(offset, offset + PART_BYTES);
      if (!previous.equals(chunk)) throw stale();
      return json(res, { partIndex: index });
    }
    if (index !== 0 && (!same || current.bytes.length !== offset)) throw missing();
    if (offset + chunk.length > MAX_UPLOAD_BYTES) throw tooLarge();
    const bytes = index === 0 ? chunk : Buffer.concat([current.bytes, chunk]);
    await write(key, { caseId, uploadId, claimed: false }, bytes, signal, current?.etag);
    return json(res, { partIndex: index });
  }

  async function assemble({ req, caseId, uploadId, account, signal }) {
    const key = keyFor(account, caseId, uploadId);
    const { sourceLabel, fileName, byteLength } = await readJson(req, completeRequest);
    const current = await read(key, signal);
    if (!sameUpload(current, caseId, uploadId) || current.bytes.length !== byteLength) throw missing();
    if (current.header.claimed) throw stale();
    // Claim before attaching so retries cannot create a duplicate material.
    const claimed = await write(key, { ...current.header, claimed: true }, current.bytes, signal, current.etag);
    if (!claimed?.etag) throw broken();
    return {
      input: { sourceLabel, fileName, base64: current.bytes.toString('base64') },
      async cleanup() {
        try { await blob.del(key, { ...options, ifMatch: claimed.etag }); }
        catch { /* The temporary object is bounded and can be replaced by the next upload. */ }
      },
    };
  }

  return { partBytes: PART_BYTES, stage, assemble };
}
