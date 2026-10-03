/**
 * /workbench 杀青后分路焙火「拆批 / 合回」工作台
 * - 拆批：写清各支公斤与余量，合计对回原批次；分支继承拆分前工艺为只读底稿；
 *   两个页签并发拆分时后提交方看到最新剩余量、保留草稿、不覆盖先提交结果。
 * - 合回：只接同山场 / 品种 / 工序的分支；新批次重量按分支重量相加，审评分按毛茶重量加权；
 *   分支重量或审评分一变结果立即失效并从拼配候选撤下；重算失败恢复旧结果并允许重试。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ApartmentOutlined,
  BranchesOutlined,
  DeleteOutlined,
  MergeCellsOutlined,
  PlusOutlined,
  ReloadOutlined,
  ScissorOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import BaselinePanel from '../components/common/BaselinePanel';
import { useGardenStore } from '../stores/gardenStore';
import { useBatchStore } from '../stores/batchStore';
import { loadSplitDrafts, saveSplitDrafts, SplitConflictError, useSplitMergeStore } from '../stores/splitMergeStore';
import { batchStateOrder, SPLIT_MIN_STATE, type Batch } from '../types/batch';
import type { ProcessBaseline, SplitRecord } from '../types/split';
import type { MergeRecord, MergeStatus } from '../types/merge';
import type { Review } from '../types/review';
import { db } from '../utils/db';
import { liveQuery } from 'dexie';
import {
  batchLabel,
  isBatchBlendEligible,
  roundTo,
} from '../utils/tea';
import {
  buildMergeGroups,
  isBranchBatch,
  isMergeStale,
  isRemainderBatch,
  lineageOf,
  measureWeightKg,
  summarizeSplit,
} from '../utils/splitMerge';

const MERGE_STATUS_META: Record<MergeStatus, { label: string; color: string }> = {
  draft: { label: '待确认（已撤下候选）', color: 'gold' },
  confirmed: { label: '已确认', color: 'green' },
  stale: { label: '已失效（已撤下候选）', color: 'volcano' },
  failed: { label: '重算失败（保留旧结果）', color: 'red' },
};

/** 拆分弹窗表单字段 */
interface SplitFormValues {
  branches: { weightKg: number; routeNote: string }[];
}

export default function SplitMergeWorkbench() {
  const { message, modal } = App.useApp();

  const gardens = useGardenStore((state) => state.gardens);
  const batches = useBatchStore((state) => state.batches);
  const loadBatches = useBatchStore((state) => state.loadBatches);
  const loadReviews = useBatchStore((state) => state.loadReviews);

  const splits = useSplitMergeStore((state) => state.splits);
  const baselines = useSplitMergeStore((state) => state.baselines);
  const merges = useSplitMergeStore((state) => state.merges);
  const loadAll = useSplitMergeStore((state) => state.loadAll);
  const commitSplit = useSplitMergeStore((state) => state.commitSplit);
  const createMerge = useSplitMergeStore((state) => state.createMerge);
  const recomputeMerge = useSplitMergeStore((state) => state.recomputeMerge);
  const confirmMerge = useSplitMergeStore((state) => state.confirmMerge);
  const discardMerge = useSplitMergeStore((state) => state.discardMerge);

  const [reviews, setReviews] = useState<Review[]>([]);

  const [splitModalBatch, setSplitModalBatch] = useState<Batch | null>(null);
  const [splitSubmitting, setSplitSubmitting] = useState(false);
  const [conflictRemainder, setConflictRemainder] = useState<number | null>(null);
  const [splitForm] = Form.useForm<SplitFormValues>();

  const [mergeGroupKey, setMergeGroupKey] = useState<string | null>(null);
  const [mergeBranchIds, setMergeBranchIds] = useState<string[]>([]);
  const [mergeName, setMergeName] = useState('');

  const [busyMergeId, setBusyMergeId] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([loadAll(), loadBatches(), loadReviews()]);
    const sub = liveQuery(() => db.reviews.toArray()).subscribe({ next: setReviews });
    return () => sub.unsubscribe();
  }, [loadAll, loadBatches, loadReviews]);

  const gardenMap = useMemo(() => new Map(gardens.map((garden) => [garden.id, garden])), [gardens]);
  const batchMap = useMemo(() => new Map(batches.map((batch) => [batch.id, batch])), [batches]);
  const splitBySource = useMemo(() => {
    const map = new Map<string, SplitRecord[]>();
    splits.forEach((split) => map.set(split.sourceBatchId, [...(map.get(split.sourceBatchId) ?? []), split]));
    return map;
  }, [splits]);

  const labelOf = (batchId: string): string => {
    const batch = batchMap.get(batchId);
    if (!batch) return '未知批次';
    return batchLabel(batch, gardenMap.get(batch.gardenId)?.name);
  };

  /* ------------------------------- 拆批视图 ------------------------------- */

  /** 可拆批母批：单支或余量、已达杀青、非合回批次、仍有正余量 */
  const splittable = useMemo(
    () =>
      batches.filter((batch) => {
        const lineage = lineageOf(batch);
        if (lineage.kind === 'merged' || lineage.kind === 'branch') return false;
        if (batchStateOrder(batch.state) < batchStateOrder(SPLIT_MIN_STATE)) return false;
        return measureWeightKg(batch) > 0;
      }),
    [batches],
  );

  const openSplitModal = (batch: Batch): void => {
    setSplitModalBatch(batch);
    setConflictRemainder(null);
    const draft: { weightKg: number; routeNote: string }[] | undefined = loadSplitDrafts()[batch.id];
    const draftBranches: SplitFormValues['branches'] =
      draft && draft.length >= 2
        ? draft.map((item) => ({
            weightKg: typeof item.weightKg === 'number' && item.weightKg > 0 ? item.weightKg : (undefined as unknown as number),
            routeNote: item.routeNote ?? '',
          }))
        : [
            { weightKg: undefined as unknown as number, routeNote: '足火路' },
            { weightKg: undefined as unknown as number, routeNote: '轻火路' },
          ];
    splitForm.setFieldsValue({ branches: draftBranches });
  };

  const watchedBranches = Form.useWatch('branches', splitForm) as SplitFormValues['branches'] | undefined;
  const splitSummary = useMemo(() => {
    if (!splitModalBatch || !watchedBranches) return null;
    return summarizeSplit(
      conflictRemainder !== null ? conflictRemainder : measureWeightKg(splitModalBatch),
      (watchedBranches ?? []).map((item, index) => ({
        branchNo: index + 1,
        weightKg: Number(item?.weightKg),
        routeNote: item?.routeNote ?? '',
      })),
    );
  }, [conflictRemainder, splitModalBatch, watchedBranches]);

  const closeSplitModal = (): void => {
    setSplitModalBatch(null);
    setConflictRemainder(null);
  };

  const submitSplit = async (): Promise<void> => {
    if (!splitModalBatch) return;
    const values = splitForm.getFieldsValue(true) as SplitFormValues;
    const drafts = (values.branches ?? []).map((item) => ({
      weightKg: Number(item?.weightKg),
      routeNote: String(item?.routeNote ?? '').trim(),
    }));
    // 任何时刻保留草稿（冲突 / 失败 / 刷新都不丢）
    if (splitModalBatch) saveSplitDrafts({ ...loadSplitDrafts(), [splitModalBatch.id]: drafts });
    setSplitSubmitting(true);
    try {
      const record = await commitSplit(splitModalBatch.id, drafts);
      message.success(`已拆出 ${record.branches.length} 路：各支合计 ${record.branches.reduce((a, b) => a + b.weightKg, 0)} kg，余量 ${record.remainderWeightKg} kg`);
      closeSplitModal();
    } catch (error) {
      if (error instanceof SplitConflictError) {
        setConflictRemainder(error.latestRemainderKg);
        message.warning(`并发冲突：${error.message}（最新余量 ${error.latestRemainderKg} kg），草稿已保留，请调整后重试`);
      } else {
        message.error(error instanceof Error ? error.message : '拆批失败');
      }
    } finally {
      setSplitSubmitting(false);
    }
  };

  const splitColumns: ColumnsType<Batch> = [
    {
      title: '母批',
      key: 'batch',
      render: (_: unknown, batch) => (
        <Space direction="vertical" size={2}>
          <Space size={6} wrap>
            <strong>{labelOf(batch.id)}</strong>
            {isRemainderBatch(batch) ? <Tag color="orange">余量母批</Tag> : <Tag>单支</Tag>}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已拆 {splitBySource.get(batch.id)?.length ?? 0} 次
          </Typography.Text>
        </Space>
      ),
    },
    { title: '山场', dataIndex: 'gardenId', width: 110, render: (id: string) => gardenMap.get(id)?.name ?? '—' },
    { title: '工序', dataIndex: 'state', width: 100 },
    {
      title: '当前可拆量(kg)',
      key: 'weight',
      width: 140,
      render: (_: unknown, batch) => <strong>{roundTo(measureWeightKg(batch), 2)}</strong>,
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: unknown, batch) => (
        <Button type="primary" ghost size="small" icon={<ScissorOutlined />} onClick={() => openSplitModal(batch)}>
          拆批
        </Button>
      ),
    },
  ];

  /* ------------------------------- 合回视图 ------------------------------- */

  const groups = useMemo(() => buildMergeGroups(batches, gardens), [batches, gardens]);
  const activeGroup = useMemo(
    () => groups.find((group) => group.key === mergeGroupKey) ?? groups[0] ?? null,
    [groups, mergeGroupKey],
  );

  useEffect(() => {
    if (!activeGroup) {
      setMergeBranchIds([]);
      return;
    }
    setMergeBranchIds((prev) => prev.filter((id) => activeGroup.branchBatchIds.includes(id)));
  }, [activeGroup]);

  const groupBranches = useMemo(
    () => (activeGroup ? activeGroup.branchBatchIds.map((id) => batchMap.get(id)).filter((b): b is Batch => Boolean(b)) : []),
    [activeGroup, batchMap],
  );

  const selectedBranches = useMemo(
    () => mergeBranchIds.map((id) => batchMap.get(id)).filter((b): b is Batch => Boolean(b)),
    [batchMap, mergeBranchIds],
  );

  /** 合回候选预演（实时，随分支重量 / 审评变化） */
  const preview = useMemo(() => {
    if (selectedBranches.length < 2) return null;
    const garden = activeGroup ? gardenMap.get(activeGroup.gardenId) : undefined;
    const weight = roundTo(selectedBranches.reduce((acc, b) => acc + measureWeightKg(b), 0), 2);
    let scoredWeight = 0;
    let scoreSum = 0;
    const byId = new Map(reviews.map((r) => [r.batchId, r]));
    selectedBranches.forEach((b) => {
      const review = byId.get(b.id);
      // 同批多条审评取最新一条（与 computeMergeResult 口径一致）
      const latest = reviews.filter((r) => r.batchId === b.id).sort((a, b2) => b2.reviewedAt.localeCompare(a.reviewedAt))[0];
      const ref = latest ?? review;
      if (ref) {
        scoredWeight = roundTo(scoredWeight + measureWeightKg(b), 2);
        scoreSum += ref.totalScore * measureWeightKg(b);
      }
    });
    const totalScore = scoredWeight > 0 ? roundTo(scoreSum / scoredWeight, 1) : null;
    return { weight, scoredWeight, totalScore, gardenName: garden?.name ?? activeGroup?.gardenName ?? '' };
  }, [activeGroup, gardenMap, reviews, selectedBranches]);

  const handleCreateMerge = async (): Promise<void> => {
    if (mergeBranchIds.length < 2) {
      message.warning('请至少勾选同山场、品种、工序的 2 路分支');
      return;
    }
    try {
      const record = await createMerge(mergeName, mergeBranchIds);
      message.success(`合回方案「${record.name}」已生成，确认前不会进入拼配候选`);
      setMergeBranchIds([]);
      setMergeName('');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建合回失败');
    }
  };

  const handleRecompute = async (record: MergeRecord): Promise<void> => {
    setBusyMergeId(record.id);
    try {
      const next = await recomputeMerge(record.id);
      if (next) message.success('合回结果已按最新分支重量 / 审评分重算');
      else message.error(record.invalidReason || '重算失败，已恢复并保留旧结果，可重试');
    } finally {
      setBusyMergeId(null);
    }
  };

  const handleConfirm = (record: MergeRecord): void => {
    modal.confirm({
      title: `确认合回「${record.name}」？`,
      content: `将生成 ${record.result?.weightKg ?? 0} kg 新茶青批次，参与分支退出拼配候选。`,
      okText: '确认合回',
      cancelText: '取消',
      onOk: async () => {
        setBusyMergeId(record.id);
        try {
          const next = await confirmMerge(record.id);
          if (next) message.success('合回已确认，新批次已按毛茶重量加权审评进入拼配候选');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '确认失败');
        } finally {
          setBusyMergeId(null);
        }
      },
    });
  };

  const handleDiscard = async (record: MergeRecord): Promise<void> => {
    try {
      await discardMerge(record.id);
      message.success('合回方案已放弃，分支恢复为可合回状态');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '放弃失败');
    }
  };

  const mergeColumns: ColumnsType<MergeRecord> = [
    {
      title: '合回方案',
      dataIndex: 'name',
      render: (value: string, record) => (
        <Space direction="vertical" size={2}>
          <strong>{value}</strong>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.branches.map((b) => labelOf(b.batchId)).join(' ＋ ')}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 190,
      render: (status: MergeStatus) => <Tag color={MERGE_STATUS_META[status].color}>{MERGE_STATUS_META[status].label}</Tag>,
    },
    {
      title: '合回重量(kg)',
      key: 'weight',
      width: 120,
      render: (_: unknown, record) => record.result?.weightKg ?? '—',
    },
    {
      title: '加权审评',
      key: 'score',
      width: 100,
      render: (_: unknown, record) =>
        record.result?.totalScore === null || record.result?.totalScore === undefined ? (
          <Typography.Text type="secondary">无审评</Typography.Text>
        ) : (
          <Tag color="gold">{record.result.totalScore} 分</Tag>
        ),
    },
    {
      title: '拼配候选',
      key: 'candidate',
      width: 120,
      render: (_: unknown, record) => {
        const output = record.outputBatchId ? batchMap.get(record.outputBatchId) : null;
        const eligible = output ? isBatchBlendEligible(output, merges) : false;
        return eligible ? <Tag color="volcano">候选中</Tag> : <Tag>已撤下</Tag>;
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_: unknown, record) => {
        const liveStale =
          record.status !== 'failed' &&
          isMergeStale(record, batches, reviews);
        return (
          <Space size={4} wrap>
            {(record.status === 'stale' || record.status === 'failed' || liveStale) &&
            record.status !== 'confirmed' ? (
              <Button size="small" type="primary" ghost loading={busyMergeId === record.id} onClick={() => void handleRecompute(record)}>
                重算
              </Button>
            ) : null}
            {record.status === 'confirmed' ? (
              <Button size="small" type="link" onClick={() => void handleRecompute(record)}>
                刷新结果
              </Button>
            ) : (
              <Button
                size="small"
                type="primary"
                disabled={record.status === 'stale' || record.status === 'failed'}
                loading={busyMergeId === record.id}
                onClick={() => handleConfirm(record)}
              >
                确认
              </Button>
            )}
            {record.status !== 'confirmed' ? (
              <Popconfirm title="放弃该合回方案？分支恢复可选。" onConfirm={() => void handleDiscard(record)}>
                <Button size="small" type="link" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ) : null}
          </Space>
        );
      },
    },
  ];

  const stat = useMemo(
    () => ({
      splittable: splittable.length,
      branchCount: batches.filter((b) => isBranchBatch(b)).length,
      mergeCount: merges.length,
      staleCount: merges.filter((m) => m.status === 'stale' || m.status === 'failed').length,
    }),
    [batches, merges, splittable.length],
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            杀青后分路焙火 · 拆批 / 合回工作台
          </Typography.Title>
          <div className="page-hint">
            拆批写清各支公斤与余量、合计对回原批次，分支继承拆分前工艺为只读底稿；合回只接同山场、品种、工序的分支，
            新批次重量相加、审评分按毛茶重量加权，结果一变立即失效并撤出拼配候选。
          </div>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void Promise.all([loadAll(), loadBatches()])}>
            刷新
          </Button>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="可拆母批" value={stat.splittable} suffix="个" tone="primary" />
        <StatBadge label="在制分支" value={stat.branchCount} suffix="路" tone="info" />
        <StatBadge label="合回方案" value={stat.mergeCount} suffix="个" />
        <StatBadge label="待重算" value={stat.staleCount} suffix="个" tone={stat.staleCount > 0 ? 'danger' : 'default'} />
      </div>

      <Tabs
        defaultActiveKey="split"
        items={[
          {
            key: 'split',
            label: (
              <span>
                <ScissorOutlined /> 拆批
              </span>
            ),
            children: (
              <Row gutter={[14, 14]}>
                <Col xs={24} xl={15}>
                  <Card className="panel-card" title="可拆批母批（杀青后分路焙火）">
                    {splittable.length === 0 ? (
                      <EmptyPanel
                        size="small"
                        title="暂无可拆批的母批"
                        description="先在杀青揉捻页登记杀青，使批次达到「已杀青」及之后工序，且仍有可拆重量。"
                      />
                    ) : (
                      <Table<Batch> rowKey="id" size="small" columns={splitColumns} dataSource={splittable} pagination={false} />
                    )}
                  </Card>
                </Col>
                <Col xs={24} xl={9}>
                  <Card className="panel-card" title={<Space><ApartmentOutlined />拆批记录与来源</Space>}>
                    {splits.length === 0 ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有拆批记录" />
                    ) : (
                      <Space direction="vertical" size={10} style={{ width: '100%' }}>
                        {splits.map((split) => (
                          <Card key={split.id} size="small" type="inner" title={labelOf(split.sourceBatchId)}>
                            <Space direction="vertical" size={4} style={{ width: '100%' }}>
                              <Typography.Text style={{ fontSize: 12 }}>
                                原批次 {split.originalWeightKg} kg ＝ 各支合计{' '}
                                {roundTo(split.branches.reduce((a, b) => a + b.weightKg, 0), 2)} kg ＋ 余量{' '}
                                {split.remainderWeightKg} kg
                              </Typography.Text>
                              {split.branches.map((branch) => (
                                <Tag key={branch.batchId} color="cyan">
                                  第 {branch.branchNo} 路 · {branch.routeNote} · {branch.weightKg} kg
                                </Tag>
                              ))}
                              <Tag color="orange">余量 {split.remainderWeightKg} kg（留在母批）</Tag>
                              <BranchBaseline split={split} sourceLabel={labelOf(split.sourceBatchId)} baselines={baselines} />
                            </Space>
                          </Card>
                        ))}
                      </Space>
                    )}
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'merge',
            label: (
              <span>
                <MergeCellsOutlined /> 合回
              </span>
            ),
            children: (
              <Row gutter={[14, 14]}>
                <Col xs={24} xl={11}>
                  <Card className="panel-card" title={<Space><BranchesOutlined />挑路合回（同山场 / 品种 / 工序）</Space>}>
                    {groups.length === 0 ? (
                      <EmptyPanel
                        size="small"
                        title="暂无可合回的分支"
                        description="先在「拆批」页分出 ≥2 路分支，且分支尚未合回。"
                      />
                    ) : (
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <Space wrap>
                          {groups.map((group) => (
                            <Button
                              key={group.key}
                              size="small"
                              type={activeGroup?.key === group.key ? 'primary' : 'default'}
                              onClick={() => setMergeGroupKey(group.key)}
                            >
                              {group.gardenName} · {group.cultivar} · {group.state}（{group.branchBatchIds.length} 路）
                            </Button>
                          ))}
                        </Space>
                        {activeGroup ? (
                          <Table<Batch>
                            rowKey="id"
                            size="small"
                            pagination={false}
                            dataSource={groupBranches}
                            rowSelection={{
                              selectedRowKeys: mergeBranchIds,
                              onChange: (keys) => setMergeBranchIds(keys as string[]),
                            }}
                            columns={[
                              { title: '分支', key: 'label', render: (_: unknown, b) => labelOf(b.id) },
                              {
                                title: '路线',
                                key: 'route',
                                width: 110,
                                render: (_: unknown, b) => {
                                  const lineage = lineageOf(b);
                                  const split = lineage.kind === 'branch' ? splits.find((s) => s.id === lineage.splitId) : undefined;
                                  const branch = split?.branches.find((item) => item.batchId === b.id);
                                  return branch?.routeNote ?? `第 ${lineage.kind === 'branch' ? lineage.branchNo : '?'} 路`;
                                },
                              },
                              { title: '毛重(kg)', key: 'kg', width: 100, render: (_: unknown, b) => measureWeightKg(b) },
                              {
                                title: '审评',
                                key: 'score',
                                width: 80,
                                render: (_: unknown, b) => {
                                  const latest = reviews
                                    .filter((r) => r.batchId === b.id)
                                    .sort((a, b2) => b2.reviewedAt.localeCompare(a.reviewedAt))[0];
                                  return latest ? <Tag color="gold">{latest.totalScore}</Tag> : <Tag>无</Tag>;
                                },
                              },
                            ]}
                          />
                        ) : null}
                        <Input
                          placeholder="合回方案名称（可留空）"
                          value={mergeName}
                          onChange={(e) => setMergeName(e.target.value)}
                        />
                        {preview ? (
                          <Alert
                            type="info"
                            showIcon
                            message={`合回预演：新批次 ${preview.weight} kg`}
                            description={
                              preview.totalScore === null
                                ? '所选分支暂无审评，合回后可补录审评'
                                : `按毛茶重量加权审评 ${preview.totalScore} 分（计入 ${preview.scoredWeight} kg）`
                            }
                          />
                        ) : null}
                        <Button
                          type="primary"
                          icon={<ThunderboltOutlined />}
                          disabled={mergeBranchIds.length < 2}
                          onClick={() => void handleCreateMerge()}
                        >
                          生成合回方案（{mergeBranchIds.length} 路）
                        </Button>
                      </Space>
                    )}
                  </Card>
                </Col>
                <Col xs={24} xl={13}>
                  <Card className="panel-card" title="合回方案（结果 / 失效 / 重算 / 确认）">
                    {merges.length === 0 ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有合回方案" />
                    ) : (
                      <Space direction="vertical" size={10} style={{ width: '100%' }}>
                        {merges.map((record) => (
                          <div key={record.id}>
                            {record.status === 'stale' || record.status === 'failed' ? (
                              <Alert
                                style={{ marginBottom: 6 }}
                                type={record.status === 'failed' ? 'error' : 'warning'}
                                showIcon
                                message={
                                  record.status === 'failed'
                                    ? `重算失败，已保留旧结果（${record.result?.weightKg ?? '—'} kg），可重试`
                                    : '合回结果已失效，已从拼配候选撤下'
                                }
                                description={record.invalidReason}
                              />
                            ) : null}
                            <Table<MergeRecord>
                              rowKey="id"
                              size="small"
                              showHeader={false}
                              pagination={false}
                              dataSource={[record]}
                              columns={mergeColumns}
                            />
                          </div>
                        ))}
                      </Space>
                    )}
                  </Card>
                </Col>
              </Row>
            ),
          },
        ]}
      />

      {/* ------------------------------ 拆批弹窗 ------------------------------ */}
      <Modal
        open={splitModalBatch !== null}
        title={splitModalBatch ? `拆批 · ${labelOf(splitModalBatch.id)}` : '拆批'}
        okText="提交拆批"
        cancelText="取消"
        confirmLoading={splitSubmitting}
        width={640}
        onCancel={closeSplitModal}
        onOk={() => void submitSplit()}
        destroyOnClose
      >
        {splitModalBatch ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {conflictRemainder !== null ? (
              <Alert
                type="warning"
                showIcon
                message={`另一个页签已先完成拆分，最新剩余量为 ${conflictRemainderKg(conflictRemainder)}`}
                description="你的分支草稿已保留，请据此调整各支公斤；后提交不会覆盖先提交结果。"
              />
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前母批可拆量 <strong>{conflictRemainder !== null ? conflictRemainder : roundTo(measureWeightKg(splitModalBatch), 2)}</strong> kg
              ｜至少 2 路，每支 &gt; 0，各支合计不超过母批
            </Typography.Text>
            <Form form={splitForm} layout="vertical" preserve={false}>
              <Form.List name="branches">
                {(fields, { add, remove }) => (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {fields.map((field, index) => (
                      <Space key={field.key} align="baseline">
                        <Tag color="cyan">第 {index + 1} 路</Tag>
                        <Form.Item
                          {...field}
                          name={[field.name, 'weightKg']}
                          rules={[
                            { required: true, message: '请填该支公斤' },
                            { type: 'number', min: 0.1, message: '每支需大于 0' },
                          ]}
                          style={{ marginBottom: 0 }}
                        >
                          <InputNumber min={0.1} step={0.5} addonAfter="kg" style={{ width: 150 }} placeholder="该支公斤" />
                        </Form.Item>
                        <Form.Item {...field} name={[field.name, 'routeNote']} style={{ marginBottom: 0 }}>
                          <Input placeholder="焙火路线，如 足火路" style={{ width: 220 }} />
                        </Form.Item>
                        {fields.length > 2 ? <Button type="link" danger onClick={() => remove(field.name)}>移除</Button> : null}
                      </Space>
                    ))}
                    <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ weightKg: undefined, routeNote: '' })}>
                      增加一路
                    </Button>
                  </Space>
                )}
              </Form.List>
            </Form>
            {splitSummary ? (
              <Alert
                type={splitSummary.valid ? 'success' : 'warning'}
                showIcon
                message={`各支合计 ${splitSummary.branchTotalKg} kg ＋ 余量 ${splitSummary.remainderKg} kg ＝ ${roundTo(
                  splitSummary.branchTotalKg + splitSummary.remainderKg,
                  2,
                )} kg（原批次 ${splitSummary.originalKg} kg）`}
                description={
                  splitSummary.valid
                    ? '合计对回原批次，可以提交'
                    : `合计对不上：差值 ${splitSummary.diffKg} kg（余量不能为负、至少 2 路、每支大于 0）`
                }
              />
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              提交后各支成为独立批次（重量按各支公斤），母批保留余量；拆分前的做青 / 杀青 / 焙火参数作为只读底稿随各支继承。
            </Typography.Text>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}

/** 弹窗冲突提示里的余量数字 */
function conflictRemainderKg(value: number): string {
  return `${roundTo(value, 2)} kg`;
}

/** 拆批记录下的只读底稿摘要（默认折叠） */
function BranchBaseline({
  split,
  sourceLabel,
  baselines,
}: {
  split: SplitRecord;
  sourceLabel: string;
  baselines: ProcessBaseline[];
}) {
  const [open, setOpen] = useState(false);
  const baseline = baselines.find((item) => item.id === split.baselineId);
  return (
    <div>
      <Button size="small" type="link" onClick={() => setOpen((v) => !v)}>
        {open ? '收起只读底稿' : '查看拆分前工艺底稿'}
      </Button>
      {open && baseline ? <BaselinePanel baseline={baseline} sourceLabel={sourceLabel} /> : null}
    </div>
  );
}
