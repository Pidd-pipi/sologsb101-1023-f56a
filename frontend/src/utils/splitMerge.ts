/**
 * 拆批 / 合回纯函数工具集（utils/splitMerge.ts）
 * 只做重量合计校验、可合回分组、毛茶重量加权审评与失效指纹计算。
 * 不碰数据库、不碰 React（store 与页面复用）。
 */
import type { Batch } from '../types/batch';
import { batchStateOrder, type BatchLineage, type BatchState } from '../types/batch';
import type { Garden } from '../types/garden';
import type { Review, ReviewScoreKey } from '../types/review';
import { REVIEW_WEIGHTS, REVIEW_SCORE_MAX } from '../types/review';
import type { MergeBranchRef, MergeGroup, MergeResult } from '../types/merge';
import type { SplitBranchDraft, SplitWeightSummary } from '../types/split';
import { roundTo } from './tea';

/** 浮点重量比较误差（公斤），录入到 0.1kg */
export const WEIGHT_EPSILON = 0.05;

/* ------------------------------- 血缘判定 ------------------------------- */

/** 读取批次血缘（旧数据缺省按单支批次） */
export function lineageOf(batch: Batch): BatchLineage {
  return batch.lineage ?? { kind: 'single' };
}

/** 是否为拆批分支 */
export function isBranchBatch(batch: Batch): boolean {
  return lineageOf(batch).kind === 'branch';
}

/** 是否为合回产生的新批次 */
export function isMergedBatch(batch: Batch): boolean {
  return lineageOf(batch).kind === 'merged';
}

/** 是否为母批余量 */
export function isRemainderBatch(batch: Batch): boolean {
  return lineageOf(batch).kind === 'remainder';
}

/** 批次当前计量重量：毛茶重量优先，旧数据缺省取鲜叶重量（单支兼容） */
export function measureWeightKg(batch: Batch): number {
  if (typeof batch.maochaKg === 'number' && Number.isFinite(batch.maochaKg) && batch.maochaKg > 0) {
    return batch.maochaKg;
  }
  return batch.freshLeafKg;
}

/** 乐观锁版本：旧数据缺省为 1 */
export function revisionOf(batch: Batch): number {
  return typeof batch.revision === 'number' && Number.isFinite(batch.revision) ? batch.revision : 1;
}

/* ------------------------------- 拆批校验 ------------------------------- */

/**
 * 拆批重量合计：各支公斤求和 + 余量，必须对回原批次。
 * 每支需 > 0；各支合计不得超过原批次；余量 = 原批次 - 各支合计（≥ 0）。
 */
export function summarizeSplit(originalKg: number, drafts: SplitBranchDraft[]): SplitWeightSummary {
  const validDrafts = drafts.filter((draft) => Number.isFinite(draft.weightKg) && draft.weightKg > 0);
  const branchTotalKg = roundTo(
    validDrafts.reduce((acc, draft) => acc + draft.weightKg, 0),
    2,
  );
  const remainderKg = roundTo(originalKg - branchTotalKg, 2);
  const diffKg = roundTo(branchTotalKg + remainderKg - originalKg, 2);
  const valid =
    validDrafts.length >= 2 &&
    validDrafts.length === drafts.length &&
    remainderKg >= -WEIGHT_EPSILON &&
    Math.abs(diffKg) <= WEIGHT_EPSILON &&
    branchTotalKg > 0 &&
    branchTotalKg <= originalKg + WEIGHT_EPSILON;
  return {
    branchCount: validDrafts.length,
    branchTotalKg,
    remainderKg: Math.max(0, remainderKg),
    originalKg,
    diffKg,
    valid,
  };
}

/* ------------------------------- 合回分组 ------------------------------- */

/** 可参与合回的分支：血缘为 branch 且尚未合回 */
export function mergeableBranches(batches: Batch[]): Batch[] {
  return batches.filter((batch) => isBranchBatch(batch) && !batch.mergedInto);
}

/**
 * 合回只接同山场、品种和工序的分支：
 * 按 gardenId + cultivar + state 分组，仅含 ≥2 支或被选中单支的组才有用（页面决定取哪些）。
 */
export function buildMergeGroups(batches: Batch[], gardens: Garden[]): MergeGroup[] {
  const gardenMap = new Map(gardens.map((garden) => [garden.id, garden]));
  const map = new Map<string, MergeGroup>();
  mergeableBranches(batches)
    .sort((a, b) => a.pickedAt.localeCompare(b.pickedAt))
    .forEach((batch) => {
      const garden = gardenMap.get(batch.gardenId);
      const cultivar = garden?.cultivar ?? '未标注';
      const key = `${batch.gardenId}::${cultivar}::${batch.state}`;
      const group = map.get(key);
      if (group) {
        group.branchBatchIds.push(batch.id);
      } else {
        map.set(key, {
          key,
          gardenId: batch.gardenId,
          gardenName: garden?.name ?? '未知山场',
          cultivar,
          state: batch.state,
          branchBatchIds: [batch.id],
        });
      }
    });
  return [...map.values()];
}

/** 判断若干分支是否同山场、品种、工序（合回接收门槛） */
export function branchesMatchGroup(batches: Batch[], gardens: Garden[], branchIds: string[]): MergeGroup | null {
  const groups = buildMergeGroups(batches, gardens);
  const selected = new Set(branchIds);
  return groups.find((group) => group.branchBatchIds.length === branchIds.length && group.branchBatchIds.every((id) => selected.has(id))) ?? null;
}

/* ----------------------------- 毛茶重量加权 ----------------------------- */

/** 取一批分支的最新审评（每批取 reviewedAt 最新一条） */
export function latestReviewByBatch(reviews: Review[]): Map<string, Review> {
  const map = new Map<string, Review>();
  reviews.forEach((review) => {
    const prev = map.get(review.batchId);
    if (!prev || review.reviewedAt > prev.reviewedAt) map.set(review.batchId, review);
  });
  return map;
}

/**
 * 合回结果：新批次重量 = 各分支毛茶重量相加；
 * 审评分按毛茶重量加权（有审评分支才计入分母）。
 */
export function computeMergeResult(
  branches: Batch[],
  reviews: Review[],
  garden: Garden | undefined,
  state: BatchState,
): MergeResult {
  const weightKg = roundTo(
    branches.reduce((acc, batch) => acc + measureWeightKg(batch), 0),
    2,
  );
  const reviewMap = latestReviewByBatch(reviews);

  let scoredWeightKg = 0;
  const sums = { aroma: 0, liquorColor: 0, taste: 0, leafBase: 0, totalScore: 0 };
  branches.forEach((batch) => {
    const review = reviewMap.get(batch.id);
    if (!review) return;
    const weight = measureWeightKg(batch);
    scoredWeightKg = roundTo(scoredWeightKg + weight, 2);
    sums.aroma += review.aroma * weight;
    sums.liquorColor += review.liquorColor * weight;
    sums.taste += review.taste * weight;
    sums.leafBase += review.leafBase * weight;
    sums.totalScore += review.totalScore * weight;
  });

  const weightedScores: Record<ReviewScoreKey, number> | null =
    scoredWeightKg > 0
      ? {
          aroma: roundTo(sums.aroma / scoredWeightKg, 1),
          liquorColor: roundTo(sums.liquorColor / scoredWeightKg, 1),
          taste: roundTo(sums.taste / scoredWeightKg, 1),
          leafBase: roundTo(sums.leafBase / scoredWeightKg, 1),
        }
      : null;

  const totalScore =
    scoredWeightKg > 0
      ? roundTo(Math.min(REVIEW_SCORE_MAX, sums.totalScore / scoredWeightKg), 1)
      : null;

  return {
    weightKg,
    totalScore,
    weightedScores,
    scoredWeightKg,
    gardenId: garden?.id ?? branches[0]?.gardenId ?? '',
    cultivar: garden?.cultivar ?? '未标注',
    state,
    branchCount: branches.length,
  };
}

/** 由加权分项反算总分（合回结果落库审评时复用，保持与分项权重一致） */
export function totalFromWeightedScores(scores: Record<ReviewScoreKey, number>): number {
  const total = (Object.keys(REVIEW_WEIGHTS) as ReviewScoreKey[]).reduce(
    (acc, key) => acc + scores[key] * REVIEW_WEIGHTS[key],
    0,
  );
  return roundTo(Math.min(REVIEW_SCORE_MAX, total), 1);
}

/* ------------------------------- 失效指纹 ------------------------------- */

/**
 * 合回失效指纹：参与分支的「版本 + 毛茶重量 + 审评总分」拼接。
 * 分支重量或审评分一变，指纹立即变化，合回结果标记失效并从拼配候选撤下。
 */
export function mergeFingerprint(branches: Batch[], reviews: Review[]): string {
  const reviewMap = latestReviewByBatch(reviews);
  return branches
    .map((batch) => {
      const review = reviewMap.get(batch.id);
      return `${batch.id}@${revisionOf(batch)}:${roundTo(measureWeightKg(batch), 2)}:${review ? review.totalScore : 'x'}`;
    })
    .sort()
    .join('|');
}

/** 构建合回分支引用（创建合回时快照各支当前重量 / 审评） */
export function buildMergeRefs(batches: Batch[], reviews: Review[], branchIds: string[]): MergeBranchRef[] {
  const byId = new Map(batches.map((batch) => [batch.id, batch]));
  const reviewMap = latestReviewByBatch(reviews);
  return branchIds
    .map((batchId) => {
      const batch = byId.get(batchId);
      if (!batch) return null;
      const review = reviewMap.get(batchId);
      return {
        batchId,
        weightKg: roundTo(measureWeightKg(batch), 2),
        totalScore: review ? review.totalScore : null,
        reviewId: review ? review.id : null,
      } satisfies MergeBranchRef;
    })
    .filter((ref): ref is MergeBranchRef => ref !== null);
}

/** 合回记录的当前指纹是否与落库时一致（不一致即失效） */
export function isMergeStale(record: { branches: MergeBranchRef[]; fingerprint: string }, batches: Batch[], reviews: Review[]): boolean {
  const byId = new Map(batches.map((batch) => [batch.id, batch]));
  const present = record.branches.filter((ref) => byId.has(ref.batchId));
  if (present.length !== record.branches.length) return true;
  const currentBatches = present.map((ref) => byId.get(ref.batchId) as Batch);
  return mergeFingerprint(currentBatches, reviews) !== record.fingerprint;
}

/** 合回结果工序状态：取各支中最靠前的工序（只向后推进，不超前） */
export function mergeStateOf(branches: Batch[]): BatchState {
  return branches.reduce<BatchState>(
    (acc, batch) => (batchStateOrder(batch.state) < batchStateOrder(acc) ? batch.state : acc),
    branches[0]?.state ?? '已焙火',
  );
}
