import type { LegalAgentExtension } from '../../src/agent/engine.ts';

/** A runnable extension example, not a department-law plugin or legal rules. */
export default {
  id: 'example.transfer-review', version: '1.0.0',
  profiles: [{ id: 'example.transfer-amount', version: '1.0.0', description: '虚构演示：同笔付款的实际到账金额及可比条件。',
    needs: [{ id: 'example.transfer.amount', question: '材料分别记载了周岚向星河服务中心这笔付款的什么实际到账金额及交易条件？',
      reason: '保留不同来源，对应主体、同笔流水、日期、期间和口径后比较金额。',
      spec: { topic: 'transfer.actual_received', subject: '周岚', object: '星河服务中心', period: '2025-04', basis: '实际到账',
        requiredFields: ['subject', 'object', 'event.key', 'time', 'value', 'period', 'basis'], minimumSupport: 'statement', applicable: true } }],
  }],
} satisfies LegalAgentExtension;
