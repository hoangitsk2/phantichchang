
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION } from '@/lib/constants';

export interface ApiKey {
    key: string;
    label: string;
    addedAt: number;
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
    status: 'pending' | 'processing' | 'completed' | 'failed';
    result?: any;
    error?: string;
    modelUsed?: string;
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
        value: any;
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
            usage: {},
            isActive: true,
        });
    },

    async getApiKeys() {
        const db = await getDB();
        return db.getAll('api_keys');
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
        await db.put('api_keys', apiKey);
    },

    async saveChatBlocks(blocks: ChatBlock[]) {
        const db = await getDB();
        const tx = db.transaction('chat_blocks', 'readwrite');
        await Promise.all(blocks.map(b => tx.store.put(b)));
        await tx.done;
    },

    async getBlocksByDate(date: string) {
        const db = await getDB();
        return db.getAllFromIndex('chat_blocks', 'by-date', date);
    },

    async saveDailySummary(date: string, summary: any) {
        const db = await getDB();
        await db.put('daily_summaries', { key: date, value: summary });
    },

    async getDailySummaries() {
        const db = await getDB();
        return db.getAll('daily_summaries');
    },

    getDB,
};
