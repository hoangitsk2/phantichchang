
import { ChatBlock, JobStatus } from '@/services/storage';

const MAX_BLOCK_SIZE = 50;
const BLOCK_GAP_MINUTES = 30;

interface NormalizedMessage {
    sender_name: string;
    content: string;
    timestamp_ms: number;
    sticker?: any;
}

function validateMessengerExport(json: any) {
    if (!json || typeof json !== 'object') {
        throw new Error('Invalid JSON: Expected an object root.');
    }
    if (!Array.isArray(json.messages)) {
        throw new Error('Invalid format: Missing messages array.');
    }
    if (!json.title && !json.thread_path) {
        throw new Error('Invalid format: Missing thread metadata (title or thread_path).');
    }
}

function normalizeMessage(rawMsg: any): NormalizedMessage | null {
    const senderName = rawMsg.sender_name || rawMsg.senderName;
    const timestamp = rawMsg.timestamp_ms || rawMsg.timestamp;
    const content = rawMsg.content || rawMsg.text || '';
    const sticker = rawMsg.sticker;

    if (!senderName || !timestamp) return null;
    if (!content && !sticker) return null;

    return {
        sender_name: senderName,
        content,
        timestamp_ms: timestamp,
        sticker,
    };
}

function createBlock(date: string, index: number, messages: NormalizedMessage[], status: JobStatus): ChatBlock {
    return {
        id: `${date}-${index}`,
        date,
        messages,
        status,
        attempts: 0,
        lastUpdated: Date.now(),
    };
}

export function processFile(file: File): Promise<Map<string, ChatBlock[]>> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target?.result as string);
                validateMessengerExport(json);

                const blocksByDate = new Map<string, ChatBlock[]>();

                const sorted = [...json.messages].reverse();

                // Group by date
                const messagesByDate: Record<string, NormalizedMessage[]> = {};

                for (const rawMsg of sorted) {
                    const msg = normalizeMessage(rawMsg);
                    if (!msg) continue;

                    try {
                        const date = new Date(msg.timestamp_ms).toISOString().split('T')[0];
                        if (!messagesByDate[date]) messagesByDate[date] = [];
                        messagesByDate[date].push(msg);
                    } catch (e) {
                        console.error("Skipping invalid date msg", msg);
                    }
                }

                const hasMessages = Object.values(messagesByDate).some(list => list.length > 0);
                if (!hasMessages) {
                    reject(new Error('No valid messages found after normalization.'));
                    return;
                }

                // Create blocks
                Object.keys(messagesByDate).forEach(date => {
                    const msgs = messagesByDate[date];
                    const blocks: ChatBlock[] = [];
                    let blockIndex = 0;
                    let currentBlock: NormalizedMessage[] = [];
                    let lastTimestamp: number | null = null;

                    for (const msg of msgs) {
                        const gapMinutes = lastTimestamp ? (msg.timestamp_ms - lastTimestamp) / 60000 : 0;
                        const shouldSplit = currentBlock.length >= MAX_BLOCK_SIZE || gapMinutes > BLOCK_GAP_MINUTES;

                        if (shouldSplit && currentBlock.length > 0) {
                            blocks.push(createBlock(date, blockIndex, currentBlock, 'pending'));
                            blockIndex += 1;
                            currentBlock = [];
                        }

                        currentBlock.push(msg);
                        lastTimestamp = msg.timestamp_ms;
                    }

                    if (currentBlock.length > 0) {
                        blocks.push(createBlock(date, blockIndex, currentBlock, 'pending'));
                    }
                    blocksByDate.set(date, blocks);
                });

                resolve(blocksByDate);
            } catch (err) {
                reject(err);
            }
        };
        reader.readAsText(file);
    });
}
