
export const MODELS = {
    BLOCK_ANALYSIS: {
        PRIMARY: 'gemma-3-27b',
        FALLBACK_1: 'gemma-3-12b',
        FALLBACK_2: 'gemma-3-4b',
    },
    AGGREGATION: {
        DAILY: 'gemma-3-4b',          // User requirement: gemma-3-4b ONLY for daily
        REPORT: 'gemini-3-flash',     // User requirement: gemini-3-flash for week/month
    },
    TEST: {
        DEBUG: 'gemini-2.5-flash-lite',
    },
} as const;

export const MODEL_LIMITS = {
    'gemma-3-27b': { rpm: 30, tpm: 15000 },
    'gemma-3-12b': { rpm: 30, tpm: 15000 },
    'gemma-3-4b': { rpm: 30, tpm: 15000 },
    'gemini-3-flash': { rpm: 5, tpm: 250000 },
    'gemini-2.5-flash': { rpm: 5, tpm: 250000 },
    'gemini-2.5-flash-lite': { rpm: 10, tpm: 250000 },
};

export const STORAGE_KEYS = {
    API_KEYS: 'api_keys',
    CHATS: 'chats',
    JOBS: 'jobs',
};

export const DB_NAME = 'messenger-analyst-db';
export const DB_VERSION = 1;
