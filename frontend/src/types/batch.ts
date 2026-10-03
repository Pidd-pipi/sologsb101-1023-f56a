/**
 * 茶青批次（Batch）：一次采摘的鲜叶，按工序推进状态
 * 状态流转：做青中 → 已杀青 → 已焙火 → 已审评
 */

/** 嫩度枚举 */
export const TENDERNESS_OPTIONS = ['一芽两叶', '一芽三叶', '开面采'] as const;
export type Tenderness = (typeof TENDERNESS_OPTIONS)[number];

/** 工序状态枚举（数组顺序即流转顺序） */
export const BATCH_STATES = ['做青中', '已杀青', '已焙火', '已审评'] as const;
export type BatchState = (typeof BATCH_STATES)[number];

/** 茶青批次实体（持久化到 IndexedDB 的 batches 表） */
export interface Batch {
  id: string;
  /** 所属山场 id（gardenId 外键） */
  gardenId: string;
  /** 采摘日期 YYYY-MM-DD */
  pickedAt: string;
  /** 鲜叶重量（公斤）。拆分后父批次此字段表示「余量」，分支批次表示「分支公斤」 */
  freshLeafKg: number;
  /** 嫩度 */
  tenderness: Tenderness;
  /** 气象备注，例如「晴，北风 2 级」 */
  weather: string;
  /** 工序状态 */
  state: BatchState;
  /** 拆分支线：父批次 id；为空（null / undefined）表示单支批次（默认，旧数据兼容） */
  parentBatchId?: string | null;
  /** 支号（拆分时的第几支，从 1 开始）；仅分支批次有意义 */
  branchNo?: number | null;
  /** 合回来源分支批次 id 列表；仅合回产生的新批次有值 */
  mergedFromBatchIds?: string[];
  /** 拆分前原始重量（公斤）；仅被拆过的父批次保留，用于核对「各支 + 余量 = 原批次」 */
  originalFreshLeafKg?: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 编辑批次表单草稿 */
export interface BatchDraft {
  gardenId: string;
  pickedAt: string;
  freshLeafKg: number;
  tenderness: Tenderness;
  weather: string;
  state: BatchState;
  parentBatchId?: string | null;
  branchNo?: number | null;
  mergedFromBatchIds?: string[];
  originalFreshLeafKg?: number | null;
}

/** 批次状态计数，用于统计徽标 */
export type BatchStateCounts = Record<BatchState, number>;

/** 下一道工序状态；已审评时返回 null（流程已到终点） */
export function nextBatchState(state: BatchState): BatchState | null {
  const index = BATCH_STATES.indexOf(state);
  if (index < 0 || index >= BATCH_STATES.length - 1) return null;
  return BATCH_STATES[index + 1];
}

/** 工序状态序号，便于比较推进程度 */
export function batchStateOrder(state: BatchState): number {
  return BATCH_STATES.indexOf(state);
}

/* ------------------------------ 拆并分支判定 ------------------------------ */

/** 是否为拆分支线（有父批次） */
export function isBranchBatch(batch: Batch): boolean {
  return typeof batch.parentBatchId === 'string' && batch.parentBatchId.length > 0;
}

/** 是否为合回产生的新批次 */
export function isMergedBatch(batch: Batch): boolean {
  return Array.isArray(batch.mergedFromBatchIds) && batch.mergedFromBatchIds.length > 0;
}

/** 是否为单支批次（既不是分支也不是合回产物；旧数据迁移后全部默认单支） */
export function isSingleBatch(batch: Batch): boolean {
  return !isBranchBatch(batch) && !isMergedBatch(batch);
}

/** 批次的工艺「底稿」来源批次 id：分支继承父批次（只读），其余取自身 */
export function processSourceBatchId(batch: Batch): string {
  return isBranchBatch(batch) ? (batch.parentBatchId as string) : batch.id;
}

/** 批次展示前缀：分支加「支 n」，合回加「合回」 */
export function batchBranchTag(batch: Batch): string | null {
  if (isMergedBatch(batch)) return '合回';
  if (isBranchBatch(batch)) return `支${batch.branchNo ?? ''}`;
  return null;
}
