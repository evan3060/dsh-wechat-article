import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { RunSummary } from '@/shared/contract';
import { RUN_STATUS_LABEL } from '../lib/format';
import { CodeChip } from './bits';
import { Icon } from './Icon';

/**
 * 生成中六阶段 stepper（DESIGN §4.2 / §4.2 生成态）。
 * 步骤序列 = 引擎 PIPELINE_STEP_NAMES：topic→outline→draft→gates→render→images。
 * 契约事实（contract.RunSummary）：run 视图无 steps 明细——阶段行按 run 整体状态着色
 * （运行中=当前批次未完成、失败=标注失败阶段入口），明细随契约扩展后点亮；
 * 不伪造阶段级进度。失败续跑 = run/start 重跑本稿（AC-4 保留已完成产物）。
 * compact 档（v0.2）：ProgressCard 内只渲染阶段列表——头（主题）/脚（重试/取消）由卡片提供。
 */

const STAGES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'topic', label: '选题分析' },
  { name: 'outline', label: '研究与提纲' },
  { name: 'draft', label: '初稿写作' },
  { name: 'gates', label: '质量门禁' },
  { name: 'render', label: '排版转换' },
  { name: 'images', label: '配图生成' },
];

export function PipelineStepper({
  run,
  topic,
  onRetry,
  onCancel,
  onBackground,
  retrying,
  compact = false,
}: {
  run: RunSummary;
  topic: string;
  onRetry?: () => void;
  onCancel?: () => void;
  onBackground?: () => void;
  retrying?: boolean;
  compact?: boolean;
}) {
  const failed = run.status === 'failed';

  if (compact) {
    return (
      <div className="wa-stepper wa-stepper--compact">
        <ol className="wa-stepper__list">
          {STAGES.map((stage) => (
            <li key={stage.name} className={run.status === 'succeeded' ? 'wa-stage wa-stage--done' : 'wa-stage'}>
              <span className="wa-stage__lead">
                {run.status === 'succeeded' ? <Icon name="check" size={16} /> : <span className="wa-stage__hollow" aria-hidden="true" />}
                <span className="wa-stage__name">{stage.label}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="wa-stepper">
      <div className="wa-stepper__head">
        <h3 className="wa-stepper__title">正在生成《{topic}》</h3>
        <span className="wa-stepper__meta">
          {RUN_STATUS_LABEL[run.status]} · 预计 3–5 分钟
        </span>
      </div>
      <ol className="wa-stepper__list">
        {STAGES.map((stage) => (
          <li key={stage.name} className={run.status === 'succeeded' ? 'wa-stage wa-stage--done' : 'wa-stage'}>
            <span className="wa-stage__lead">
              {run.status === 'succeeded' ? (
                <Icon name="check" size={16} />
              ) : (
                <span className="wa-stage__hollow" aria-hidden="true" />
              )}
              <span className="wa-stage__name">{stage.label}</span>
            </span>
          </li>
        ))}
      </ol>
      {run.status === 'running' || run.status === 'queued' ? (
        <p className="wa-stepper__fallback">阶段明细随 run 记录回传；当前以整体状态跟踪。</p>
      ) : null}
      {failed && run.error ? (
        <div className="wa-stage__error">
          <p>
            {run.error.message} <CodeChip>{run.error.code}</CodeChip>
          </p>
          {onRetry ? (
            <Button variant="outline" size="sm" icon={<Icon name="rotate-ccw" size={16} />} onClick={onRetry} disabled={retrying}>
              重试本阶段
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="wa-stepper__foot">
        {onBackground ? (
          <Button variant="ghost" size="sm" onClick={onBackground}>
            转入后台
          </Button>
        ) : null}
        {onCancel ? (
          <Button variant="ghost" size="sm" icon={<Icon name="x" size={16} />} onClick={onCancel}>
            取消生成
          </Button>
        ) : null}
      </div>
    </div>
  );
}
