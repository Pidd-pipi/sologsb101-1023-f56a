/**
 * 拆批 / 合回工作台状态管理（Zustand）· splitMergeStore.ts
 * - 拆批：乐观锁提交（两个页签并发拆分时，后提交方看到最新剩余量且不覆盖先提交结果）
 * - 合回：创建 / 实时失效判定 / 重算（失败恢复旧结果并允许重试）/ 确认落库
 * - 草稿（未提交拆批表单）保留在 localStorage，冲突或刷新后仍在
 */
import { create } from 'zustand';
import { liveQuery, type Subscription } from 'dexie';
import type { Batch } from '../types/batch';
import { batchStateOrder, SPLIT_MIN_STATE } from '../types/batch';
import type { ProcessBaseline, SplitRecord } from '../types/split';
import type { MergeRecord, MergeStatus } from '../types/merge';
import {
  ID_PREFIX,
  createId,
  db,
  getBaseline,
  listBaselines,
  listMerges,
  listSplits,
  nowIso,
  putBaseline,
  putBatch,
  putBatches,
  putMerge,
  putReview,
  putSplit,
  removeMerge as removeMergeRow,
} from '../utils/db';
import {
  branchesMatchGroup,
  buildMergeRefs,
  computeMergeResult,
  isMergeStale,
  lineageOf,
  measureWeightKg,
  mergeFingerprint,
  mergeStateOf,
  revisionOf,
  summarizeSplit,
} from '../utils/splitMerge';
import { useBatchStore } from './batchStore';
import { useGardenStore } from './gardenStore';
import { useRoastStore } from './roastStore';

/** localStorage 草稿键：未提交的拆批表单（分支公斤 / 余量思路），按母批 id 存放 */
const SPLIT_DRAFT_KEY = 'gbtearock.splitDrafts.v1';

/** 并发拆分冲突：后提交方据此看到最新剩余量并保留草稿重填 */
export class SplitConflictError extends Error {
  /** 先提交方拆分后母批的最新剩余量 */
  latestRemainderKg: number;
  latestRevision: number;
  constructor(latestRemainderKg: number, latestRevision: number) {
    super('母批已被另一个页签拆分，剩余量有更新，请按最新剩余量调整后重试');
    this.name = 'SplitConflictError';
    this.latestRemainderKg = latestRemainderKg;
    this.latestRevision = latestRevision;
  }
}

interface SplitDraftMap {
  [sourceBatchId: string]: { weightKg: number; routeNote: string }[];
}

/** 读取本地保留的拆批草稿（两个页签并发时，冲突后草稿不丢） */
export function loadSplitDrafts(): SplitDraftMap {
  try {
    const raw = localStorage.getItem(SPLIT_DRAFT_KEY);
    return raw ? (JSON.parse(raw) as SplitDraftMap) : {};
  } catch {
    return {};
  }
}

/** 保留拆批草稿到本地 */
export function saveSplitDrafts(drafts: SplitDraftMap): void {
  try {
    localStorage.setItem(SPLIT_DRAFT_KEY, JSON.stringify(drafts));
  } catch {
    // 隐私模式等场景写不进就放弃持久化，不阻断操作
  }
}

/** 清除某个母批的草稿 */
export function clearSplitDraft(sourceBatchId: string): void {
  const drafts = loadSplitDrafts();
  if (drafts[sourceBatchId]) {
    delete drafts[sourceBatchId];
    saveSplitDrafts(drafts);
  }
}

interface SplitMergeStoreState {
  splits: SplitRecord[];
  baselines: ProcessBaseline[];
  merges: MergeRecord[];
  loading: boolean;
  error: string;
  loadAll: () => Promise<void>;
  /** 订阅批次 / 审评变化：分支重量或审评分一变，立即把受影响合回标记失效（全应用生效） */
  startStalenessWatch: () => () => void;
  /** 提交拆批：重量合计校验 + 乐观锁，冲突抛 SplitConflictError 且保留草稿 */
  commitSplit: (sourceBatchId: string, drafts: { weightKg: number; routeNote: string }[]) => Promise<SplitRecord>;
  /** 创建合回记录（status=draft，带首次预演结果） */
  createMerge: (name: string, branchIds: string[]) => Promise<MergeRecord>;
  /** 重算合回；失败保留旧结果并标记 failed，允许重试 */
  recomputeMerge: (mergeId: string) => Promise<MergeRecord | null>;
  /** 确认合回：新茶青批次 + 加权审评落库，分支标记 mergedInto */
  confirmMerge: (mergeId: string) => Promise<MergeRecord | null>;
  /** 放弃 / 删除未确认合回（分支从合回候选恢复） */
  discardMerge: (mergeId: string) => Promise<void>;
  /**
   * 依据当前批次 / 审评数据，把已确认或草稿合回里分支重量 / 审评已变的记录标记失效。
   * 返回发生变化的合回记录（调用方决定是否提示）。
   */
  refreshMergeStaleness: () => Promise<MergeRecord[]>;
  /** 取某分支继承的只读底稿 */
  baselineOfBranch: (batchId: string) => Promise<ProcessBaseline | undefined>;
}

export const useSplitMergeStore = create<SplitMergeStoreState>((set, get) => ({
  splits: [],
  baselines: [],
  merges: [],
  loading: false,
  error: '',

  async loadAll() {
    set({ loading: true, error: '' });
    try {
      const [splits, baselines, merges] = await Promise.all([
        listSplits(),
        listBaselines(),
        listMerges(),
      ]);
      set({ splits, baselines, merges, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '拆并数据读取失败' });
    }
  },

  startStalenessWatch() {
    // 批次或审评任一变化都重新评估；refreshMergeStaleness 内部用指纹决定是否落库，无变化不写
    const batchSub: Subscription = liveQuery(() => db.batches.toArray()).subscribe({
      next: () => {
        void get().refreshMergeStaleness();
      },
    });
    const reviewSub: Subscription = liveQuery(() => db.reviews.toArray()).subscribe({
      next: () => {
        void get().refreshMergeStaleness();
      },
    });
    return () => {
      batchSub.unsubscribe();
      reviewSub.unsubscribe();
    };
  },

  async commitSplit(sourceBatchId, drafts) {
    const batches = useBatchStore.getState().batches;
    const source = batches.find((item) => item.id === sourceBatchId);
    if (!source) throw new Error('母批不存在或已被删除');
    if (batchStateOrder(source.state) < batchStateOrder(SPLIT_MIN_STATE)) {
      throw new Error(`需先完成「${SPLIT_MIN_STATE}」才能分路焙火（拆批）`);
    }
    if (lineageOf(source).kind === 'merged') {
      throw new Error('合回产生的新批次不能再次拆批');
    }

    const summary = summarizeSplit(
      measureWeightKg(source),
      drafts.map((draft, index) => ({ branchNo: index + 1, weightKg: draft.weightKg, routeNote: draft.routeNote })),
    );
    if (!summary.valid) {
      throw new Error(
        `重量合计对不上原批次：各支合计 ${summary.branchTotalKg} kg，余量 ${summary.remainderKg} kg（原批次 ${summary.originalKg} kg）。每支需大于 0，且至少两支。`,
      );
    }

    const stamp = nowIso();
    const splitId = createId(ID_PREFIX.split);
    const baselineId = createId(ID_PREFIX.baseline);

    // 事务内再次读母批做乐观锁判定，保证两个页签并发时后提交方不覆盖先提交结果
    const record = await db.transaction(
      'rw',
      [db.batches, db.turns, db.fixes, db.roasts, db.splits, db.baselines],
      async () => {
        const fresh = await db.batches.get(sourceBatchId);
        if (!fresh) throw new Error('母批不存在或已被删除');
        if (revisionOf(fresh) !== revisionOf(source)) {
          throw new SplitConflictError(measureWeightKg(fresh), revisionOf(fresh));
        }

        const [turns, fixes, roasts] = await Promise.all([
          db.turns.where('batchId').equals(sourceBatchId).toArray(),
          db.fixes.where('batchId').equals(sourceBatchId).toArray(),
          db.roasts.where('batchId').equals(sourceBatchId).toArray(),
        ]);

        // 1) 只读底稿：拆分前的做青 / 杀青 / 焙火快照
        const baseline: ProcessBaseline = {
          id: baselineId,
          splitId,
          sourceBatchId,
          sourceState: fresh.state,
          turns,
          fix: fixes[0] ?? null,
          roasts: roasts.sort((a, b) => a.passNo - b.passNo),
          createdAt: stamp,
          updatedAt: stamp,
        };
        await putBaseline(baseline);

        // 2) 各支新批次，重量 = 该支公斤，继承母批工序状态
        const branchRows: Batch[] = drafts.map((draft, index) => {
          const weight = draft.weightKg;
          return {
            ...fresh,
            id: createId(ID_PREFIX.batch),
            freshLeafKg: weight,
            maochaKg: weight,
            state: fresh.state,
            weather: fresh.weather,
            lineage: { kind: 'branch' as const, splitId, branchNo: index + 1, baselineId },
            revision: 1,
            mergedInto: null,
            createdAt: stamp,
            updatedAt: stamp,
          };
        });

        // 3) 母批保留余量（重量改为余量，血缘标为 remainder）
        const remainder: Batch = {
          ...fresh,
          freshLeafKg: summary.remainderKg,
          maochaKg: summary.remainderKg,
          lineage: { kind: 'remainder', splitId },
          revision: revisionOf(fresh) + 1,
          mergedInto: null,
          updatedAt: stamp,
        };

        await putBatches([...branchRows, remainder]);

        const split: SplitRecord = {
          id: splitId,
          sourceBatchId,
          originalWeightKg: summary.originalKg,
          remainderWeightKg: summary.remainderKg,
          branches: branchRows.map((row, index) => ({
            branchNo: index + 1,
            batchId: row.id,
            weightKg: summary.branchTotalKg ? drafts[index].weightKg : row.freshLeafKg,
            routeNote: drafts[index].routeNote.trim() || `第 ${index + 1} 路`,
          })),
          baselineId,
          stateAtSplit: fresh.state,
          baseRevision: revisionOf(fresh),
          createdAt: stamp,
          updatedAt: stamp,
        };
        await putSplit(split);
        return split;
      },
    );

    clearSplitDraft(sourceBatchId);
    await Promise.all([
      useBatchStore.getState().loadBatches(),
      useRoastStore.getState().loadRoasts(),
      get().loadAll(),
    ]);
    return record;
  },

  async createMerge(name, branchIds) {
    const batches = useBatchStore.getState().batches;
    const gardens = useGardenStore.getState().gardens;
    const group = branchesMatchGroup(batches, gardens, branchIds);
    if (!group) {
      throw new Error('合回只接同山场、品种、工序的分支，且分支不能已经合回');
    }
    const unique = [...new Set(branchIds)];
    if (unique.length < 2) throw new Error('至少挑选 2 路分支才能合回');

    const branchRows = unique
      .map((id) => batches.find((batch) => batch.id === id))
      .filter((batch): batch is Batch => Boolean(batch));
    const garden = gardens.find((item) => item.id === group.gardenId);
    const reviews = await db.reviews.toArray();
    const result = computeMergeResult(branchRows, reviews, garden, group.state);

    const stamp = nowIso();
    const record: MergeRecord = {
      id: createId(ID_PREFIX.merge),
      name: name.trim() || `合回批次 · ${group.gardenName} · ${stamp.slice(0, 10)}`,
      status: 'draft',
      branches: buildMergeRefs(batches, reviews, unique),
      result,
      outputBatchId: null,
      outputReviewId: null,
      invalidReason: '',
      fingerprint: mergeFingerprint(branchRows, reviews),
      computedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await putMerge(record);
    await get().loadAll();
    return record;
  },

  async recomputeMerge(mergeId) {
    const existing = get().merges.find((item) => item.id === mergeId);
    if (!existing) return null;
    const batches = useBatchStore.getState().batches;
    const gardens = useGardenStore.getState().gardens;
    const stamp = nowIso();

    try {
      const branchRows = existing.branches
        .map((ref) => batches.find((batch) => batch.id === ref.batchId))
        .filter((batch): batch is Batch => Boolean(batch));
      if (branchRows.length !== existing.branches.length) {
        throw new Error('有分支批次已不存在，无法重算');
      }
      const garden = gardens.find((item) => item.id === branchRows[0].gardenId);
      const group = branchesMatchGroup(batches, gardens, branchRows.map((batch) => batch.id));
      if (!group) throw new Error('分支已不再满足同山场、品种、工序');

      const reviews = await db.reviews.toArray();
      const result = computeMergeResult(branchRows, reviews, garden, mergeStateOf(branchRows));

      // 已确认合回：同步刷新输出批次重量 / 审评，保持 confirmed
      let status: MergeStatus = existing.status === 'confirmed' ? 'confirmed' : 'draft';
      if (existing.status === 'failed' || existing.status === 'stale') {
        status = 'draft';
      }
      const next: MergeRecord = {
        ...existing,
        branches: buildMergeRefs(batches, reviews, branchRows.map((batch) => batch.id)),
        result,
        status,
        invalidReason: '',
        fingerprint: mergeFingerprint(branchRows, reviews),
        computedAt: stamp,
        updatedAt: stamp,
      };

      if (existing.status === 'confirmed' && existing.outputBatchId) {
        const output = await db.batches.get(existing.outputBatchId);
        if (output) {
          await putBatch({
            ...output,
            freshLeafKg: result.weightKg,
            maochaKg: result.weightKg,
            state: result.state,
            revision: revisionOf(output) + 1,
            updatedAt: stamp,
          });
        }
        if (existing.outputReviewId && result.weightedScores) {
          const review = await db.reviews.get(existing.outputReviewId);
          if (review) {
            await putReview({
              ...review,
              aroma: result.weightedScores.aroma,
              liquorColor: result.weightedScores.liquorColor,
              taste: result.weightedScores.taste,
              leafBase: result.weightedScores.leafBase,
              totalScore: result.totalScore ?? review.totalScore,
              updatedAt: stamp,
            });
          }
        }
      }

      await putMerge(next);
      await Promise.all([
        useBatchStore.getState().loadBatches(),
        useBatchStore.getState().loadReviews(),
        get().loadAll(),
      ]);
      return next;
    } catch (error) {
      // 重算失败：恢复旧结果（保留 result 不覆盖），标记 failed 并允许重试
      const failed: MergeRecord = {
        ...existing,
        status: 'failed',
        invalidReason: error instanceof Error ? error.message : '合回重算失败',
        updatedAt: stamp,
      };
      await putMerge(failed);
      await get().loadAll();
      return null;
    }
  },

  async confirmMerge(mergeId) {
    const existing = get().merges.find((item) => item.id === mergeId);
    if (!existing) return null;
    if (!existing.result) throw new Error('合回结果尚未算出，无法确认');
    if (existing.status === 'stale' || existing.status === 'failed') {
      throw new Error('合回结果已失效，请先重算成功后再确认');
    }

    const batches = useBatchStore.getState().batches;
    const branchRows = existing.branches
      .map((ref) => batches.find((batch) => batch.id === ref.batchId))
      .filter((batch): batch is Batch => Boolean(batch));
    if (branchRows.length !== existing.branches.length) throw new Error('有分支批次已不存在');

    const reviews = await db.reviews.toArray();
    if (isMergeStale(existing, batches, reviews)) {
      throw new Error('分支重量或审评分刚发生变化，请先重算再确认');
    }

    const stamp = nowIso();
    const result = existing.result;
    const outputId = createId(ID_PREFIX.batch);
    const reviewId = result.weightedScores ? createId(ID_PREFIX.review) : null;
    const pickedAt = stamp.slice(0, 10);

    await db.transaction(
      'rw',
      [db.batches, db.reviews, db.merges],
      async () => {
        const output: Batch = {
          id: outputId,
          gardenId: result.gardenId,
          pickedAt,
          freshLeafKg: result.weightKg,
          maochaKg: result.weightKg,
          tenderness: branchRows[0].tenderness,
          weather: `${existing.name}（${branchRows.length} 路合回）`,
          state: result.state,
          lineage: { kind: 'merged', mergeId },
          revision: 1,
          mergedInto: null,
          createdAt: stamp,
          updatedAt: stamp,
        };
        await putBatch(output);

        if (reviewId && result.weightedScores && typeof result.totalScore === 'number') {
          await putReview({
            id: reviewId,
            batchId: outputId,
            reviewedAt: pickedAt,
            aroma: result.weightedScores.aroma,
            liquorColor: result.weightedScores.liquorColor,
            taste: result.weightedScores.taste,
            leafBase: result.weightedScores.leafBase,
            totalScore: result.totalScore,
            blendNote: `${existing.name} · ${branchRows.length} 路按毛茶重量加权合回`,
            createdAt: stamp,
            updatedAt: stamp,
          });
        }

        // 分支标记已合回（退出拼配候选）；保留改写后的批次用于重算指纹基线
        const updatedBranches = await Promise.all(
          branchRows.map(async (batch) => {
            const updated: Batch = {
              ...batch,
              mergedInto: mergeId,
              revision: revisionOf(batch) + 1,
              updatedAt: stamp,
            };
            await putBatch(updated);
            return updated;
          }),
        );

        await putMerge({
          ...existing,
          status: 'confirmed',
          outputBatchId: outputId,
          outputReviewId: reviewId,
          invalidReason: '',
          // 指纹按确认后的分支版本重算，避免确认写入被失效监听误判为“分支一变”
          branches: buildMergeRefs(updatedBranches, reviews, updatedBranches.map((batch) => batch.id)),
          fingerprint: mergeFingerprint(updatedBranches, reviews),
          updatedAt: stamp,
        });
      },
    );

    await Promise.all([
      useBatchStore.getState().loadBatches(),
      useBatchStore.getState().loadReviews(),
      useGardenStore.getState().loadGardens(),
      get().loadAll(),
    ]);
    return get().merges.find((item) => item.id === mergeId) ?? null;
  },

  async discardMerge(mergeId) {
    const existing = get().merges.find((item) => item.id === mergeId);
    if (existing?.status === 'confirmed') {
      throw new Error('已确认合回不能放弃（来源需留档）');
    }
    await removeMergeRow(mergeId);
    await get().loadAll();
  },

  async refreshMergeStaleness() {
    const batches = useBatchStore.getState().batches;
    const reviews = await db.reviews.toArray();
    const stamp = nowIso();
    const changed: MergeRecord[] = [];
    const next = get().merges.map((record) => {
      // failed 保留旧结果等待用户手动重试，不自动覆盖
      if (record.status === 'failed') return record;
      const stale = isMergeStale(record, batches, reviews);
      if (stale && record.status !== 'stale') {
        const updated: MergeRecord = {
          ...record,
          status: 'stale',
          invalidReason: '分支重量或审评分已变化，合回结果已失效，请重算',
          updatedAt: stamp,
        };
        changed.push(updated);
        return updated;
      }
      return record;
    });
    if (changed.length > 0) {
      await Promise.all(changed.map((record) => putMerge(record)));
      set({ merges: next });
    }
    return changed;
  },

  async baselineOfBranch(batchId) {
    const batches = useBatchStore.getState().batches;
    const batch = batches.find((item) => item.id === batchId);
    const lineage = batch ? lineageOf(batch) : undefined;
    if (!batch || !lineage || lineage.kind !== 'branch') return undefined;
    return getBaseline(lineage.baselineId);
  },
}));

export default useSplitMergeStore;
