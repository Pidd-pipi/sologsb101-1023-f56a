/**
 * 拆并工作台状态管理（Zustand）· mergeStore.ts
 * - 订阅批次 / 审评 / 山场 / 合回记录，派生分支来源与合回失效状态
 * - 合回「立即失效」：来源分支重量或审评一变，合回结果即时判为 stale 并从拼配候选撤下
 * - 重算失败恢复旧结果（不覆盖已落库批次 / 审评），保留错误并允许重试
 * - 拆批走 db.splitBatch 事务：事务内重读最新余量，并发拆分不覆盖先提交结果
 */
import { create } from 'zustand';
import { liveQuery, type Subscription } from 'dexie';
import type { Batch } from '../types/batch';
import type { Garden } from '../types/garden';
import type { Review } from '../types/review';
import type { MergeRecord, MergeSource } from '../types/merge';
import {
  buildMergeSources,
  confirmMerge as confirmMergeRow,
  listBatches,
  listGardens,
  listMerges,
  listReviews,
  recomputeMerge as recomputeMergeRow,
  removeMerge as removeMergeRow,
  splitBatch as splitBatchRow,
  type SplitBranchInput,
} from '../utils/db';
import { computeMergePreview, isMergeStale, mergeCompatibilityKey } from '../utils/tea';

/** 合回来源分支（带审评与山场信息，供合回选择与预览） */
export interface MergeBranchSource {
  branch: Batch;
  garden: Garden | undefined;
  review: Review | undefined;
  compatKey: string;
}

/** 带有效状态的合回记录 */
export interface EffectiveMerge extends MergeRecord {
  effectiveStatus: 'confirmed' | 'stale';
}

interface MergeStoreState {
  batches: Batch[];
  gardens: Garden[];
  reviews: Review[];
  merges: MergeRecord[];
  loading: boolean;
  error: string;
  /** 已失效合回的审评 id 集合（拼配候选据此撤下） */
  staleReviewIds: string[];
  loadAll: () => Promise<void>;
  splitBatch: (parentId: string, rows: SplitBranchInput[]) => Promise<{ branchCount: number; remaining: number }>;
  confirmMerge: (sourceBatchIds: string[]) => Promise<MergeRecord>;
  recomputeMerge: (mergeId: string) => Promise<void>;
  removeMerge: (mergeId: string) => Promise<void>;
}

/** 由当前数据计算合回的有效状态 */
function resolveEffectiveStatus(
  merge: MergeRecord,
  branchesById: Map<string, Batch>,
  reviewsByBatch: Map<string, Review>,
): 'confirmed' | 'stale' {
  if (merge.status === 'stale') return 'stale';
  const current = merge.sources.map((source) => {
    const branch = branchesById.get(source.batchId);
    const review = branch ? reviewsByBatch.get(branch.id) : undefined;
    return {
      batchId: source.batchId,
      weightKg: branch && Number.isFinite(branch.freshLeafKg) ? branch.freshLeafKg : -1,
      reviewId: review ? review.id : '',
      totalScore: review && Number.isFinite(review.totalScore) ? review.totalScore : -1,
    };
  });
  if (current.some((item) => item.weightKg < 0 || !item.reviewId)) return 'stale';
  return isMergeStale(merge, current) ? 'stale' : 'confirmed';
}

/** 组装合回来源（缺审评的分支不参与合回） */
function buildBranchSources(
  batches: Batch[],
  reviews: Review[],
  gardens: Garden[],
): MergeBranchSource[] {
  const gardenMap = new Map(gardens.map((garden) => [garden.id, garden]));
  const reviewMap = new Map(reviews.map((review) => [review.batchId, review]));
  return batches
    .filter((batch) => Boolean(batch.parentBatchId))
    .map((branch) => {
      const garden = gardenMap.get(branch.gardenId);
      return {
        branch,
        garden,
        review: reviewMap.get(branch.id),
        compatKey: mergeCompatibilityKey(branch.gardenId, branch.state),
      };
    })
    .filter((source) => Boolean(source.review));
}

export const useMergeStore = create<MergeStoreState>((set, get) => {
  let subscription: Subscription | null = null;

  /** 订阅四张表，任一变化即重算派生数据（跨页签 / 跨操作自动刷新） */
  function subscribe() {
    if (subscription) return;
    const query = liveQuery(async () => {
      const [batches, reviews, gardens, merges] = await Promise.all([
        listBatches(),
        listReviews(),
        listGardens(),
        listMerges(),
      ]);
      return { batches, reviews, gardens, merges };
    });
    subscription = query.subscribe({
      next: ({ batches, reviews, gardens, merges }) => {
        const branchesById = new Map(
          batches.filter((batch) => batch.parentBatchId).map((batch) => [batch.id, batch]),
        );
        const reviewsByBatch = new Map(reviews.map((review) => [review.batchId, review]));
        const staleReviewIds = merges
          .filter((merge) => resolveEffectiveStatus(merge, branchesById, reviewsByBatch) === 'stale')
          .map((merge) => merge.reviewId);
        set({ batches, reviews, gardens, merges, staleReviewIds, loading: false, error: '' });
      },
      error: (err: unknown) => {
        set({ error: err instanceof Error ? err.message : '拆并数据读取失败', loading: false });
      },
    });
  }

  return {
    batches: [],
    gardens: [],
    reviews: [],
    merges: [],
    loading: false,
    error: '',
    staleReviewIds: [],

    async loadAll() {
      set({ loading: true, error: '' });
      try {
        subscribe();
        const [batches, reviews, gardens, merges] = await Promise.all([
          listBatches(),
          listReviews(),
          listGardens(),
          listMerges(),
        ]);
        const branchesById = new Map(
          batches.filter((batch) => batch.parentBatchId).map((batch) => [batch.id, batch]),
        );
        const reviewsByBatch = new Map(reviews.map((review) => [review.batchId, review]));
        const staleReviewIds = merges
          .filter((merge) => resolveEffectiveStatus(merge, branchesById, reviewsByBatch) === 'stale')
          .map((merge) => merge.reviewId);
        set({ batches, reviews, gardens, merges, staleReviewIds, loading: false });
      } catch (error) {
        set({ loading: false, error: error instanceof Error ? error.message : '拆并数据读取失败' });
      }
    },

    async splitBatch(parentId, rows) {
      const result = await splitBatchRow(parentId, rows);
      return {
        branchCount: result.branches.length,
        remaining: result.parent.freshLeafKg,
      };
    },

    async confirmMerge(sourceBatchIds) {
      const { batches, reviews, gardens } = get();
      const branchMap = new Map(
        batches.filter((batch) => batch.parentBatchId).map((batch) => [batch.id, batch]),
      );
      const reviewsByBatch = new Map(reviews.map((review) => [review.batchId, review]));
      const gardenMap = new Map(gardens.map((garden) => [garden.id, garden]));
      const branches = sourceBatchIds
        .map((id) => branchMap.get(id))
        .filter((batch): batch is Batch => Boolean(batch));
      if (branches.length < 2) throw new Error('合回至少需要 2 支带审评的分支');
      const compatKey = mergeCompatibilityKey(branches[0].gardenId, branches[0].state);
      if (!branches.every((branch) => mergeCompatibilityKey(branch.gardenId, branch.state) === compatKey)) {
        throw new Error('来源分支山场或工序不一致，不能合回');
      }
      const sources: MergeSource[] = buildMergeSources({ branches, reviewsByBatch, gardens: gardenMap });
      const preview = computeMergePreview(sources);
      return confirmMergeRow({
        sources,
        totalWeightKg: preview.totalWeightKg,
        resultScore: preview.resultScore,
        aroma: preview.aroma,
        liquorColor: preview.liquorColor,
        taste: preview.taste,
        leafBase: preview.leafBase,
      });
    },

    async recomputeMerge(mergeId) {
      await recomputeMergeRow(mergeId);
    },

    async removeMerge(mergeId) {
      await removeMergeRow(mergeId);
    },
  };
});

/** 选择器：合回来源分支（带审评） */
export function selectMergeBranchSources(state: MergeStoreState): MergeBranchSource[] {
  return buildBranchSources(state.batches, state.reviews, state.gardens);
}

/** 选择器：带有效状态的合回记录 */
export function selectEffectiveMerges(state: MergeStoreState): EffectiveMerge[] {
  const branchesById = new Map(
    state.batches.filter((batch) => batch.parentBatchId).map((batch) => [batch.id, batch]),
  );
  const reviewsByBatch = new Map(state.reviews.map((review) => [review.batchId, review]));
  return state.merges.map((merge) => ({
    ...merge,
    effectiveStatus: resolveEffectiveStatus(merge, branchesById, reviewsByBatch),
  }));
}

export default useMergeStore;
