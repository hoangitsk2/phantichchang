
import { ChatBlock } from '@/services/storage';

const MAX_BLOCK_SIZE = 50; // messages per block (approx 2-3k tokens context safe for large prompts)

export function processFile(file: File): Promise<Map<string, ChatBlock[]>> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target?.result as string);
                if (!json.messages || !Array.isArray(json.messages)) {
                    reject(new Error('Invalid format: Missing messages array'));
                    return;
                }

                const blocksByDate = new Map<string, ChatBlock[]>();

                // sort messages by old->new
                const sorted = json.messages.reverse();

                // Group by date
                const messagesByDate: Record<string, any[]> = {};

                sorted.forEach((rawMsg: any) => {
                    // Normalize fields
                    const msg = {
                        sender_name: rawMsg.sender_name || rawMsg.senderName || 'Unknown',
                        content: rawMsg.content || rawMsg.text || '',
                        timestamp_ms: rawMsg.timestamp_ms || rawMsg.timestamp || 0,
                        sticker: rawMsg.sticker
                    };

                    if (!msg.content && !msg.sticker) return; // Skip empty

                    try {
                        const date = new Date(msg.timestamp_ms).toISOString().split('T')[0];
                        if (!messagesByDate[date]) messagesByDate[date] = [];
                        messagesByDate[date].push(msg);
                    } catch (e) {
                        console.error("Skipping invalid date msg", msg);
                    }
                });

                // Create blocks
                Object.keys(messagesByDate).forEach(date => {
                    const msgs = messagesByDate[date];
                    const blocks: ChatBlock[] = [];

                    for (let i = 0; i < msgs.length; i += MAX_BLOCK_SIZE) {
                        const slice = msgs.slice(i, i + MAX_BLOCK_SIZE);
                        blocks.push({
                            id: `${date}-${i}`,
                            date,
                            messages: slice,
                            status: 'pending'
                        });
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
