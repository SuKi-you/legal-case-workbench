import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createTesseractOcr } from '../../../底座/src/materials/tesseract.ts';

export const fixtureImage = new URL('../../../底座/examples/fixtures/ocr-sample.png', import.meta.url);
export const wageStatement = '虚构员工乔乙2025年11月工资约定6100元。';
export const paymentReceipt = '虚构单位于2025年12月2日向乔乙实际支付2025年11月工资4900元，回单号TEST-001。';

export async function fixtureOcr(dataDir) {
  const cachePath = join(dataDir, 'ocr-cache');
  if (process.env.LAW_WEB_OCR_CACHE) {
    await mkdir(cachePath);
    for (const name of ['chi_sim.traineddata', 'eng.traineddata']) {
      await copyFile(join(process.env.LAW_WEB_OCR_CACHE, name), join(cachePath, name));
    }
  }
  return createTesseractOcr({ cachePath, timeoutMs: 60_000 });
}

export function fixtureModel() {
  let calls = 0;
  return {
    get calls() { return calls; },
    id: 'workbench-acceptance',
    model: 'deterministic-synthetic',
    async complete({ system, user }) {
      calls += 1;
      const { segment, needs, items } = JSON.parse(user);
      assert.ok(segment);
      if (items) {
        assert.match(system, /INFORMATION_SEMANTIC_REVIEW/u);
        return { verdicts: items.map((_, index) => ({
          index, relevant: true, supported: true, rolesCorrect: true, polarityCorrect: true,
          reason: '核对合成材料的原句。',
        })) };
      }
      return { results: needs.map((need) => {
        const isWage = need.id === 'labor.need.wage-standard' && segment.text === wageStatement;
        const isPayment = need.id === 'labor.need.wage-payment' && segment.text === paymentReceipt;
        if (!isWage && !isPayment) return { needId: need.id, items: [] };
        return { needId: need.id, items: [{
          statement: segment.text,
          record: {
            topic: need.spec.topic,
            subject: { name: '乔乙', kind: 'person', identity: null },
            object: null,
            attributedTo: null,
            event: { type: need.spec.topic, key: isPayment ? 'TEST-001' : null, description: segment.text },
            time: { raw: isPayment ? '2025年12月2日' : null, start: null, end: null, precision: isPayment ? 'date' : 'unknown' },
            value: { kind: 'money', raw: isPayment ? '4900元' : '6100元', normalized: null, unit: null },
            polarity: 'affirmed',
            period: '2025-11',
            basis: null,
            origin: isPayment ? 'document_record' : 'party_statement',
            qualifiers: {},
            uncertainty: [],
          },
          quotes: [{ segmentId: segment.id, quote: segment.text, occurrence: null }],
        }] };
      }) };
    },
  };
}
