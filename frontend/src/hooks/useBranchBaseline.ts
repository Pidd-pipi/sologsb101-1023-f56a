/**
 * useBranchBaseline(batchId)
 * 拆批分支继承的拆分前工艺只读底稿（做青 / 杀青 / 焙火页消费）。
 * 非分支批次返回 null；底稿尚未加载时返回 undefined（调用方据此区分）。
 */
import { useMemo } from 'react';
import { useBatchStore } from '../stores/batchStore';
import { useSplitMergeStore } from '../stores/splitMergeStore';
import { lineageOf } from '../utils/splitMerge';
import type { ProcessBaseline } from '../types/split';

export function useBranchBaseline(batchId: string | null | undefined): ProcessBaseline | null {
  const batches = useBatchStore((state) => state.batches);
  const baselines = useSplitMergeStore((state) => state.baselines);

  return useMemo(() => {
    if (!batchId) return null;
    const batch = batches.find((item) => item.id === batchId);
    if (!batch) return null;
    const lineage = lineageOf(batch);
    if (lineage.kind !== 'branch') return null;
    return baselines.find((item) => item.id === lineage.baselineId) ?? null;
  }, [baselines, batches, batchId]);
}

export default useBranchBaseline;
