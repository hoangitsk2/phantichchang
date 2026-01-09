
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ApiManager } from './api-manager';
import { MODELS } from '@/lib/constants';

// Define the shape of analysis result based on user requirements
export interface AnalysisResult {
    summary: string;
    emotional_state: string;
    likes: string[];
    dislikes: string[]; // detailed dislikes/avoidance
    communication_style: {
        proactive_score: number; // 0-10
        emotional_score: number; // 0-10 (Logic vs Emotion)
        traits: string[];
    };
    confidence_score: number;
}

const BLOCK_ANALYSIS_PROMPT = `
You are an expert behavioral analyst specializing in digital communication.
Analyze the following chat block (Messenger history).
Focus on:
1. Micro-preferences (likes, interests, fast replies to specific topics).
2. Dislikes / Avoidance (delayed replies, short answers, topic changes).
3. Emotional state & Communication style.

Output strictly in JSON format:
{
  "summary": "Brief summary of the conversation usage",
  "emotional_state": "Current emotional tone",
  "likes": ["list", "of", "detected", "interests"],
  "dislikes": ["list", "of", "negatives"],
  "communication_style": {
    "proactive_score": 5,
    "emotional_score": 5,
    "traits": ["keywords", "about", "style"]
  },
  "confidence_score": 8
}
Do not hallucinate. If info is missing, leave arrays empty.
`;

export class AnalysisService {
    static async analyzeBlock(messages: any[], modelName: string = MODELS.BLOCK_ANALYSIS.PRIMARY): Promise<AnalysisResult> {
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

    private static async generateAnalysis(messages: any[], modelName: string): Promise<AnalysisResult> {
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
            await ApiManager.reportUsage(keyData.key, modelName, inputTokens + outputTokens);

            return JSON.parse(text);
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

    static async aggregateDay(dayBlocks: AnalysisResult[]): Promise<any> {
        // STRICT REQUIREMENT: Use gemma-3-4b ONLY
        const modelName = MODELS.AGGREGATION.DAILY;

        // Combine block insights
        const combinedLikes = Array.from(new Set(dayBlocks.flatMap(b => b.likes)));
        const combinedDislikes = Array.from(new Set(dayBlocks.flatMap(b => b.dislikes)));
        const combinedTraits = Array.from(new Set(dayBlocks.flatMap(b => b.communication_style.traits)));
        const summaries = dayBlocks.map(b => b.summary).join('\n- ');

        const prompt = `
        You are a Data Aggregator.
        Aggregate these chat analysis blocks from ONE DAY into a single daily report.
        
        INPUT DATA:
        - Block Summaries:
        ${summaries}
        
        - Detected Likes: ${combinedLikes.join(', ')}
        - Detected Dislikes: ${combinedDislikes.join(', ')}
        - Traits: ${combinedTraits.join(', ')}

        OUTPUT strictly in JSON:
        {
           "daily_summary": "Comprehensive narrative of the day's conversations",
           "emotional_timeline": "Morning vs Afternoon vs Night shifts",
           "stable_preferences": ["confirmed likes"],
           "avoidance_topics": ["topics avoided today"],
           "communication_style": "Overall style rating",
           "recommendation": "Advice for interacting"
        }
        `;

        const keyData = await ApiManager.getAvailableKey(modelName as any);
        if (!keyData) throw new Error(`NO_AVAILABLE_KEYS for aggregation`);

        try {
            const genAI = new GoogleGenerativeAI(keyData.key);
            const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } as any });

            const result = await model.generateContent(prompt);
            const text = result.response.text();

            await ApiManager.reportUsage(keyData.key, modelName, (prompt.length + text.length) / 4);

            return JSON.parse(text);
        } catch (e: any) {
            console.error("Aggregation failed", e);
            if (e.message?.includes('429') || e.status === 429) {
                await ApiManager.reportUsage(keyData.key, modelName, 999999);
            }
            throw e;
        }
    }
}
