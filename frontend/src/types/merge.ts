/**
 * 合回（Merge）：分路焙火的分支挑路合回为一个新茶青批次。
 * - 只接同山场、品种、工序的分支
 * - 新批次重量 = 各分支（毛茶）重量相加；审评分按毛茶重量加权
 * - 分支重量或审评分一变，合回结果立即失效（stale），确认前从拼配候选撤下
 * - 重算失败恢复旧结果（failed 保留 lastResult）并允许重试
 */
import type { BatchState } from './batch';
import type { ReviewScoreKey } from './review';

/** 合回状态：草稿 / 已确认 / 已失效 / 重算失败 */
export type MergeStatus = 'draft' | 'confirmed' | 'stale' | 'failed';

/** 参与合回的一支 */
export interface MergeBranchRef {
  batchId: string;
  /** 加入合回时的毛茶重量（快照依据，失效判定的一部分） */
  weightKg: number;
  /** 加入时的审评加权总分（无审评时为 null） */
  totalScore: number | null;
  /** 该支审评记录 id（无审评时为 null） */
  reviewId: string | null;
}

/** 合回算出的新批次结果（确认前为预演，确认后落库） */
export interface MergeResult {
  /** 新批次重量 = 各分支毛茶重量相加 */
  weightKg: number;
  /** 加权审评总分（按毛茶重量加权；无任何审评时为 null） */
  totalScore: number | null;
  /** 各审评分项加权值 */
  weightedScores: Record<ReviewScoreKey, number> | null;
  /** 参与加权的毛茶重量合计（无审评分支不计入） */
  scoredWeightKg: number;
  /** 山场 id（同山场才会合到一起） */
  gardenId: string;
  /** 品种 */
  cultivar: string;
  /** 工序状态 */
  state: BatchState;
  /** 分支数量 */
  branchCount: number;
}

/** 已落库的合回记录 */
export interface MergeRecord {
  id: string;
  /** 方案名称（默认「合回批次 + 日期」） */
  name: string;
  status: MergeStatus;
  /** 参与分支（用户挑选的路） */
  branches: MergeBranchRef[];
  /** 最近一次成功算出的结果；failed 时保留旧结果 */
  result: MergeResult | null;
  /** 确认后产生的新批次 id（draft/stale/failed 时为 null） */
  outputBatchId: string | null;
  /** 确认时生成的新审评记录 id */
  outputReviewId: string | null;
  /** 失效原因（stale / failed 时展示） */
  invalidReason: string;
  /** 失效判定指纹：分支版本 / 重量 / 审评分拼接，任一变化即失效 */
  fingerprint: string;
  /** 最近一次重算时间 */
  computedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 可合回分组：同山场 + 品种 + 工序的分支集合 */
export interface MergeGroup {
  key: string;
  gardenId: string;
  gardenName: string;
  cultivar: string;
  state: BatchState;
  branchBatchIds: string[];
}

/** 合回记录列表行（含派生展示字段） */
export interface MergeRow {
  record: MergeRecord;
  group: MergeGroup | null;
  /** 当前是否已失效（实时指纹比对，stale 立即反映） */
  stale: boolean;
}
