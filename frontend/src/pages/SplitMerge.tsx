/**
 * /split-merge 拆并工作台
 * - 拆批：写清各支公斤与余量，合计对上原批次；各支继承拆分前做青 / 杀青工艺作为只读底稿。
 *   事务内重读最新余量，两个页签并发拆分时后提交方不覆盖先提交结果，草稿保留可改。
 * - 合回：只接同山场、品种、工序且带审评的分支；新批次重量 = 分支相加，审评分按毛茶重量加权。
 *   来源重量或审评一变，合回立即失效（从拼配候选撤下）；重算失败恢复旧结果并允许重试。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  MergeCellsOutlined,
  PlusOutlined,
  ReloadOutlined,
  SplitCellsOutlined,
} from '@ant-design/icons';
import GradeTag from '../components/common/GradeTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useIdbTable } from '../hooks/useIdbTable';
import { useTurnTimeline } from '../hooks/useTurnTimeline';
import {
  selectEffectiveMerges,
  selectMergeBranchSources,
  useMergeStore,
  type MergeBranchSource,
} from '../stores/mergeStore';
import { db } from '../utils/db';
import type { Batch } from '../types/batch';
import type { Fix } from '../types/fix';
import type { Roast } from '../types/roast';
import type { MergeRecord } from '../types/merge';
import {
  batchLabel,
  computeMergePreview,
  currentRemainingKg,
  judgeFixLevel,
  mergeCompatibilityKey,
  minutesToReadable,
  originalLotKg,
  roundTo,
  splitOffKg,
  validateSplitRows,
} from '../utils/tea';

let rowSeq = 0;
function nextRowKey(): string {
  rowSeq += 1;
  return `split-row-${Date.now().toString(36)}-${rowSeq}`;
}

interface SplitRow {
  key: string;
  kg: number;
}

export default function SplitMerge() {
  const { message, modal } = App.useApp();

  const batches = useMergeStore((state) => state.batches);
  const gardens = useMergeStore((state) => state.gardens);
  const loading = useMergeStore((state) => state.loading);
  const error = useMergeStore((state) => state.error);
  const loadAll = useMergeStore((state) => state.loadAll);
  const splitBatch = useMergeStore((state) => state.splitBatch);
  const confirmMerge = useMergeStore((state) => state.confirmMerge);
  const recomputeMerge = useMergeStore((state) => state.recomputeMerge);
  const removeMerge = useMergeStore((state) => state.removeMerge);

  const branchSources = useMergeStore(selectMergeBranchSources);
  const effectiveMerges = useMergeStore(selectEffectiveMerges);

  const fixesTable = useIdbTable<Fix>(db.fixes);
  const roastsTable = useIdbTable<Roast>(db.roasts);

  const [tab, setTab] = useState<'split' | 'merge'>('split');

  /* ------------------------------ 拆批状态 ------------------------------ */
  const [splitParentId, setSplitParentId] = useState<string | undefined>(undefined);
  const [splitRows, setSplitRows] = useState<SplitRow[]>([{ key: nextRowKey(), kg: 0 }]);
  const [splitSubmitting, setSplitSubmitting] = useState(false);
  const [splitConflict, setSplitConflict] = useState('');

  /* ------------------------------ 合回状态 ------------------------------ */
  const [mergeSelected, setMergeSelected] = useState<string[]>([]);
  const [mergeSubmitting, setMergeSubmitting] = useState(false);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const gardenMap = useMemo(() => new Map(gardens.map((garden) => [garden.id, garden])), [gardens]);
  const singleBatches = useMemo(() => batches.filter((batch) => !batch.parentBatchId), [batches]);
  const parentBatch = useMemo(
    () => singleBatches.find((batch) => batch.id === splitParentId),
    [singleBatches, splitParentId],
  );
  const parentBranches = useMemo(
    () => batches.filter((batch) => batch.parentBatchId === splitParentId),
    [batches, splitParentId],
  );

  const timeline = useTurnTimeline(splitParentId);
  const parentFix = useMemo(
    () => fixesTable.rows.find((fix) => fix.batchId === splitParentId),
    [fixesTable.rows, splitParentId],
  );
  const parentRoasts = useMemo(
    () => roastsTable.rows.filter((roast) => roast.batchId === splitParentId),
    [roastsTable.rows, splitParentId],
  );

  /* ------------------------------ 拆批派生 ------------------------------ */
  const originalKg = parentBatch ? originalLotKg(parentBatch) : 0;
  const alreadySplitKg = parentBatch ? splitOffKg(parentBatch, batches) : 0;
  const remainingKg = parentBatch ? currentRemainingKg(parentBatch) : 0;
  const thisSplitSum = roundTo(splitRows.reduce((acc, row) => acc + (Number.isFinite(row.kg) ? row.kg : 0), 0), 2);
  const afterSplitRemaining = roundTo(remainingKg - thisSplitSum, 2);
  const splitCheckError = parentBatch ? validateSplitRows(remainingKg, splitRows) : null;
  const splitTotalOk =
    parentBatch !== undefined &&
    !splitCheckError &&
    roundTo(alreadySplitKg + thisSplitSum + afterSplitRemaining, 1) === roundTo(originalKg, 1);

  const splitOptions = useMemo(
    () =>
      singleBatches.map((batch) => ({
        value: batch.id,
        label: `${batchLabel(batch, gardenMap.get(batch.gardenId)?.name)} · 余量 ${roundTo(batch.freshLeafKg, 1)}kg`,
      })),
    [singleBatches, gardenMap],
  );

  const addSplitRow = (): void => {
    setSplitRows((rows) => [...rows, { key: nextRowKey(), kg: 0 }]);
  };
  const updateSplitRow = (key: string, kg: number): void => {
    setSplitRows((rows) => rows.map((row) => (row.key === key ? { ...row, kg } : row)));
  };
  const removeSplitRow = (key: string): void => {
    setSplitRows((rows) => (rows.length > 1 ? rows.filter((row) => row.key !== key) : rows));
  };

  const handleSplit = async (): Promise<void> => {
    if (!parentBatch) return;
    if (splitCheckError) {
      setSplitConflict(splitCheckError);
      return;
    }
    setSplitSubmitting(true);
    setSplitConflict('');
    try {
      const result = await splitBatch(
        parentBatch.id,
        splitRows.map((row) => ({ kg: row.kg })),
      );
      message.success(`已拆出 ${result.branchCount} 支，当前余量 ${roundTo(result.remaining, 1)}kg`);
      setSplitRows([{ key: nextRowKey(), kg: 0 }]);
    } catch (err) {
      // 并发冲突 / 校验失败：保留草稿，展示最新余量（错误信息由事务内重读后给出）
      setSplitConflict(err instanceof Error ? err.message : '拆批失败');
      message.error(err instanceof Error ? err.message : '拆批失败，草稿已保留');
    } finally {
      setSplitSubmitting(false);
    }
  };

  /* ------------------------------ 合回派生 ------------------------------ */
  const selectedSources = useMemo<MergeBranchSource[]>(
    () => mergeSelected.map((id) => branchSources.find((source) => source.branch.id === id)).filter((s): s is MergeBranchSource => Boolean(s)),
    [mergeSelected, branchSources],
  );
  const compatKey = selectedSources.length > 0 ? mergeCompatibilityKey(selectedSources[0].branch.gardenId, selectedSources[0].branch.state) : '';
  const compatible =
    selectedSources.length >= 2 &&
    selectedSources.every((source) => mergeCompatibilityKey(source.branch.gardenId, source.branch.state) === compatKey);

  const mergePreview = useMemo(() => {
    if (!compatible || selectedSources.length < 2) return null;
    try {
      return computeMergePreview(
        selectedSources.map((source) => ({
          batchId: source.branch.id,
          batchLabel: batchLabel(source.branch, source.garden?.name),
          gardenId: source.branch.gardenId,
          gardenName: source.garden?.name ?? '未知山场',
          cultivar: source.garden?.cultivar ?? '未标注',
          state: source.branch.state,
          weightKg: source.branch.freshLeafKg,
          reviewId: source.review?.id ?? '',
          totalScore: source.review?.totalScore ?? 0,
          aroma: source.review?.aroma ?? 0,
          liquorColor: source.review?.liquorColor ?? 0,
          taste: source.review?.taste ?? 0,
          leafBase: source.review?.leafBase ?? 0,
        })),
      );
    } catch {
      return null;
    }
  }, [compatible, selectedSources]);

  const mergeOptions = useMemo(() => {
    const groups = new Map<string, { gardenName: string; state: string; options: { value: string; label: string }[] }>();
    branchSources.forEach((source) => {
      const key = source.compatKey;
      const group = groups.get(key) ?? {
        gardenName: source.garden?.name ?? '未知山场',
        state: source.branch.state,
        options: [],
      };
      group.options.push({
        value: source.branch.id,
        label: `支${source.branch.branchNo ?? ''} · ${source.branch.pickedAt} · ${roundTo(source.branch.freshLeafKg, 1)}kg · ${roundTo(source.review?.totalScore ?? 0, 1)}分`,
      });
      groups.set(key, group);
    });
    return Array.from(groups.entries()).map(([key, group]) => (
      <Select.OptGroup key={key} label={`${group.gardenName} · ${group.state}`}>
        {group.options.map((option) => (
          <Select.Option key={option.value} value={option.value}>
            {option.label}
          </Select.Option>
        ))}
      </Select.OptGroup>
    ));
  }, [branchSources]);

  const handleConfirmMerge = async (): Promise<void> => {
    if (!compatible || !mergePreview) return;
    setMergeSubmitting(true);
    try {
      const merge = await confirmMerge(mergeSelected);
      message.success(`合回已确认：${merge.sourceCount} 支 → 新批次 ${roundTo(merge.totalWeightKg, 1)}kg，加权 ${roundTo(merge.resultScore, 1)} 分`);
      setMergeSelected([]);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '合回失败');
    } finally {
      setMergeSubmitting(false);
    }
  };

  const handleRecompute = async (merge: MergeRecord): Promise<void> => {
    try {
      await recomputeMerge(merge.id);
      message.success(`已按最新重量 / 审评分重算合回「${merge.gardenName}」`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '重算失败，已恢复旧结果，可重试');
    }
  };

  const confirmRemoveMerge = (merge: MergeRecord): void => {
    modal.confirm({
      title: `删除合回记录「${merge.gardenName} · ${merge.sourceCount} 支」？`,
      content: '将同时删除该合回产生的新批次与审评记录，来源分支不受影响。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await removeMerge(merge.id);
          message.success('合回记录已删除');
        } catch (err) {
          message.error(err instanceof Error ? err.message : '删除失败');
        }
      },
    });
  };

  /* ------------------------------ 列定义 ------------------------------ */
  const splitRowColumns: ColumnsType<SplitRow> = [
    {
      title: '支别',
      key: 'branch',
      width: 90,
      render: (_v, _row, index) => <Tag color="green">第 {index + 1} 支</Tag>,
    },
    {
      title: '重量（kg）',
      key: 'kg',
      render: (_v, row) => (
        <InputNumber
          min={0}
          max={remainingKg}
          step={0.5}
          value={row.kg}
          onChange={(value) => updateSplitRow(row.key, typeof value === 'number' ? value : 0)}
          style={{ width: '100%' }}
          addonAfter="kg"
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 70,
      render: (_v, row) => (
        <Button
          size="small"
          type="link"
          danger
          icon={<DeleteOutlined />}
          disabled={splitRows.length === 1}
          onClick={() => removeSplitRow(row.key)}
        />
      ),
    },
  ];

  const branchColumns: ColumnsType<Batch> = [
    { title: '支号', key: 'no', width: 80, render: (_v, row) => <Tag color="green">支{row.branchNo ?? ''}</Tag> },
    { title: '采摘日', dataIndex: 'pickedAt', width: 120 },
    { title: '重量(kg)', dataIndex: 'freshLeafKg', width: 100, render: (v: number) => roundTo(v, 1) },
    { title: '嫩度', dataIndex: 'tenderness', width: 130, render: (v: Batch['tenderness']) => <GradeTag kind="tenderness" value={v} /> },
    { title: '工序状态', dataIndex: 'state', width: 110, render: (v: Batch['state']) => <GradeTag kind="state" value={v} /> },
    {
      title: '工艺底稿',
      key: 'inherit',
      render: () => <Tag>继承拆分前做青 / 杀青（只读）</Tag>,
    },
  ];

  const mergeRecordColumns: ColumnsType<(typeof effectiveMerges)[number]> = [
    {
      title: '山场 / 品种',
      key: 'garden',
      width: 150,
      render: (_v, row) => (
        <Space size={6} wrap>
          <span>{row.gardenName}</span>
          <Tag color="green">{row.cultivar}</Tag>
        </Space>
      ),
    },
    { title: '工序', dataIndex: 'state', width: 100, render: (v: string) => <GradeTag kind="state" value={v} /> },
    { title: '来源', dataIndex: 'sourceCount', width: 90, render: (v: number) => `${v} 支` },
    { title: '合回重量(kg)', dataIndex: 'totalWeightKg', width: 120, render: (v: number) => roundTo(v, 1) },
    {
      title: '加权评分',
      dataIndex: 'resultScore',
      width: 170,
      render: (_v, row) => <GradeTag kind="score" value={row.resultScore} />,
    },
    {
      title: '状态',
      key: 'status',
      width: 110,
      render: (_v, row) =>
        row.effectiveStatus === 'stale' ? <Tag color="red">已失效 · 已撤下</Tag> : <Tag color="green">已确认</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_v, row) => (
        <Space size={2} wrap>
          <Tooltip title={row.effectiveStatus === 'stale' ? '按最新重量 / 审评分重新加权；失败则恢复旧结果' : '来源变化后可重算'}>
            <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => void handleRecompute(row)}>
              重算
            </Button>
          </Tooltip>
          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => confirmRemoveMerge(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            拆并工作台
          </Typography.Title>
          <div className="page-hint">
            杀青后分几路焙火：拆批写清各支公斤与余量（合计对上原批次），各支继承拆分前工艺作只读底稿；
            挑路合回只接同山场、品种、工序的分支，重量相加、审评分按毛茶重量加权，来源一变立即失效重算。
          </div>
        </div>
      </div>

      {error ? (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="本地数据读取失败" description={error} />
      ) : null}

      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as 'split' | 'merge')}
        items={[
          {
            key: 'split',
            label: (
              <span>
                <SplitCellsOutlined /> 拆批（分路焙火）
              </span>
            ),
            children: (
              <Row gutter={[14, 14]}>
                <Col xs={24} xl={14}>
                  <Card className="panel-card" title="拆批：各支公斤 + 余量，合计对上原批次" loading={loading}>
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Select
                        showSearch
                        placeholder="选择要拆分的茶青批次（单支批次）"
                        value={splitParentId}
                        onChange={setSplitParentId}
                        style={{ width: '100%' }}
                        optionFilterProp="label"
                        options={splitOptions}
                      />

                      {parentBatch ? (
                        <>
                          <div className="stat-row" style={{ marginBottom: 0 }}>
                            <StatBadge label="原始重量" value={roundTo(originalKg, 1)} suffix="kg" tone="primary" />
                            <StatBadge label="已拆出" value={roundTo(alreadySplitKg, 1)} suffix="kg" tone="info" />
                            <StatBadge label="当前余量" value={roundTo(remainingKg, 1)} suffix="kg" tone="warning" />
                            <StatBadge label="本批合计" value={roundTo(thisSplitSum, 1)} suffix="kg" />
                            <StatBadge
                              label="拆后余量"
                              value={roundTo(afterSplitRemaining, 1)}
                              suffix="kg"
                              tone={afterSplitRemaining < 0 ? 'danger' : 'success'}
                            />
                          </div>

                          <Card
                            size="small"
                            type="inner"
                            title={
                              <Space size={6}>
                                <span>拆分前工艺底稿</span>
                                <Tag>只读 · 各支继承</Tag>
                              </Space>
                            }
                          >
                            <Space size={16} wrap>
                              <Statistic
                                title="做青轮次"
                                value={timeline.turns.length}
                                suffix={`轮 · ${minutesToReadable(timeline.totalMin)}`}
                              />
                              <Statistic title="末轮失水率" value={roundTo(timeline.finalWaterLossPct, 1)} suffix="%" />
                              <Statistic
                                title="杀青"
                                value={parentFix ? `${parentFix.wokTempC}℃ / ${parentFix.fixMin}分` : '未记录'}
                                suffix={parentFix ? parentFix.operator : ''}
                              />
                              <Statistic
                                title="杀青强度"
                                value={parentFix ? judgeFixLevel(parentFix.wokTempC, parentFix.fixMin, parentFix.rollPressure) : '—'}
                              />
                              <Statistic title="焙火道次" value={parentRoasts.length} suffix="道" />
                            </Space>
                          </Card>

                          {splitConflict ? (
                            <Alert
                              type="warning"
                              showIcon
                              message="拆批未生效（草稿已保留）"
                              description={splitConflict}
                            />
                          ) : null}
                          {splitCheckError ? (
                            <Alert type="warning" showIcon message={splitCheckError} />
                          ) : null}
                          {splitTotalOk ? (
                            <Alert
                              type="success"
                              showIcon
                              message={`合计核对通过：已拆 ${roundTo(alreadySplitKg, 1)} + 本批 ${roundTo(thisSplitSum, 1)} + 余量 ${roundTo(afterSplitRemaining, 1)} = 原始 ${roundTo(originalKg, 1)}kg`}
                            />
                          ) : null}

                          <Table<SplitRow>
                            rowKey="key"
                            size="small"
                            dataSource={splitRows}
                            columns={splitRowColumns}
                            pagination={false}
                            title={() => (
                              <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                                <span>分支重量（每支公斤，合计不超过当前余量）</span>
                                <Button size="small" icon={<PlusOutlined />} onClick={addSplitRow}>
                                  增加一支
                                </Button>
                              </Space>
                            )}
                          />

                          <Space>
                            <Button
                              type="primary"
                              icon={<SplitCellsOutlined />}
                              loading={splitSubmitting}
                              disabled={Boolean(splitCheckError) || thisSplitSum <= 0}
                              onClick={() => void handleSplit}
                            >
                              确认拆批
                            </Button>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              并发拆分时以最新余量为准，超出余量会被拦下且不覆盖先拆结果
                            </Typography.Text>
                          </Space>
                        </>
                      ) : (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="选择一个单支批次开始拆批；分支会继承其做青 / 杀青工艺作为只读底稿。"
                        />
                      )}
                    </Space>
                  </Card>
                </Col>

                <Col xs={24} xl={10}>
                  <Card className="panel-card" title="已拆分支" loading={loading}>
                    {!parentBatch ? (
                      <EmptyPanel size="small" title="还没有选择父批次" description="在左侧选择一个批次后查看其分支。" />
                    ) : parentBranches.length === 0 ? (
                      <EmptyPanel
                        size="small"
                        title="该批次还没有分支"
                        description="在左侧填写各支公斤并确认拆批后，分支会出现在这里。"
                      />
                    ) : (
                      <Table<Batch>
                        rowKey="id"
                        size="small"
                        dataSource={parentBranches}
                        columns={branchColumns}
                        pagination={false}
                        scroll={{ x: 560 }}
                      />
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
                <MergeCellsOutlined /> 合回（挑路合回）
              </span>
            ),
            children: (
              <Row gutter={[14, 14]}>
                <Col xs={24} xl={14}>
                  <Card className="panel-card" title="合回：同山场 · 同品种 · 同工序" loading={loading}>
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Select
                        mode="multiple"
                        placeholder="选择要合回的分支（仅显示带审评的分支）"
                        value={mergeSelected}
                        onChange={setMergeSelected}
                        style={{ width: '100%' }}
                        optionFilterProp="label"
                        maxTagCount="responsive"
                      >
                        {mergeOptions}
                      </Select>

                      {selectedSources.length === 0 ? (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="选择 2 支以上同山场、同工序的分支；新批次重量相加，审评分按毛茶重量加权。"
                        />
                      ) : (
                        <>
                          {!compatible ? (
                            <Alert
                              type="warning"
                              showIcon
                              message="分支山场或工序不一致，不能合回"
                              description="合回只接同一山场（品种随山场）且工序状态相同的分支。"
                            />
                          ) : (
                            <Alert
                              type="success"
                              showIcon
                              message={`兼容性校验通过：${selectedSources[0].garden?.name ?? '未知山场'} · ${selectedSources[0].garden?.cultivar ?? '未标注'} · ${selectedSources[0].branch.state} · ${selectedSources.length} 支`}
                            />
                          )}

                          <Table<MergeBranchSource>
                            rowKey={(source) => source.branch.id}
                            size="small"
                            dataSource={selectedSources}
                            pagination={false}
                            columns={[
                              {
                                title: '支别',
                                key: 'no',
                                width: 80,
                                render: (_v, source) => <Tag color="green">支{source.branch.branchNo ?? ''}</Tag>,
                              },
                              {
                                title: '山场',
                                key: 'garden',
                                render: (_v, source) => source.garden?.name ?? '未知山场',
                              },
                              { title: '重量(kg)', key: 'kg', width: 100, render: (_v, source) => roundTo(source.branch.freshLeafKg, 1) },
                              {
                                title: '审评总分',
                                key: 'score',
                                width: 170,
                                render: (_v, source) => (source.review ? <GradeTag kind="score" value={source.review.totalScore} /> : '—'),
                              },
                            ]}
                          />

                          {mergePreview ? (
                            <Card size="small" type="inner" title="合回预览（确认前为草稿，不进拼配候选）">
                              <Space size={24} wrap>
                                <Statistic title="合回重量" value={roundTo(mergePreview.totalWeightKg, 1)} suffix="kg" />
                                <Statistic title="加权审评分" value={roundTo(mergePreview.resultScore, 1)} suffix="分" />
                                <Statistic title="香气" value={roundTo(mergePreview.aroma, 1)} />
                                <Statistic title="汤色" value={roundTo(mergePreview.liquorColor, 1)} />
                                <Statistic title="滋味" value={roundTo(mergePreview.taste, 1)} />
                                <Statistic title="叶底" value={roundTo(mergePreview.leafBase, 1)} />
                              </Space>
                            </Card>
                          ) : null}

                          <Space>
                            <Button
                              type="primary"
                              icon={<MergeCellsOutlined />}
                              loading={mergeSubmitting}
                              disabled={!compatible || !mergePreview}
                              onClick={() => void handleConfirmMerge}
                            >
                              确认合回
                            </Button>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              确认后生成新茶青批次与加权审评；来源重量或评分一变，合回立即失效并从候选撤下
                            </Typography.Text>
                          </Space>
                        </>
                      )}
                    </Space>
                  </Card>
                </Col>

                <Col xs={24} xl={10}>
                  <Card className="panel-card" title="合回记录与失效重算" loading={loading}>
                    {effectiveMerges.length === 0 ? (
                      <EmptyPanel
                        size="small"
                        title="还没有合回记录"
                        description="在左侧选择分支并确认合回后，记录会出现在这里；失效后可一键重算。"
                      />
                    ) : (
                      <Table<(typeof effectiveMerges)[number]>
                        rowKey="id"
                        size="small"
                        dataSource={effectiveMerges}
                        columns={mergeRecordColumns}
                        pagination={{ pageSize: 6 }}
                        scroll={{ x: 900 }}
                      />
                    )}
                  </Card>
                </Col>
              </Row>
            ),
          },
        ]}
      />
    </div>
  );
}
