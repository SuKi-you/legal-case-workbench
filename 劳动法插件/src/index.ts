/**
 * 劳动法插件 · 装配入口
 *
 * 对外只暴露一个 LegalAgentExtension：
 *   profiles         → 让底座按劳动法需求抽取事实
 *   tools            → 清单、要件核对、缺口清单、金额与时效测算
 *   contributeOutput → 把有出处的专业判断写进底稿
 *
 * 不注册新的宿主能力，也不修改底座任何文件：
 * declare / read / review 三个能力由底座既有的信息整理插件提供。
 */
import type { InformationProfile, LegalAgentExtension, LoopRun, OutputSection } from './base.ts';
import { assessRun } from './kernel/assess.ts';
import { restrictKnowledge } from './kernel/restrict.ts';
import { assertKnowledge } from './kernel/schema.ts';
import { renderSections } from './kernel/sections.ts';
import type { OpinionModel } from './kernel/opinion.ts';
import type { DomainKnowledge, Stance } from './kernel/contracts.ts';
import { LABOR_ELEMENTS, LABOR_NEEDS } from './labor/elements.ts';
import { LABOR_ISSUES, buildLaborKnowledge } from './labor/issues.ts';
import { PLACEHOLDER_PARAMS, type LaborParams } from './labor/calc.ts';
import { createProfessionalReviewer } from './review.ts';
import { contributeLaborNodeReview } from './node-review.ts';
import { createLaborTools, type LaborToolOptions } from './tools.ts';

export interface CreateLaborPluginOptions {
  readonly stance?: Stance;
  /**
   * 只装配这些争点（按 id）。省略表示全部装配。
   * 裁剪会同步减少 profile 里的信息需求条数，从而降低每轮的读取条数——
   * 这是不改底座即可控制成本的主要手段。
   */
  readonly issues?: readonly string[];
  readonly params?: LaborParams;
  readonly version?: string;
  readonly dataDir?: () => string;
  readonly loadRun?: LaborToolOptions['loadRun'];
  /**
   * 评价性要件的模型句柄（唯一会调用模型的通道）。
   * 省略时 labor.opinions 返回"未启用"，其余功能完全不受影响。
   */
  readonly model?: OpinionModel;
}

export const DEFAULT_DATA_DIR_NOTE = '未注入模型时，评价性要件只能人工判断；装配时传入 { model } 即可启用。';

/** 底座会用它做信息抽取；所有需求都带结构化 spec，避免"泛泛整理"。 */
export function createLaborProfile(knowledge: DomainKnowledge): InformationProfile {
  // 只带被保留争点所用的需求；顺序沿用知识包中的定义顺序。
  const needed = new Set(knowledge.elements.flatMap((element) => element.needs));
  return {
    id: 'labor.intake',
    version: knowledge.version,
    description: '劳动法接案整理：按争点与要件提取事实，区分明确记载与仍不清楚之处，保留出处；不作法律定性与结果预测。',
    readingMode: 'batch',
    needs: LABOR_NEEDS.filter((need) => needed.has(need.id)).map((need) => ({ ...need })),
  };
}

export function createLaborPlugin(options: CreateLaborPluginOptions = {}): LegalAgentExtension {
  const selected = options.issues;
  if (selected !== undefined) {
    if (selected.length === 0) throw new Error('issues 不能为空数组；要全量装配请省略该参数。');
    const known = new Set(LABOR_ISSUES.map((issue) => issue.id));
    const unknown = selected.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`未知争点：${unknown.join('、')}；可选：${[...known].join('、')}`);
    }
  }

  const base = buildLaborKnowledge({
    ...(options.stance === undefined ? {} : { stance: options.stance }),
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  const knowledge = assertKnowledge(selected === undefined ? base : restrictKnowledge(base, selected));
  const profile = createLaborProfile(knowledge);

  const tools = createLaborTools({
    knowledge,
    needs: profile.needs,
    ...(options.params === undefined ? {} : { params: options.params }),
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.loadRun === undefined ? {} : { loadRun: options.loadRun }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });

  return {
    id: 'labor.cn',
    version: knowledge.version,
    profiles: [profile],
    reviewers: [createProfessionalReviewer(knowledge, profile.id)],
    contributeNodeReview: contributeLaborNodeReview,
    tools,
    contributeOutput: async (run: LoopRun): Promise<readonly OutputSection[]> => {
      const assessment = assessRun(knowledge, run);
      return renderSections(knowledge, assessment, run);
    },
  };
}

/**
 * 供 CLI 注入模型用的工厂（`--plugin` 加载时会优先用它）。
 * 底座在加载插件时构造模型，通过这个出口把句柄传进来；
 * 没有 createPlugin 的插件仍按 default 导出处理，因此这是纯增量。
 */
export function createPlugin(env: { model?: OpinionModel; dataDir?: string }): LegalAgentExtension {
  return createLaborPlugin({ ...(env.model ? { model: env.model } : {}), ...(env.dataDir ? { dataDir: () => env.dataDir! } : {}) });
}

/** 默认导出，供 `--plugin` 直接加载（不带模型，评价性要件因此只能人工判断）。 */
const plugin = createLaborPlugin();
export default plugin;

export { LABOR_ELEMENTS, LABOR_NEEDS, PLACEHOLDER_PARAMS };
export { assessRun, renderSections };
export type { DomainKnowledge, LaborParams, Stance };
