
import { StorageService, ApiKey } from './storage';
import { MODEL_LIMITS } from '@/lib/constants';

const NEAR_LIMIT_THRESHOLD = 0.85;

export class ApiManager {
    static async getAvailableKey(modelName: keyof typeof MODEL_LIMITS): Promise<ApiKey | null> {
        const keys = await StorageService.getApiKeys();
        const activeKeys = keys.filter(k => k.isActive);

        const available = activeKeys.filter(key => this.isKeyBelowLimit(key, modelName));
        if (available.length === 0) return null;

        const belowThreshold = available.filter(key => this.getUsageRatio(key, modelName) < NEAR_LIMIT_THRESHOLD);
        const candidates = belowThreshold.length > 0 ? belowThreshold : available;

        return candidates.sort((a, b) => {
            const usageA = this.getUsageRatio(a, modelName);
            const usageB = this.getUsageRatio(b, modelName);
            if (usageA !== usageB) return usageA - usageB;
            return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
        })[0];
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

    static getUsageRatio(keyData: ApiKey, modelName: keyof typeof MODEL_LIMITS): number {
        const usage = keyData.usage[modelName];
        const limit = MODEL_LIMITS[modelName];
        if (!usage || !limit) return 0;

        const now = Date.now();
        if (now - usage.lastReset > 60000) return 0;

        const rpmRatio = usage.requests / limit.rpm;
        const tpmRatio = usage.tokens / limit.tpm;
        return Math.max(rpmRatio, tpmRatio);
    }

    static async reportUsage(key: string, model: string, tokens: number) {
        await StorageService.updateApiKeyUsage(key, model, tokens);
    }
}
