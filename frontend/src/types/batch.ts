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
  /** 鲜叶重量（公斤） */
  freshLeafKg: number;
  /** 嫩度 */
  tenderness: Tenderness;
  /** 气象备注，例如「晴，北风 2 级」 */
  weather: string;
  /** 工序状态 */
  state: BatchState;
  /**
   * 毛茶重量（公斤）。杀青 / 焙火后以毛茶计量；合回审评分按此重量加权。
   * 旧数据缺省时取鲜叶重量 freshLeafKg（按单支批次兼容）。
   */
  maochaKg?: number;
  /** 拆批 / 合回血缘；v3 迁移与旧数据导入缺省为 { kind: 'single' } */
  lineage?: BatchLineage;
  /** 乐观锁版本号：每次落库 +1，两个页签并发拆分时用它判定剩余量是否已被先提交方改动 */
  revision?: number;
  /** 已合回的批次指向的合回记录 id（合回确认后写入，已合回分支退出拼配候选） */
  mergedInto?: string | null;
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

/* ------------------------ 拆批 / 合回血缘（v3 起） ------------------------ */

/**
 * 批次血缘：
 * - single：普通单支批次（旧数据迁移与导入的默认形态，按单支批次兼容）
 * - remainder：拆批后的母批余量，仍留在原批次上
 * - branch：拆批分出的焙火支，继承拆分前工艺为只读底稿
 * - merged：合回产生的新茶青批次
 */
export type BatchLineage =
  | { kind: 'single' }
  | { kind: 'remainder'; splitId: string }
  | { kind: 'branch'; splitId: string; branchNo: number; baselineId: string }
  | { kind: 'merged'; mergeId: string };

/** 拆批 / 合回的最小工序门槛：杀青之后才允许分路焙火 */
export const SPLIT_MIN_STATE: BatchState = '已杀青';
