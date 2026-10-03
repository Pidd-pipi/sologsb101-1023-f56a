/**
 * <BaselinePanel> 拆分前工艺只读底稿
 * 分支批次继承母批拆分前的做青轮次 / 杀青揉捻 / 焙火道次快照，
 * 在做青、杀青、焙火页与拆并工作台以只读方式展示（明确来源、不可修改）。
 */
import { Empty, Space, Table, Tag, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { ProcessBaseline } from '../../types/split';
import type { Turn } from '../../types/turn';
import type { Fix } from '../../types/fix';
import type { Roast } from '../../types/roast';
import GradeTag from './GradeTag';

export interface BaselinePanelProps {
  baseline: ProcessBaseline;
  /** 只展示某一部分（做青页传 turns / 杀青页传 fix / 焙火页传 roasts）；不传展示全部 */
  section?: 'all' | 'turns' | 'fix' | 'roasts';
  /** 母批 / 来源批次展示名 */
  sourceLabel?: string;
}

const turnColumns: ColumnsType<Turn> = [
  { title: '轮次', dataIndex: 'roundNo', width: 64, render: (value: number) => `第 ${value} 轮` },
  { title: '摇青(分)', dataIndex: 'shakeMin', width: 90 },
  { title: '静置(分)', dataIndex: 'restMin', width: 90 },
  { title: '室温℃', dataIndex: 'roomTempC', width: 80 },
  { title: '湿度%', dataIndex: 'humidityPct', width: 80 },
  { title: '失水率%', dataIndex: 'waterLossPct', width: 90 },
];

const roastColumns: ColumnsType<Roast> = [
  { title: '道次', dataIndex: 'passNo', width: 80, render: (value: number) => `第 ${value} 道` },
  { title: '温度℃', dataIndex: 'tempC', width: 90 },
  { title: '时长(h)', dataIndex: 'hours', width: 90 },
  { title: '炭种', dataIndex: 'charcoal', width: 100 },
  { title: '状态', dataIndex: 'state', width: 110, render: (value: Roast['state']) => <GradeTag kind="roastState" value={value} /> },
];

/** 只读底稿面板：做青 / 杀青 / 焙火页与工作台复用 */
export function BaselinePanel({ baseline, section = 'all', sourceLabel }: BaselinePanelProps) {
  return (
    <div className="baseline-panel">
      <Space size={8} wrap style={{ marginBottom: 8 }}>
        <Tag icon={<LockOutlined />} color="default">
          拆分前工艺 · 只读底稿
        </Tag>
        {sourceLabel ? <Typography.Text type="secondary">来源：{sourceLabel}</Typography.Text> : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          随拆批继承，仅供追溯，新增 / 修改请在本支工序中登记
        </Typography.Text>
      </Space>

      {section === 'all' || section === 'turns' ? (
        <div style={{ marginBottom: 10 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            做青轮次（{baseline.turns.length}）
          </Typography.Text>
          {baseline.turns.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="拆分前无做青轮次记录" />
          ) : (
            <Table<Turn>
              rowKey="id"
              size="small"
              columns={turnColumns}
              dataSource={[...baseline.turns].sort((a, b) => a.roundNo - b.roundNo)}
              pagination={false}
            />
          )}
        </div>
      ) : null}

      {section === 'all' || section === 'fix' ? (
        <div style={{ marginBottom: 10 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            杀青揉捻
          </Typography.Text>
          {baseline.fix ? (
            <Space size={10} wrap style={{ display: 'flex', marginTop: 6 }}>
              <span>锅温 {baseline.fix.wokTempC} ℃</span>
              <span>杀青 {baseline.fix.fixMin} 分钟</span>
              <GradeTag kind="pressure" value={baseline.fix.rollPressure} />
              <span>揉捻 {baseline.fix.rollMin} 分钟</span>
              <span>操作人 {baseline.fix.operator || '未署名'}</span>
            </Space>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="拆分前无杀青揉捻记录" />
          )}
        </div>
      ) : null}

      {section === 'all' || section === 'roasts' ? (
        <div>
          <Typography.Text strong style={{ fontSize: 13 }}>
            拆分时已有焙火道次（{baseline.roasts.length}）
          </Typography.Text>
          {baseline.roasts.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="拆分前无焙火道次，复焙安排在本支自行登记" />
          ) : (
            <Table<Roast>
              rowKey="id"
              size="small"
              columns={roastColumns}
              dataSource={[...baseline.roasts].sort((a, b) => a.passNo - b.passNo)}
              pagination={false}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 杀青只读底稿一行摘要（杀青页复用） */
export function baselineFixSummary(fix: Fix | null): string {
  if (!fix) return '拆分前无杀青揉捻记录';
  return `锅温 ${fix.wokTempC}℃ · 杀青 ${fix.fixMin} 分钟 · ${fix.rollPressure}压揉捻 ${fix.rollMin} 分钟 · ${fix.operator || '未署名'}`;
}

export default BaselinePanel;
