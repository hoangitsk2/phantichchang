
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION } from '@/lib/constants';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'retrying';

export interface ApiKey {
    key: string;
    label: string;
    addedAt: number;
    lastUsedAt?: number;
    usage: {
        [model: string]: {
            requests: number;
            tokens: number;
            lastReset: number;
        }
    };
    isActive: boolean;
}

export interface ChatBlock {
    id: string;
    date: string;
    messages: any[];
    status: JobStatus;
    attempts?: number;
    lastUpdated?: number;
    result?: any;
    error?: string;
    modelUsed?: string;
    keyUsed?: string;
}

export interface DailySummary {
    date: string;
    status: JobStatus;
    attempts?: number;
    lastUpdated?: number;
    value?: any;
    error?: string;
    modelUsed?: string;
    keyUsed?: string;
}

export interface PeriodSummary {
    periodKey: string;
    periodType: 'weekly' | 'monthly';
    status: JobStatus;
    attempts?: number;
    lastUpdated?: number;
    value?: any;
    error?: string;
    modelUsed?: string;
    keyUsed?: string;
}

interface MessengerDB extends DBSchema {
    api_keys: {
        key: string;
        value: ApiKey;
    };
    chat_blocks: {
        key: string;
        value: ChatBlock;
        indexes: { 'by-date': string; 'by-status': string };
    };
    daily_summaries: {
        key: string;
        value: DailySummary;
    };
    period_summaries: {
        key: string;
        value: PeriodSummary;
    };
}

let dbPromise: Promise<IDBPDatabase<MessengerDB>>;

export function getDB() {
    if (!dbPromise) {
        dbPromise = openDB<MessengerDB>(DB_NAME, DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains('api_keys')) {
                    db.createObjectStore('api_keys', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('chat_blocks')) {
                    const store = db.createObjectStore('chat_blocks', { keyPath: 'id' });
                    store.createIndex('by-date', 'date');
                    store.createIndex('by-status', 'status');
                }
                if (!db.objectStoreNames.contains('daily_summaries')) {
                    db.createObjectStore('daily_summaries', { keyPath: 'date' });
                }
                if (!db.objectStoreNames.contains('period_summaries')) {
                    db.createObjectStore('period_summaries', { keyPath: 'periodKey' });
                }
            },
        });
    }
    return dbPromise;
}

export const StorageService = {
    async addApiKey(key: string, label: string) {
        const db = await getDB();
        await db.put('api_keys', {
            key,
            label,
            addedAt: Date.now(),
            lastUsedAt: undefined,
            usage: {},
            isActive: true,
        });
    },

    async getApiKeys() {
        const db = await getDB();
        return db.getAll('api_keys');
    },

    async removeApiKey(key: string) {
        const db = await getDB();
        await db.delete('api_keys', key);
    },

    async updateApiKeyUsage(key: string, model: string, tokens: number) {
        const db = await getDB();
        const apiKey = await db.get('api_keys', key);
        if (!apiKey) return;

        const now = Date.now();
        const usage = apiKey.usage[model] || { requests: 0, tokens: 0, lastReset: now };

        // Reset if more than 1 minute passed
        if (now - usage.lastReset > 60000) {
            usage.requests = 0;
            usage.tokens = 0;
            usage.lastReset = now;
        }

        usage.requests++;
        usage.tokens += tokens;

        apiKey.usage[model] = usage;
        apiKey.lastUsedAt = now;
        await db.put('api_keys', apiKey);
    },

    async resetAnalysisData() {
        const db = await getDB();
        await Promise.all([
            db.clear('chat_blocks'),
            db.clear('daily_summaries'),
            db.clear('period_summaries'),
        ]);
    },

    async saveChatBlocks(blocks: ChatBlock[]) {
        const db = await getDB();
        const tx = db.transaction('chat_blocks', 'readwrite');
        await Promise.all(blocks.map(b => tx.store.put(b)));
        await tx.done;
    },

    async getChatBlocks() {
        const db = await getDB();
        return db.getAll('chat_blocks');
    },

    async getBlocksByDate(date: string) {
        const db = await getDB();
        return db.getAllFromIndex('chat_blocks', 'by-date', date);
    },

    async saveDailySummary(summary: DailySummary) {
        const db = await getDB();
        await db.put('daily_summaries', summary);
    },

    async getDailySummaries() {
        const db = await getDB();
        return db.getAll('daily_summaries');
    },

    async getDailySummaryByDate(date: string) {
        const db = await getDB();
        return db.get('daily_summaries', date);
    },

    async savePeriodSummary(summary: PeriodSummary) {
        const db = await getDB();
        await db.put('period_summaries', summary);
    },

    async getPeriodSummaries() {
        const db = await getDB();
        return db.getAll('period_summaries');
    },

    getDB,
};
