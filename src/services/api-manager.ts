
import { StorageService, ApiKey } from './storage';
import { MODEL_LIMITS } from '@/lib/constants';

export class ApiManager {
    static async getAvailableKey(modelName: keyof typeof MODEL_LIMITS): Promise<ApiKey | null> {
        const keys = await StorageService.getApiKeys();
        const activeKeys = keys.filter(k => k.isActive);

        // Sort keys by last usage to distribute load (round-robin-ish)
        // Actually simple strategy: First valid key. Use random offset if needed?
        // Let's stick to simple first valid.

        for (const keyData of activeKeys) {
            if (this.isKeyBelowLimit(keyData, modelName)) {
                return keyData;
            }
        }

        return null;
    }

    static isKeyBelowLimit(keyData: ApiKey, modelName: keyof typeof MODEL_LIMITS): boolean {
        const usage = keyData.usage[modelName];
        if (!usage) return true; // No usage yet

        const limit = MODEL_LIMITS[modelName];
        if (!limit) return true; // Unknown model? assume 'unlimited' or handle error

        const now = Date.now();
        // Check if reset needed (client side check, matching storage logic)
        if (now - usage.lastReset > 60000) {
            return true;
        }

        if (usage.requests >= limit.rpm) return false;
        if (usage.tokens >= limit.tpm) return false;

        return true;
    }

    static async reportUsage(key: string, model: string, tokens: number) {
        await StorageService.updateApiKeyUsage(key, model, tokens);
    }
}
