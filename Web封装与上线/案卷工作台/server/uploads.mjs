import { mkdtemp, unlink, writeFile, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { MAX_TEXT_LENGTH, MAX_UPLOAD_BYTES, RequestError, UPLOAD_EXTENSIONS } from './http.mjs';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function invalidFile(message = '文件内容与所选格式不符。') {
  return new RequestError(415, 'UNSUPPORTED_FILE', message);
}

function dimensions(bytes, extension) {
  if (extension === '.png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG)
      || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) throw invalidFile();
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalidFile();
  let offset = 2;
  while (offset < bytes.length && bytes[offset] === 0xff) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) break;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw invalidFile();
}

function validateImage(bytes, extension) {
  const [width, height] = dimensions(bytes, extension);
  if (!width || !height || width > 12000 || height > 12000 || width * height > 30_000_000) {
    throw new RequestError(413, 'IMAGE_TOO_LARGE', '图片最多 3000 万像素，单边不超过 12000 像素。');
  }
}

async function stageFile(fileName, bytes, operation) {
  const directory = await mkdtemp(join(tmpdir(), 'law-agent-web-upload-'));
  const path = join(directory, fileName);
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return await operation(path);
  } finally {
    await unlink(path).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

export async function saveUpload(workspace, caseId, input) {
  const { sourceLabel } = input;
  if ('text' in input) return workspace.registerText({ caseId, sourceLabel, text: input.text });
  const { fileName, base64 } = input;
  if (fileName !== fileName.trim() || !fileName.isWellFormed()
    || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(fileName)
    || /^(?:aux|con|prn|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(fileName)) throw invalidFile('文件名含有不支持的字符。');
  const extension = extname(fileName).toLowerCase();
  if (!UPLOAD_EXTENSIONS.includes(extension)) throw invalidFile('支持 TXT、PNG、JPG、PDF 和 DOCX 材料。');
  // Re-encoding catches Node's permissive acceptance of whitespace, bad padding and other alphabets.
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== base64) throw invalidFile('上传内容无效。');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new RequestError(413, 'UPLOAD_TOO_LARGE', '单份材料不得超过 15 MB。');
  if (extension === '.txt') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw invalidFile('请将 TXT 文件保存为 UTF-8 后上传。'); }
    if (!text.trim() || text.length > MAX_TEXT_LENGTH || text.includes('\u0000')) {
      throw invalidFile('TXT 材料须有内容，且不超过 30 万字。');
    }
    return workspace.registerText({ caseId, sourceLabel, text });
  }
  if (['.png', '.jpg', '.jpeg'].includes(extension)) {
    validateImage(bytes, extension);
    return stageFile('image' + extension, bytes, (path) => workspace.registerImage({ caseId, sourceLabel, path }));
  }
  const matches = extension === '.pdf'
    ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    : bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  if (!matches) throw invalidFile();
  return stageFile(fileName, bytes, (path) => workspace.importFile({ caseId, sourceLabel, path }));
}

export function attachmentType(fileName) {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}
