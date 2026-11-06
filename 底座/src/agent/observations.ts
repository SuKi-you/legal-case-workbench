import type { AgentStep } from './contracts.ts';

/** The durable step keeps its full result; the model view has a separate, explicit size budget. */
export function boundedObservations(steps: readonly AgentStep[], fingerprint: string, maxBytes = 280_000) {
  let remaining = Math.max(0, maxBytes);
  const selected = new Map<string, unknown>();
  for (const step of [...steps].reverse()) {
    if (step.status !== 'completed') continue;
    const bytes = Buffer.byteLength(JSON.stringify(step.result ?? null));
    if (bytes <= remaining) { selected.set(step.id, step.result); remaining -= bytes; }
    else {
      const value = step.result;
      const object = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
      selected.set(step.id, {
        omittedFromModelContext: true, originalByteLength: bytes,
        ...(typeof object['runId'] === 'string' ? { runId: object['runId'] } : {}),
        ...(typeof object['materialId'] === 'string' ? { materialId: object['materialId'] } : {}),
        ...(typeof object['versionId'] === 'string' ? { versionId: object['versionId'] } : {}),
        note: '完整结果仍保存在执行记录中；本模型视图未包含结果正文，不能据此认定内容。请使用案件目录、整理运行或材料范围读取工具取得所需部分。',
      });
    }
  }
  return steps.filter((step) => step.status === 'completed').map((step) => ({
    stepId: step.id, taskId: step.taskId, toolId: step.toolId, result: selected.get(step.id),
    currentInput: step.inputFingerprint === fingerprint,
  }));
}
