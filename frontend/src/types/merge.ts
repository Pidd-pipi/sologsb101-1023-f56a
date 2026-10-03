/**
 * 合回记录（Merge）：分路焙火后的分支挑路合回成新茶青批次。
 * - 合回只接同山场、品种、工序的分支；新批次重量 = 分支重量相加。
 * - 审评分按毛茶（分支）重量加权；确认时固化来源快照，用于失效判定与失败恢复。
 * - 任一分支重量或审评分变化 → 合回结果立即失效（status = stale），从拼配候选撤下；
 *   重算失败则恢复旧结果并允许重试。
 */

/** 合回状态：confirmed 已确认（有效）/ stale 已失效（来源变化，待重算） */
export type MergeStatus = 'confirmed' | 'stale';

/** 合回来源分支快照（确认时固化，用于失效判定与重算恢复） */
export interface MergeSource {
  /** 分支批次 id */
  batchId: string;
  /** 分支展示名快照 */
  batchLabel: string;
  gardenId: string;
  gardenName: string;
  cultivar: string;
  /** 合回时工序状态（同工序） */
  state: string;
  /** 合回时分支重量（公斤） */
  weightKg: number;
  /** 合回时审评记录 id */
  reviewId: string;
  /** 合回时审评总分 */
  totalScore: number;
  /** 合回时审评分项（用于加权重算） */
  aroma: number;
  liquorColor: number;
  taste: number;
  leafBase: number;
}

/** 合回记录实体（持久化到 IndexedDB 的 merges 表） */
export interface MergeRecord {
  id: string;
  /** 合回产生的新茶青批次 id */
  mergedBatchId: string;
  /** 新批次审评记录 id */
  reviewId: string;
  gardenId: string;
  gardenName: string;
  cultivar: string;
  /** 合回时工序状态（来源分支同工序） */
  state: string;
  /** 来源分支数 */
  sourceCount: number;
  /** 合回总重量（公斤）= 分支重量相加 */
  totalWeightKg: number;
  /** 合回加权审评分 */
  resultScore: number;
  status: MergeStatus;
  /** 确认时的来源快照 */
  sources: MergeSource[];
  /** 最近一次重算失败原因（空串表示无失败） */
  lastError?: string;
  confirmedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 合回预览（未确认的内存态，不落库） */
export interface MergePreview {
  sources: MergeSource[];
  totalWeightKg: number;
  resultScore: number;
  aroma: number;
  liquorColor: number;
  taste: number;
  leafBase: number;
}
