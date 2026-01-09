
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ApiManager } from './api-manager';
import { MODELS } from '@/lib/constants';

// Define the shape of analysis result based on user requirements
export interface AnalysisResult {
    summary: string;
    likes: string[];
    dislikes: string[];
    communication_patterns: string[];
    emotional_cues: string[];
    confidence_score: number;
}

export interface AnalysisMeta {
    model: string;
    key: string;
    tokenEstimate: number;
}

export interface AnalysisResponse<T> {
    data: T;
    meta: AnalysisMeta;
}

const BLOCK_ANALYSIS_PROMPT = `
You are an expert behavioral analyst specializing in digital communication.
Analyze the following chat block (Messenger history).
Focus on:
1. Micro-preferences (likes, interests, fast replies to specific topics).
2. Dislikes / Avoidance (delayed replies, short answers, topic changes).
3. Communication patterns (pace, response length, engagement consistency).
4. Emotional cues (tone shifts, sentiment markers) grounded ONLY in the provided text.

Output strictly in JSON format:
{
  "summary": "Brief factual summary of the block",
  "likes": ["micro-preferences"],
  "dislikes": ["avoidance signals"],
  "communication_patterns": ["short bullets about behavior"],
  "emotional_cues": ["neutral/positive/negative cues with evidence"],
  "confidence_score": 0.0
}
Do not hallucinate. If info is missing, leave arrays empty and keep confidence low (0-1 scale).
`;

export class AnalysisService {
    static async analyzeBlock(messages: any[], modelName: string = MODELS.BLOCK_ANALYSIS.PRIMARY): Promise<AnalysisResponse<AnalysisResult>> {
        let currentModel = modelName;

        // Try primary model
        try {
            return await this.generateAnalysis(messages, currentModel);
        } catch (error: any) {
            // Logic for Fallback
            if (currentModel === MODELS.BLOCK_ANALYSIS.PRIMARY) {
                console.warn(`Primary model ${currentModel} failed. Switching to fallback ${MODELS.BLOCK_ANALYSIS.FALLBACK_1}`);
                currentModel = MODELS.BLOCK_ANALYSIS.FALLBACK_1;
                return await this.generateAnalysis(messages, currentModel);
            }
            throw error;
        }
    }

    private static async generateAnalysis(messages: any[], modelName: string): Promise<AnalysisResponse<AnalysisResult>> {
        const keyData = await ApiManager.getAvailableKey(modelName as any);
        if (!keyData) {
            throw new Error(`NO_AVAILABLE_KEYS for ${modelName}`);
        }

        try {
            const genAI = new GoogleGenerativeAI(keyData.key);
            const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } as any });

            const chatText = messages.map(m => `[${new Date(m.timestamp_ms).toISOString()}] ${m.sender_name}: ${m.content}`).join('\n');
            const input = `${BLOCK_ANALYSIS_PROMPT}\n\nCHAT DATA:\n${chatText}`;

            const result = await model.generateContent(input);
            const response = result.response;
            const text = response.text();

            const inputTokens = input.length / 4;
            const outputTokens = text.length / 4;
            const totalTokens = inputTokens + outputTokens;
            await ApiManager.reportUsage(keyData.key, modelName, totalTokens);

            return {
                data: JSON.parse(text),
                meta: { model: modelName, key: keyData.key, tokenEstimate: totalTokens },
            };
        } catch (e: any) {
            console.error(`Analysis failed with ${modelName}`, e);

            // Handle Rate Limits specifically to trigger key rotation
            if (e.message?.includes('429') || e.status === 429) {
                // Mark key exhaustion locally
                await ApiManager.reportUsage(keyData.key, modelName, 999999);
                throw new Error(`RATE_LIMIT_EXCEEDED on ${modelName}`);
            }
            throw e;
        }
    }

    static async aggregateDay(dayBlocks: AnalysisResult[]): Promise<AnalysisResponse<any>> {
        // STRICT REQUIREMENT: Use gemma-3-4b ONLY
        const modelName = MODELS.AGGREGATION.DAILY;

        // Combine block insights
        const combinedLikes = Array.from(new Set(dayBlocks.flatMap(b => b.likes)));
        const combinedDislikes = Array.from(new Set(dayBlocks.flatMap(b => b.dislikes)));
        const combinedPatterns = Array.from(new Set(dayBlocks.flatMap(b => b.communication_patterns)));
        const combinedCues = Array.from(new Set(dayBlocks.flatMap(b => b.emotional_cues)));
        const summaries = dayBlocks.map(b => b.summary).join('\n- ');

        const prompt = `
        You are a Data Aggregator.
        Aggregate these chat analysis blocks from ONE DAY into a single daily report.
        Do NOT analyze raw chat text. Use only the provided block summaries and signals.
        
        INPUT DATA:
        - Block Summaries:
        ${summaries}
        
        - Detected Likes: ${combinedLikes.join(', ')}
        - Detected Dislikes: ${combinedDislikes.join(', ')}
        - Communication Patterns: ${combinedPatterns.join(', ')}
        - Emotional Cues: ${combinedCues.join(', ')}

        OUTPUT strictly in JSON:
        {
           "daily_summary": "Comprehensive narrative of the day's conversations",
           "emotional_timeline": "Morning vs Afternoon vs Night shifts",
           "stable_likes": ["confirmed likes"],
           "stable_dislikes": ["topics avoided today"],
           "communication_style": "Overall style rating",
           "messaging_recommendations": ["Advice for interacting"]
        }
        `;

        const keyData = await ApiManager.getAvailableKey(modelName as any);
        if (!keyData) throw new Error(`NO_AVAILABLE_KEYS for aggregation`);

        try {
            const genAI = new GoogleGenerativeAI(keyData.key);
            const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } as any });

            const result = await model.generateContent(prompt);
            const text = result.response.text();

            const totalTokens = (prompt.length + text.length) / 4;
            await ApiManager.reportUsage(keyData.key, modelName, totalTokens);

            return {
                data: JSON.parse(text),
                meta: { model: modelName, key: keyData.key, tokenEstimate: totalTokens },
            };
        } catch (e: any) {
            console.error("Aggregation failed", e);
            if (e.message?.includes('429') || e.status === 429) {
                await ApiManager.reportUsage(keyData.key, modelName, 999999);
            }
            throw e;
        }
    }

    static async aggregatePeriod(dailySummaries: any[], periodLabel: string): Promise<AnalysisResponse<any>> {
        const modelName = MODELS.AGGREGATION.REPORT;
        const summaryText = dailySummaries.map((summary) => summary.daily_summary || '').filter(Boolean).join('\n- ');
        const likes = Array.from(new Set(dailySummaries.flatMap((summary) => summary.stable_likes || [])));
        const dislikes = Array.from(new Set(dailySummaries.flatMap((summary) => summary.stable_dislikes || [])));
        const styles = Array.from(new Set(dailySummaries.map((summary) => summary.communication_style).filter(Boolean)));

        const prompt = `
        You are a weekly/monthly report aggregator.
        Use ONLY the provided daily summaries (already derived from block analysis).
        No raw chat text is allowed.

        PERIOD: ${periodLabel}
        DAILY SUMMARIES:
        ${summaryText}

        STABLE LIKES: ${likes.join(', ')}
        STABLE DISLIKES: ${dislikes.join(', ')}
        COMMUNICATION STYLE NOTES: ${styles.join(', ')}

        OUTPUT strictly in JSON:
        {
          "period_summary": "High-level report",
          "trend_highlights": ["behavioral trend bullets"],
          "stable_preferences": ["likes across period"],
          "avoidance_signals": ["dislikes across period"],
          "communication_shifts": ["style shifts across the period"],
          "recommendations": ["actionable, grounded suggestions"]
        }
        `;

        const keyData = await ApiManager.getAvailableKey(modelName as any);
        if (!keyData) throw new Error(`NO_AVAILABLE_KEYS for period aggregation`);

        try {
            const genAI = new GoogleGenerativeAI(keyData.key);
            const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } as any });

            const result = await model.generateContent(prompt);
            const text = result.response.text();
            const totalTokens = (prompt.length + text.length) / 4;

            await ApiManager.reportUsage(keyData.key, modelName, totalTokens);

            return {
                data: JSON.parse(text),
                meta: { model: modelName, key: keyData.key, tokenEstimate: totalTokens },
            };
        } catch (e: any) {
            console.error("Period aggregation failed", e);
            if (e.message?.includes('429') || e.status === 429) {
                await ApiManager.reportUsage(keyData.key, modelName, 999999);
            }
            throw e;
        }
    }
}
