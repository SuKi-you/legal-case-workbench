import { parseArgs } from 'node:util';
import {
  createRuntime, MATERIAL_CAPABILITIES, materialSchema, materialViewSchema, ocrAttemptSchema,
} from '../src/index.ts';

const { values } = parseArgs({ options: {
  'data-dir': { type: 'string', default: './runtime-data' },
  image: { type: 'string' }, read: { type: 'string' },
} });
let materialId = values.read;
const runtime = await createRuntime({ dataDir: values['data-dir'] });
try {
  if (!materialId) {
    const source = { groupId: 'demo-001', sourceLabel: '虚构演示材料' };
    const result = values.image
      ? await runtime.invoke(MATERIAL_CAPABILITIES.registerImage, { ...source, path: values.image })
      : await runtime.invoke(MATERIAL_CAPABILITIES.registerText, { ...source, text: '模拟陈述：九月工资尚未收到。' });
    if (result.status !== 'success') throw new Error(JSON.stringify(result));
    materialId = materialSchema.parse(result.data).id;
    if (values.image) {
      const recognized = await runtime.invoke(MATERIAL_CAPABILITIES.recognize, { materialId });
      if (recognized.status !== 'success') throw new Error(JSON.stringify(recognized));
      const attempt = ocrAttemptSchema.parse(recognized.data);
      if (attempt.status === 'failed') {
        console.error(`OCR 未完成：${attempt.error.message}；原件已保存，材料 ID：${materialId}`);
        process.exitCode = 1;
      }
    }
  }
} finally { await runtime.stop(); }

// Start again to demonstrate real persistence, rather than reuse an in-memory result.
const restarted = await createRuntime({ dataDir: values['data-dir'] });
try {
  const result = await restarted.invoke(MATERIAL_CAPABILITIES.read, { materialId });
  if (result.status !== 'success') throw new Error(JSON.stringify(result));
  console.log(JSON.stringify(materialViewSchema.parse(result.data), null, 2));
} finally { await restarted.stop(); }
