'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  FileText,
  PauseCircle,
  Play,
  RefreshCw,
  Upload,
} from 'lucide-react';
import KeyManager from '@/components/dashboard/KeyManager';
import { processFile } from '@/lib/parser';
import {
  ChatBlock,
  DailySummary,
  JobStatus,
  PeriodSummary,
  StorageService,
} from '@/services/storage';
import { AnalysisService } from '@/services/analysis';
import { MODELS } from '@/lib/constants';

type ActiveTask = {
  task: string;
  model?: string;
  key?: string;
};

const MAX_RETRIES = 3;
const BLOCK_CONCURRENCY = 3;

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  retrying: 'Retrying',
};

export default function Dashboard() {
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [dailySummaries, setDailySummaries] = useState<DailySummary[]>([]);
  const [periodSummaries, setPeriodSummaries] = useState<PeriodSummary[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [activeTask, setActiveTask] = useState<ActiveTask | null>(null);
  const processingRef = useRef(false);

  useEffect(() => {
    loadState();
  }, []);

  async function loadState() {
    const [storedBlocks, summaries, periods] = await Promise.all([
      StorageService.getChatBlocks(),
      StorageService.getDailySummaries(),
      StorageService.getPeriodSummaries(),
    ]);

    setBlocks(storedBlocks);
    setDailySummaries(summaries);
    setPeriodSummaries(periods);
  }

  const blockStats = useMemo(() => getStatusCounts(blocks), [blocks]);
  const dailyStats = useMemo(() => getStatusCounts(dailySummaries), [dailySummaries]);
  const periodStats = useMemo(() => getStatusCounts(periodSummaries), [periodSummaries]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError('');
    setStatusMessage('');
    processingRef.current = false;
    setIsProcessing(false);

    try {
      await StorageService.resetAnalysisData();
      const blocksMap = await processFile(file);
      const newBlocks: ChatBlock[] = [];
      const newSummaries: DailySummary[] = [];

      blocksMap.forEach((blocksForDate, date) => {
        newBlocks.push(...blocksForDate);
        newSummaries.push({
          date,
          status: 'pending',
          attempts: 0,
          lastUpdated: Date.now(),
        });
      });

      await StorageService.saveChatBlocks(newBlocks);
      await Promise.all(newSummaries.map(summary => StorageService.saveDailySummary(summary)));

      setBlocks(newBlocks);
      setDailySummaries(newSummaries);
      setPeriodSummaries([]);
    } catch (err: any) {
      setUploadError(err.message || 'Failed to parse file');
    }
  }

  async function startAnalysis() {
    if (isProcessing) return;
    processingRef.current = true;
    setIsProcessing(true);
    setStatusMessage('');

    try {
      await processPipeline();
    } finally {
      processingRef.current = false;
      setIsProcessing(false);
      setActiveTask(null);
    }
  }

  async function processPipeline() {
    await processBlocks();
    if (!processingRef.current) return;
    await processDailyAggregation();
    if (!processingRef.current) return;
    await processPeriodAggregation();
  }

  async function processBlocks() {
    const freshBlocks = await StorageService.getChatBlocks();
    setBlocks(freshBlocks);

    const queue = freshBlocks.filter(block => ['pending', 'failed', 'retrying'].includes(block.status));
    let cursor = 0;

    const workers = Array.from({ length: BLOCK_CONCURRENCY }, () => (async () => {
      while (processingRef.current) {
        const block = queue[cursor++];
        if (!block) return;
        await processBlock(block);
      }
    })());

    await Promise.all(workers);
  }

  async function processBlock(block: ChatBlock) {
    let attempt = block.attempts ?? 0;
    let backoff = 1000;

    while (processingRef.current) {
      const runningBlock = {
        ...block,
        status: 'running' as JobStatus,
        attempts: attempt + 1,
        lastUpdated: Date.now(),
        error: undefined,
      };

      await persistBlock(runningBlock);
      setActiveTask({
        task: 'Block Analysis',
        model: MODELS.BLOCK_ANALYSIS.PRIMARY,
      });

      try {
        const response = await AnalysisService.analyzeBlock(runningBlock.messages);
        const completedBlock = {
          ...runningBlock,
          status: 'completed' as JobStatus,
          result: response.data,
          modelUsed: response.meta.model,
          keyUsed: response.meta.key,
          lastUpdated: Date.now(),
        };
        await persistBlock(completedBlock);
        setActiveTask({
          task: 'Block Analysis',
          model: response.meta.model,
          key: response.meta.key,
        });
        return;
      } catch (error: any) {
        if (isNoKeysError(error)) {
          const retryingBlock = {
            ...runningBlock,
            status: 'retrying' as JobStatus,
            error: error.message,
            lastUpdated: Date.now(),
          };
          await persistBlock(retryingBlock);
          setStatusMessage('All API keys are exhausted. Add new keys to resume.');
          processingRef.current = false;
          return;
        }

        const shouldRetry = isRetryable(error) && attempt + 1 < MAX_RETRIES;
        if (!shouldRetry) {
          const failedBlock = {
            ...runningBlock,
            status: 'failed' as JobStatus,
            error: stringifyError(error),
            lastUpdated: Date.now(),
          };
          await persistBlock(failedBlock);
          return;
        }

        const retryingBlock = {
          ...runningBlock,
          status: 'retrying' as JobStatus,
          error: stringifyError(error),
          lastUpdated: Date.now(),
        };
        await persistBlock(retryingBlock);
        await delay(backoff);
        backoff *= 2;
        attempt += 1;
      }
    }
  }

  async function processDailyAggregation() {
    const freshBlocks = await StorageService.getChatBlocks();
    const freshSummaries = await StorageService.getDailySummaries();
    setBlocks(freshBlocks);
    setDailySummaries(freshSummaries);

    for (const summary of freshSummaries) {
      if (!processingRef.current) return;
      const dayBlocks = freshBlocks.filter(block => block.date === summary.date);
      const allComplete = dayBlocks.length > 0 && dayBlocks.every(block => block.status === 'completed');

      if (!allComplete) continue;
      if (summary.status === 'completed') continue;

      let attempt = summary.attempts ?? 0;
      let backoff = 1000;

      while (processingRef.current) {
        const runningSummary: DailySummary = {
          ...summary,
          status: 'running',
          attempts: attempt + 1,
          lastUpdated: Date.now(),
          error: undefined,
        };
        await persistDailySummary(runningSummary);
        setActiveTask({
          task: 'Daily Aggregation',
          model: MODELS.AGGREGATION.DAILY,
        });

        try {
          const results = dayBlocks.map(block => block.result).filter(Boolean);
          const response = await AnalysisService.aggregateDay(results);
          const completedSummary: DailySummary = {
            ...runningSummary,
            status: 'completed',
            value: response.data,
            modelUsed: response.meta.model,
            keyUsed: response.meta.key,
            lastUpdated: Date.now(),
          };
          await persistDailySummary(completedSummary);
          setActiveTask({
            task: 'Daily Aggregation',
            model: response.meta.model,
            key: response.meta.key,
          });
          break;
        } catch (error: any) {
          if (isNoKeysError(error)) {
            const retryingSummary: DailySummary = {
              ...runningSummary,
              status: 'retrying',
              error: error.message,
              lastUpdated: Date.now(),
            };
            await persistDailySummary(retryingSummary);
            setStatusMessage('All API keys are exhausted. Add new keys to resume.');
            processingRef.current = false;
            return;
          }

          const shouldRetry = isRetryable(error) && attempt + 1 < MAX_RETRIES;
          if (!shouldRetry) {
            const failedSummary: DailySummary = {
              ...runningSummary,
              status: 'failed',
              error: stringifyError(error),
              lastUpdated: Date.now(),
            };
            await persistDailySummary(failedSummary);
            break;
          }

          const retryingSummary: DailySummary = {
            ...runningSummary,
            status: 'retrying',
            error: stringifyError(error),
            lastUpdated: Date.now(),
          };
          await persistDailySummary(retryingSummary);
          await delay(backoff);
          backoff *= 2;
          attempt += 1;
        }
      }
    }
  }

  async function processPeriodAggregation() {
    const freshSummaries = await StorageService.getDailySummaries();
    const completedDaily = freshSummaries.filter(summary => summary.status === 'completed');
    if (completedDaily.length === 0) return;

    const weeklyGroups = groupDailySummaries(completedDaily, 'weekly');
    const monthlyGroups = groupDailySummaries(completedDaily, 'monthly');

    const existingPeriods = await StorageService.getPeriodSummaries();
    const existingMap = new Map(existingPeriods.map(summary => [summary.periodKey, summary]));

    for (const [periodKey, dailyGroup] of [...weeklyGroups, ...monthlyGroups]) {
      if (!processingRef.current) return;
      const existing = existingMap.get(periodKey);
      if (existing?.status === 'completed') continue;

      const periodType = periodKey.includes('W') ? 'weekly' : 'monthly';
      let attempt = existing?.attempts ?? 0;
      let backoff = 1000;

      while (processingRef.current) {
        const runningSummary: PeriodSummary = {
          periodKey,
          periodType,
          status: 'running',
          attempts: attempt + 1,
          lastUpdated: Date.now(),
          error: undefined,
          value: existing?.value,
        };
        await persistPeriodSummary(runningSummary);
        setActiveTask({
          task: periodType === 'weekly' ? 'Weekly Aggregation' : 'Monthly Aggregation',
          model: MODELS.AGGREGATION.REPORT,
        });

        try {
          const response = await AnalysisService.aggregatePeriod(
            dailyGroup.map(summary => summary.value),
            periodKey
          );
          const completedSummary: PeriodSummary = {
            ...runningSummary,
            status: 'completed',
            value: response.data,
            modelUsed: response.meta.model,
            keyUsed: response.meta.key,
            lastUpdated: Date.now(),
          };
          await persistPeriodSummary(completedSummary);
          setActiveTask({
            task: periodType === 'weekly' ? 'Weekly Aggregation' : 'Monthly Aggregation',
            model: response.meta.model,
            key: response.meta.key,
          });
          break;
        } catch (error: any) {
          if (isNoKeysError(error)) {
            const retryingSummary: PeriodSummary = {
              ...runningSummary,
              status: 'retrying',
              error: error.message,
              lastUpdated: Date.now(),
            };
            await persistPeriodSummary(retryingSummary);
            setStatusMessage('All API keys are exhausted. Add new keys to resume.');
            processingRef.current = false;
            return;
          }

          const shouldRetry = isRetryable(error) && attempt + 1 < MAX_RETRIES;
          if (!shouldRetry) {
            const failedSummary: PeriodSummary = {
              ...runningSummary,
              status: 'failed',
              error: stringifyError(error),
              lastUpdated: Date.now(),
            };
            await persistPeriodSummary(failedSummary);
            break;
          }

          const retryingSummary: PeriodSummary = {
            ...runningSummary,
            status: 'retrying',
            error: stringifyError(error),
            lastUpdated: Date.now(),
          };
          await persistPeriodSummary(retryingSummary);
          await delay(backoff);
          backoff *= 2;
          attempt += 1;
        }
      }
    }
  }

  async function persistBlock(updated: ChatBlock) {
    await StorageService.saveChatBlocks([updated]);
    setBlocks(prev => prev.map(block => (block.id === updated.id ? updated : block)));
  }

  async function persistDailySummary(updated: DailySummary) {
    await StorageService.saveDailySummary(updated);
    setDailySummaries(prev => {
      const existing = prev.find(summary => summary.date === updated.date);
      if (!existing) return [...prev, updated];
      return prev.map(summary => (summary.date === updated.date ? updated : summary));
    });
  }

  async function persistPeriodSummary(updated: PeriodSummary) {
    await StorageService.savePeriodSummary(updated);
    setPeriodSummaries(prev => {
      const existing = prev.find(summary => summary.periodKey === updated.periodKey);
      if (!existing) return [...prev, updated];
      return prev.map(summary => (summary.periodKey === updated.periodKey ? updated : summary));
    });
  }

  async function retryFailed() {
    const failedBlocks = blocks.filter(block => block.status === 'failed');
    const failedDaily = dailySummaries.filter(summary => summary.status === 'failed');
    const failedPeriods = periodSummaries.filter(summary => summary.status === 'failed');

    await StorageService.saveChatBlocks(
      failedBlocks.map(block => ({
        ...block,
        status: 'pending',
        error: undefined,
        lastUpdated: Date.now(),
      }))
    );

    await Promise.all(
      failedDaily.map(summary =>
        StorageService.saveDailySummary({
          ...summary,
          status: 'pending',
          error: undefined,
          lastUpdated: Date.now(),
        })
      )
    );

    await Promise.all(
      failedPeriods.map(summary =>
        StorageService.savePeriodSummary({
          ...summary,
          status: 'pending',
          error: undefined,
          lastUpdated: Date.now(),
        })
      )
    );

    await loadState();
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="flex min-h-screen">
        <aside className="w-96 border-r border-slate-900 bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900/40 p-6 flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <Activity className="text-blue-400" />
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Messenger Insight</h1>
              <p className="text-xs text-slate-400">Client-side analysis pipeline</p>
            </div>
          </div>

          <KeyManager />

          <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">Processing Status</h3>
              <span className="text-xs text-slate-400">Blocks → Daily → Period</span>
            </div>

            <StatusRow label="Blocks" stats={blockStats} />
            <StatusRow label="Daily" stats={dailyStats} />
            <StatusRow label="Weekly/Monthly" stats={periodStats} />

            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-blue-400" />
                <span className="font-medium">Active Task</span>
              </div>
              <div className="mt-2 space-y-1 text-slate-400">
                <div>{activeTask?.task || 'Idle'}</div>
                <div>Model: {activeTask?.model || '—'}</div>
                <div>API Key: {activeTask?.key ? `...${activeTask.key.slice(-4)}` : '—'}</div>
              </div>
            </div>

            {statusMessage && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                <AlertTriangle className="h-4 w-4 mt-0.5" />
                <span>{statusMessage}</span>
              </div>
            )}

            <div className="flex flex-col gap-2">
              {!isProcessing ? (
                <button
                  onClick={startAnalysis}
                  disabled={blocks.length === 0}
                  className="flex items-center justify-center gap-2 rounded-full bg-blue-600 px-6 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-40"
                >
                  <Play className="h-4 w-4" />
                  {blockStats.completed > 0 && blockStats.completed < blockStats.total
                    ? 'Resume Processing'
                    : 'Start Processing'}
                </button>
              ) : (
                <button
                  onClick={() => {
                    processingRef.current = false;
                    setIsProcessing(false);
                    setStatusMessage('Processing paused by user.');
                  }}
                  className="flex items-center justify-center gap-2 rounded-full bg-rose-600 px-6 py-2 text-sm font-semibold text-white transition hover:bg-rose-500"
                >
                  <PauseCircle className="h-4 w-4" />
                  Pause Processing
                </button>
              )}
              <button
                onClick={retryFailed}
                disabled={blockStats.failed + dailyStats.failed + periodStats.failed === 0}
                className="flex items-center justify-center gap-2 rounded-full border border-slate-700 px-6 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 disabled:opacity-40"
              >
                <RefreshCw className="h-4 w-4" />
                Retry Failed Items
              </button>
            </div>
          </div>
        </aside>

        <main className="flex-1 p-8 space-y-8">
          <header className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-semibold">Analytics Dashboard</h2>
              <p className="text-sm text-slate-400">Upload Messenger exports and track insights with a resumable pipeline.</p>
            </div>
          </header>

          <section className="grid gap-6 lg:grid-cols-[2fr,1fr]">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-blue-500/20 p-3">
                  <Upload className="h-5 w-5 text-blue-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">File Upload</h3>
                  <p className="text-sm text-slate-400">Validate and normalize Facebook Messenger JSON exports.</p>
                </div>
              </div>
              <div className="mt-6 flex flex-col gap-3">
                <input
                  type="file"
                  accept=".json"
                  onChange={handleFileUpload}
                  className="file:mr-4 file:rounded-full file:border-0 file:bg-blue-500/10 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-300 hover:file:bg-blue-500/20 text-sm text-slate-400"
                />
                {uploadError && (
                  <div className="flex items-center gap-2 text-sm text-rose-300">
                    <AlertTriangle className="h-4 w-4" />
                    {uploadError}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
              <h3 className="text-lg font-semibold mb-4">Pipeline Overview</h3>
              <div className="space-y-4 text-sm text-slate-300">
                <PipelineStep label="Validate & Normalize" status={blocks.length > 0 ? 'completed' : 'pending'} />
                <PipelineStep label="Block Analysis" status={blockStats.completed === blockStats.total && blockStats.total > 0 ? 'completed' : isProcessing ? 'running' : blockStats.failed > 0 ? 'failed' : 'pending'} />
                <PipelineStep label="Daily Aggregation" status={dailyStats.completed === dailyStats.total && dailyStats.total > 0 ? 'completed' : dailyStats.failed > 0 ? 'failed' : 'pending'} />
                <PipelineStep label="Weekly/Monthly Aggregation" status={periodStats.completed > 0 ? 'completed' : periodStats.failed > 0 ? 'failed' : 'pending'} />
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <FileText className="h-4 w-4 text-slate-400" />
                Timeline Analysis
              </h3>
              <span className="text-xs text-slate-400">{blocks.length} blocks</span>
            </div>

            {blocks.length === 0 ? (
              <div className="text-sm text-slate-500">Upload a Messenger JSON export to begin.</div>
            ) : (
              <div className="space-y-8">
                {Object.entries(
                  blocks.reduce((acc, block) => {
                    (acc[block.date] = acc[block.date] || []).push(block);
                    return acc;
                  }, {} as Record<string, ChatBlock[]>)
                )
                  .sort()
                  .reverse()
                  .map(([date, dateBlocks]) => {
                    const summary = dailySummaries.find(summary => summary.date === date);
                    const completedBlocks = dateBlocks.filter(block => block.status === 'completed').length;

                    return (
                      <div key={date} className="space-y-4">
                        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                          <div>
                            <h4 className="text-lg font-semibold text-slate-100">{date}</h4>
                            <p className="text-xs text-slate-500">{completedBlocks}/{dateBlocks.length} blocks completed</p>
                          </div>
                          <span className={`text-xs px-2 py-1 rounded-full ${statusBadge(summary?.status || 'pending')}`}>
                            {STATUS_LABELS[summary?.status || 'pending']}
                          </span>
                        </div>

                        {summary?.value && (
                          <div className="rounded-xl border border-indigo-500/30 bg-gradient-to-br from-indigo-900/30 to-purple-900/10 p-5">
                            <div className="flex items-center gap-2 text-indigo-200 mb-3">
                              <Activity className="h-4 w-4" />
                              <span className="text-sm font-semibold">Daily Intelligence Report</span>
                            </div>
                            <p className="text-sm text-slate-200 leading-relaxed">{summary.value.daily_summary}</p>
                            <div className="mt-4 grid gap-4 md:grid-cols-2 text-xs text-slate-300">
                              <div className="rounded-lg bg-black/30 p-3">
                                <div className="text-[10px] uppercase tracking-wider text-slate-400">Stable Likes</div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {(summary.value.stable_likes || []).map((like: string, index: number) => (
                                    <span key={index} className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-indigo-200">
                                      {like}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <div className="rounded-lg bg-black/30 p-3">
                                <div className="text-[10px] uppercase tracking-wider text-slate-400">Communication Style</div>
                                <p className="mt-2 text-sm text-slate-200">{summary.value.communication_style}</p>
                              </div>
                            </div>
                          </div>
                        )}

                        {summary?.status === 'failed' && summary.error && (
                          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
                            Daily aggregation failed: {summary.error}
                          </div>
                        )}

                        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                          <div className="grid grid-cols-[repeat(auto-fill,minmax(12px,1fr))] gap-1.5">
                            {dateBlocks.map(block => (
                              <div
                                key={block.id}
                                title={`Block ${block.id.split('-').pop()} - ${block.status}`}
                                className={`aspect-square rounded-[2px] transition-all ${statusBlockClass(block.status)}`}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </section>

          {periodSummaries.length > 0 && (
            <section className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6">
              <h3 className="text-lg font-semibold mb-4">Weekly & Monthly Insights</h3>
              <div className="grid gap-4 md:grid-cols-2">
                {periodSummaries
                  .filter(summary => summary.status === 'completed')
                  .sort((a, b) => b.periodKey.localeCompare(a.periodKey))
                  .map(summary => (
                    <div key={summary.periodKey} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-sm font-semibold text-slate-100">{summary.periodKey}</h4>
                        <span className="text-[10px] uppercase tracking-wider text-slate-500">{summary.periodType}</span>
                      </div>
                      <p className="text-sm text-slate-300 leading-relaxed">
                        {summary.value?.period_summary}
                      </p>
                      <div className="mt-3 text-xs text-slate-400">
                        Recommendations: {(summary.value?.recommendations || []).slice(0, 2).join(' • ')}
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function StatusRow({ label, stats }: { label: string; stats: StatusStats }) {
  const percentage = stats.total === 0 ? 0 : Math.round((stats.completed / stats.total) * 100);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span>
          {stats.completed}/{stats.total} completed
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
        <div className="h-full bg-blue-500 transition-all" style={{ width: `${percentage}%` }} />
      </div>
      <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
        <StatusBadge status="pending" count={stats.pending} />
        <StatusBadge status="running" count={stats.running} />
        <StatusBadge status="retrying" count={stats.retrying} />
        <StatusBadge status="failed" count={stats.failed} />
      </div>
    </div>
  );
}

function StatusBadge({ status, count }: { status: JobStatus; count: number }) {
  if (!count) return null;
  return (
    <span className={`rounded-full px-2 py-0.5 ${statusBadge(status)} text-[10px]`}>{`${STATUS_LABELS[status]} ${count}`}</span>
  );
}

function PipelineStep({ label, status }: { label: string; status: JobStatus }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <span>{label}</span>
      <span className={`text-xs px-2 py-1 rounded-full ${statusBadge(status)}`}>{STATUS_LABELS[status]}</span>
    </div>
  );
}

type StatusStats = {
  total: number;
  completed: number;
  running: number;
  retrying: number;
  failed: number;
  pending: number;
};

function getStatusCounts(items: { status: JobStatus }[]): StatusStats {
  return items.reduce<StatusStats>(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] += 1;
      return acc;
    },
    { total: 0, completed: 0, running: 0, retrying: 0, failed: 0, pending: 0 }
  );
}

function statusBadge(status: JobStatus) {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30';
    case 'running':
      return 'bg-blue-500/20 text-blue-200 border border-blue-500/30';
    case 'retrying':
      return 'bg-amber-500/20 text-amber-200 border border-amber-500/30';
    case 'failed':
      return 'bg-rose-500/20 text-rose-200 border border-rose-500/30';
    default:
      return 'bg-slate-800 text-slate-300 border border-slate-700';
  }
}

function statusBlockClass(status: JobStatus) {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/80 hover:bg-emerald-400';
    case 'running':
      return 'bg-blue-500 animate-pulse';
    case 'retrying':
      return 'bg-amber-500';
    case 'failed':
      return 'bg-rose-500';
    default:
      return 'bg-slate-800 hover:bg-slate-700';
  }
}

function stringifyError(error: any) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || 'Unexpected error';
}

function isRetryable(error: any) {
  const message = stringifyError(error);
  return message.includes('429') || message.includes('RATE_LIMIT') || /\b5\d\d\b/.test(message);
}

function isNoKeysError(error: any) {
  const message = stringifyError(error);
  return message.includes('NO_AVAILABLE_KEYS');
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function groupDailySummaries(summaries: DailySummary[], type: 'weekly' | 'monthly') {
  const grouped = new Map<string, DailySummary[]>();

  summaries.forEach(summary => {
    const key = type === 'weekly' ? getWeekKey(summary.date) : summary.date.slice(0, 7);
    const list = grouped.get(key) || [];
    list.push(summary);
    grouped.set(key, list);
  });

  return Array.from(grouped.entries());
}

function getWeekKey(dateString: string) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const temp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = temp.getUTCDay() || 7;
  temp.setUTCDate(temp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((temp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${temp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
