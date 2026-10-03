/**
 * 拆批（Split）：杀青后分几路焙火。
 * - 母批保留未分出的余量（remainder），拆出使重量逐次减少
 * - 每个分支（branch）是独立批次，重量 = 该支公斤，继承拆分前工艺为只读底稿
 * - 各支公斤 + 余量必须合计对回原批次重量
 */
import type { BatchState } from './batch';
import type { Fix } from './fix';
import type { Roast } from './roast';
import type { Turn } from './turn';

/** 拆批时一支的表单草稿 */
export interface SplitBranchDraft {
  /** 分支序号（从 1 开始） */
  branchNo: number;
  /** 该支公斤 */
  weightKg: number;
  /** 分路焙火说明，例如「足火路 / 轻火路」 */
  routeNote: string;
}

/** 拆分前工艺只读底稿（快照，分支在做青 / 杀青 / 焙火页只展示不可改） */
export interface ProcessBaseline {
  id: string;
  /** 对应拆批记录 id */
  splitId: string;
  /** 母批 id（底稿来源） */
  sourceBatchId: string;
  /** 快照时的母批工序状态 */
  sourceState: BatchState;
  turns: Turn[];
  fix: Fix | null;
  /** 拆分时母批已有的焙火道次（后续复焙安排各支自行登记） */
  roasts: Roast[];
  createdAt: string;
  updatedAt: string;
}

/** 已落库的拆批记录（合回与来源追溯依据） */
export interface SplitRecord {
  id: string;
  /** 母批 id */
  sourceBatchId: string;
  /** 拆分前母批重量（公斤）= 各支公斤 + 余量 */
  originalWeightKg: number;
  /** 拆分后留在母批的余量（公斤，可为 0） */
  remainderWeightKg: number;
  /** 各支：分支批次 id / 序号 / 重量 / 路线说明 */
  branches: SplitBranch[];
  /** 拆分前工艺只读底稿 id */
  baselineId: string;
  /** 提交时母批的工序状态（分支继承） */
  stateAtSplit: BatchState;
  /** 提交时母批的乐观锁版本（并发拆分冲突判定用） */
  baseRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** 拆批记录里的一支结果 */
export interface SplitBranch {
  branchNo: number;
  batchId: string;
  weightKg: number;
  routeNote: string;
}

/** 拆批提交载荷 */
export interface CommitSplitPayload {
  sourceBatchId: string;
  branches: SplitBranchDraft[];
}

/** 合计校验结果：各支合计 / 余量 / 是否对得上原批次 */
export interface SplitWeightSummary {
  branchCount: number;
  branchTotalKg: number;
  remainderKg: number;
  originalKg: number;
  /** 各支合计 + 余量 与原批次重量的差值 */
  diffKg: number;
  /** 余量是否非负且合计对得上 */
  valid: boolean;
}
