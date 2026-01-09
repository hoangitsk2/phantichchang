
'use client';

import { useState, useEffect } from 'react';
import { Upload, FileText, Activity, AlertTriangle, CheckCircle2 } from 'lucide-react';
import KeyManager from '@/components/dashboard/KeyManager';
import { processFile } from '@/lib/parser';
import { StorageService, ChatBlock } from '@/services/storage';
import { AnalysisService } from '@/services/analysis';

export default function Dashboard() {
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [dailySummaries, setDailySummaries] = useState<any[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [progress, setProgress] = useState({ total: 0, current: 0, failed: 0 });

  useEffect(() => {
    loadState();
  }, []);

  async function loadState() {
    const db = await StorageService.getDB();
    const allBlocks = await db.getAll('chat_blocks');
    const summaries = await StorageService.getDailySummaries();

    if (allBlocks.length > 0) {
      setBlocks(allBlocks);
      updateProgress(allBlocks);
    }
    if (summaries.length > 0) {
      setDailySummaries(summaries);
    }
  }

  function updateProgress(currentBlocks: ChatBlock[]) {
    const done = currentBlocks.filter(b => b.status === 'completed').length;
    const failed = currentBlocks.filter(b => b.status === 'failed').length;
    setProgress({ total: currentBlocks.length, current: done, failed });
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError('');
    try {
      const blocksMap = await processFile(file);
      const newBlocks: ChatBlock[] = [];
      blocksMap.forEach((v) => newBlocks.push(...v));

      await StorageService.saveChatBlocks(newBlocks);
      setBlocks(newBlocks);
      updateProgress(newBlocks);
    } catch (err: any) {
      setUploadError(err.message || 'Failed to parse file');
    }
  }

  async function startAnalysis() {
    setIsProcessing(true);

    // --- PHASE 1: BLOCK ANALYSIS ---
    const pending = blocks.filter(b => b.status === 'pending' || b.status === 'failed');

    // Batch processing
    const BATCH_SIZE = 3;

    // We iterate manually to allow state updates between batches
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      if (!isProcessing) break;

      const batch = pending.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (block) => {
        try {
          block.status = 'processing';
          setBlocks(prev => [...prev]);

          const result = await AnalysisService.analyzeBlock(block.messages);
          block.result = result;
          block.status = 'completed';
          block.modelUsed = 'gemma-3-27b';

          await StorageService.saveChatBlocks([block]);
        } catch (err: any) {
          console.error("Block failed", block.id, err);
          block.status = 'failed';
          block.error = String(err);
          await StorageService.saveChatBlocks([block]);
        }
      }));

      const db = await StorageService.getDB();
      const updated = await db.getAll('chat_blocks');
      setBlocks(updated);
      updateProgress(updated);
    }

    // --- PHASE 2: DAILY AGGREGATION ---
    const allBlocks = await StorageService.getDB().then(db => db.getAll('chat_blocks'));
    const existingSummaries = await StorageService.getDailySummaries();

    const blocksByDate = allBlocks.reduce((acc, b) => {
      (acc[b.date] = acc[b.date] || []).push(b);
      return acc;
    }, {} as Record<string, ChatBlock[]>);

    const dates = Object.keys(blocksByDate);

    for (const date of dates) {
      if (!isProcessing) break; // Check pause signal

      const dayBlocks = blocksByDate[date];
      const allDone = dayBlocks.every(b => b.status === 'completed');
      const alreadyAggregated = existingSummaries.some((s: any) => s.key === date);

      if (allDone && !alreadyAggregated && dayBlocks.length > 0) {
        try {
          const results = dayBlocks.map(b => b.result).filter(r => r);
          const summary = await AnalysisService.aggregateDay(results);

          await StorageService.saveDailySummary(date, summary);

          // Update local state
          const newSummaries = await StorageService.getDailySummaries();
          setDailySummaries(newSummaries);
        } catch (err) {
          console.error(`Aggregation failed for ${date}`, err);
        }
      }
    }

    setIsProcessing(false);
  }

  return (
    <div className="flex h-screen bg-black text-slate-200 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-80 bg-slate-950 border-r border-slate-900 flex flex-col p-4 gap-6">
        <div className="flex items-center gap-2 px-2">
          <Activity className="text-blue-500" />
          <h1 className="font-bold text-lg tracking-tight">Messenger Insight</h1>
        </div>

        <KeyManager />

        <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-800">
          <h3 className="text-sm font-medium mb-2 text-slate-400">Processing Status</h3>
          <div className="flex justify-between text-2xl font-bold mb-1">
            <span>{progress.current}</span>
            <span className="text-slate-600">/ {progress.total}</span>
          </div>
          <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
            <div
              className="bg-blue-500 h-full transition-all duration-300"
              style={{ width: progress.total ? `${(progress.current / progress.total) * 100}%` : '0%' }}
            />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-auto">
        <header className="h-16 border-b border-slate-900/50 flex items-center px-8 justify-between sticky top-0 bg-black/80 backdrop-blur z-10">
          <h2 className="font-medium">Analytics Dashboard</h2>
          <div>
            {!isProcessing ? (
              <button
                onClick={startAnalysis}
                disabled={blocks.length === 0 || progress.current === progress.total}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-6 py-2 rounded-full font-medium text-sm transition-all"
              >
                {progress.current > 0 && progress.current < progress.total ? 'Resume Analysis' : 'Start Analysis'}
              </button>
            ) : (
              <button
                onClick={() => setIsProcessing(false)}
                className="bg-red-600 hover:bg-red-500 px-6 py-2 rounded-full font-medium text-sm transition-all animate-pulse"
              >
                Pause Processing
              </button>
            )}
          </div>
        </header>

        <div className="p-8 space-y-8">
          {/* Upload Area */}
          <div className="border-2 border-dashed border-slate-800 rounded-2xl p-8 flex flex-col items-center justify-center gap-4 hover:border-blue-500/50 transition-colors bg-slate-950/30">
            <div className="bg-slate-900 p-4 rounded-full">
              <Upload className="w-6 h-6 text-blue-400" />
            </div>
            <div className="text-center">
              <p className="font-medium">Upload Messenger JSON</p>
              <p className="text-sm text-slate-500 mt-1">Supports large Facebook exports</p>
            </div>
            <input
              type="file"
              accept=".json"
              onChange={handleFileUpload}
              className="file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-500/10 file:text-blue-400 hover:file:bg-blue-500/20 text-sm text-slate-500"
            />
            {uploadError && <p className="text-red-400 text-sm">{uploadError}</p>}
          </div>

          {/* Timeline Analysis */}
          {blocks.length > 0 && (
            <div className="space-y-8">
              <h3 className="text-lg font-medium flex items-center gap-2">
                <FileText className="w-4 h-4 text-slate-500" />
                Timeline Analysis ({blocks.length} blocks)
              </h3>

              {Object.entries(
                blocks.reduce((acc, block) => {
                  (acc[block.date] = acc[block.date] || []).push(block);
                  return acc;
                }, {} as Record<string, ChatBlock[]>)
              ).sort().reverse().map(([date, dateBlocks]) => {
                const summaryWrapper = dailySummaries.find((s: any) => s.key === date);
                const summary = summaryWrapper?.value;

                return (
                  <div key={date} className="space-y-4">
                    {/* Sticky Date Header */}
                    <div className="sticky top-16 bg-black py-2 z-10 border-b border-white/5 flex justify-between items-center">
                      <h4 className="text-lg font-semibold text-slate-200">{date}</h4>
                      <span className="text-xs text-slate-500">{dateBlocks.length} blocks</span>
                    </div>

                    {/* Daily Summary Card (if available) */}
                    {summary && (
                      <div className="bg-gradient-to-br from-indigo-900/20 to-purple-900/10 border border-indigo-500/30 p-6 rounded-xl">
                        <h5 className="text-indigo-300 font-medium mb-2 flex items-center gap-2">
                          <Activity className="w-4 h-4" />
                          Daily Intelligence Report (Gemma-4b)
                        </h5>
                        <p className="text-slate-300 mb-4 leading-relaxed">{summary.daily_summary}</p>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                          <div className="bg-black/20 p-3 rounded">
                            <span className="text-xs uppercase tracking-wider text-slate-500 block mb-1">Stable Likes</span>
                            <div className="flex flex-wrap gap-1">
                              {summary.stable_preferences?.map((l: string, i: number) => (
                                <span key={i} className="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded text-xs">{l}</span>
                              ))}
                            </div>
                          </div>
                          <div className="bg-black/20 p-3 rounded">
                            <span className="text-xs uppercase tracking-wider text-slate-500 block mb-1">Communication Style</span>
                            <div className="text-slate-300">{summary.communication_style}</div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Block Grid */}
                    <div className="bg-slate-900/20 rounded-lg p-4 border border-slate-800/50">
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(12px,1fr))] gap-1.5">
                        {dateBlocks.map(b => (
                          <div
                            key={b.id}
                            title={`Block ${b.id.split('-').pop()} - ${b.status}`}
                            className={`
                                                aspect-square rounded-[1px] transition-all 
                                                ${b.status === 'completed' ? 'bg-emerald-500/80 hover:bg-emerald-400' :
                                b.status === 'processing' ? 'bg-blue-500 animate-pulse' :
                                  b.status === 'failed' ? 'bg-rose-500' : 'bg-slate-800 hover:bg-slate-700'}
                                            `}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
