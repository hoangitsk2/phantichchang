
'use client';

import { useState, useEffect } from 'react';
import { StorageService, ApiKey } from '@/services/storage';
import { Plus, Trash2, RefreshCw, Key } from 'lucide-react';
import { MODEL_LIMITS } from '@/lib/constants';

export default function KeyManager() {
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [newKey, setNewKey] = useState('');
    const [label, setLabel] = useState('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadKeys();
        const interval = setInterval(loadKeys, 5000); // Poll usage updates
        return () => clearInterval(interval);
    }, []);

    async function loadKeys() {
        const k = await StorageService.getApiKeys();
        setKeys(k);
        setLoading(false);
    }

    async function handleAdd() {
        if (!newKey.trim()) return;
        await StorageService.addApiKey(newKey.trim(), label || `Key ${keys.length + 1}`);
        setNewKey('');
        setLabel('');
        loadKeys();
    }

    // Calculate usage percentage for display
    function getUsageDisplay(apiKey: ApiKey) {
        const modelNames = Object.keys(MODEL_LIMITS);
        const now = Date.now();

        const usageSnapshots = modelNames.map((model) => {
            const usage = apiKey.usage[model];
            const limit = MODEL_LIMITS[model as keyof typeof MODEL_LIMITS];
            if (!usage || !limit) return { rpm: 0, tpm: 0 };
            if (now - usage.lastReset > 60000) return { rpm: 0, tpm: 0 };
            return {
                rpm: Math.round((usage.requests / limit.rpm) * 100),
                tpm: Math.round((usage.tokens / limit.tpm) * 100),
            };
        });

        return usageSnapshots.reduce(
            (max, current) => ({
                rpm: Math.max(max.rpm, current.rpm),
                tpm: Math.max(max.tpm, current.tpm),
            }),
            { rpm: 0, tpm: 0 }
        );
    }

    async function handleBulkUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            const text = event.target?.result as string;
            if (!text) return;

            // Format: email,key,email,key...
            // Split by comma, trim whitespace
            const parts = text.split(',').map(p => p.trim()).filter(p => p);

            let count = 0;
            for (let i = 0; i < parts.length; i += 2) {
                const email = parts[i]; // label
                const key = parts[i + 1]; // api key

                if (email && key) {
                    await StorageService.addApiKey(key, email);
                    count++;
                }
            }

            if (count > 0) {
                alert(`Successfully imported ${count} keys.`);
                loadKeys();
            } else {
                alert('No valid keys found. Format should be: email,key,email,key');
            }
        };
        reader.readAsText(file);
    }

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 text-slate-100">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                    <Key className="w-5 h-5 text-blue-400" />
                    API Keys
                </h2>
                <span className="text-xs text-slate-400">Auto-rotates when limits reached</span>
            </div>

            <div className="flex flex-col gap-4 mb-6">
                {/* Single Add */}
                {/* Single Add */}
                <div className="flex flex-col gap-2">
                    <input
                        type="text"
                        placeholder="New Google AI Studio Key"
                        value={newKey}
                        onChange={e => setNewKey(e.target.value)}
                        className="bg-slate-800 border-slate-700 text-sm p-2 rounded w-full focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                    <div className="flex gap-2">
                        <input
                            type="text"
                            placeholder="Label (optional)"
                            value={label}
                            onChange={e => setLabel(e.target.value)}
                            className="bg-slate-800 border-slate-700 text-sm p-2 rounded flex-1 focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                        <button
                            onClick={handleAdd}
                            disabled={!newKey}
                            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 rounded text-sm font-medium transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Bulk Upload */}
                <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
                    <span className="text-xs text-slate-400 uppercase font-bold tracking-wider">Bulk Import:</span>
                    <label className="cursor-pointer bg-slate-800 hover:bg-slate-700 text-xs px-3 py-1.5 rounded transition-colors text-slate-300 flex items-center gap-2">
                        <span>Upload .txt (email,key)</span>
                        <input type="file" accept=".txt" className="hidden" onChange={handleBulkUpload} />
                    </label>
                </div>
            </div>

            <div className="space-y-3">
                {loading ? (
                    <div className="text-center text-slate-500 py-4">Loading keys...</div>
                ) : keys.length === 0 ? (
                    <div className="text-center text-slate-500 py-4 italic">No keys added. System cannot run.</div>
                ) : (
                    keys.map((k) => {
                        const usage = getUsageDisplay(k);
                        return (
                            <div key={k.key} className="bg-slate-950 p-3 rounded border border-slate-800 flex items-center gap-4">
                                <div className="flex-1">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="font-medium text-sm text-slate-200">{k.label}</span>
                                        <span className="text-xs text-slate-500 font-mono">...{k.key.slice(-4)}</span>
                                    </div>
                                    <div className="text-[11px] text-slate-500 flex items-center gap-2 mb-2">
                                        <RefreshCw className="w-3 h-3" />
                                        <span>{k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleTimeString()}` : 'Never used yet'}</span>
                                    </div>

                                    {/* Usage Bars */}
                                    <div className="space-y-1">
                                        <div className="flex items-center gap-2 text-[10px] text-slate-400">
                                            <span className="w-8">RPM</span>
                                            <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full transition-all ${usage.rpm > 80 ? 'bg-red-500' : 'bg-green-500'}`}
                                                    style={{ width: `${usage.rpm}%` }}
                                                />
                                            </div>
                                            <span className="w-6 text-right">{usage.rpm}%</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-[10px] text-slate-400">
                                            <span className="w-8">TPM</span>
                                            <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full transition-all ${usage.tpm > 80 ? 'bg-orange-500' : 'bg-blue-500'}`}
                                                    style={{ width: `${usage.tpm}%` }}
                                                />
                                            </div>
                                            <span className="w-6 text-right">{usage.tpm}%</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Actions (Delete only for now, can add toggle active) */}
                                <button
                                    className="text-slate-600 hover:text-red-400 p-2"
                                    onClick={async () => {
                                        if (!confirm(`Remove API key "${k.label}"?`)) return;
                                        await StorageService.removeApiKey(k.key);
                                        loadKeys();
                                    }}
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
