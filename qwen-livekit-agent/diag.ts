/**
 * Diagnostic: Connect to DashScope and log ALL event types received
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import WebSocket from 'ws';

const apiKey = process.env.DASHSCOPE_API_KEY!;
const url = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-omni-flash-realtime';

console.log('Connecting to DashScope...');

const ws = new WebSocket(url, {
    headers: {
        'Authorization': `Bearer ${apiKey}`,
    },
});

ws.on('open', () => {
    console.log('Connected! Sending session.update and response.create...');

    // Send session update
    ws.send(JSON.stringify({
        type: 'session.update',
        session: {
            modalities: ['text', 'audio'],
            voice: 'Cherry',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
            },
            instructions: '你是一个友好的AI语音助手',
        },
    }));

    // Small delay then create response
    setTimeout(() => {
        ws.send(JSON.stringify({
            type: 'response.create',
            response: {
                instructions: '用中文简短地说"你好"',
            },
        }));
    }, 500);
});

ws.on('message', (data: Buffer) => {
    const event = JSON.parse(data.toString());

    // Log event type and key fields (skip audio data)
    const summary: any = { type: event.type };

    if (event.response) {
        summary.response_id = event.response?.id;
        summary.response_status = event.response?.status;
    }
    if (event.item) {
        summary.item_id = event.item?.id;
        summary.item_type = event.item?.type;
        summary.item_role = event.item?.role;
        if (event.item?.content) {
            summary.item_content = event.item.content.map((c: any) => ({ type: c.type, text: c.text?.substring(0, 50) }));
        }
    }
    if (event.part) {
        summary.part_type = event.part?.type;
    }
    if (event.item_id) {
        summary.event_item_id = event.item_id;
    }
    if (event.delta && event.type !== 'response.audio.delta') {
        summary.delta = event.delta?.substring?.(0, 80) || event.delta;
    }
    if (event.transcript) {
        summary.transcript = event.transcript?.substring?.(0, 80);
    }
    if (event.error) {
        summary.error = event.error;
    }

    console.log(JSON.stringify(summary));

    // Close after response.done  
    if (event.type === 'response.done') {
        console.log('\n=== Full response.done event ===');
        const sanitized = JSON.parse(data.toString());
        // Remove audio data from output items
        if (sanitized.response?.output) {
            for (const item of sanitized.response.output) {
                if (item.content) {
                    for (const c of item.content) {
                        if (c.audio) c.audio = `[${c.audio.length} chars]`;
                    }
                }
            }
        }
        console.log(JSON.stringify(sanitized, null, 2));
        setTimeout(() => { ws.close(); process.exit(0); }, 500);
    }
});

ws.on('error', (err: any) => {
    console.error('WebSocket error:', err);
    process.exit(1);
});

ws.on('close', () => {
    console.log('Connection closed');
    process.exit(0);
});

// Timeout safety
setTimeout(() => {
    console.log('Timeout - closing');
    ws.close();
    process.exit(1);
}, 30000);
