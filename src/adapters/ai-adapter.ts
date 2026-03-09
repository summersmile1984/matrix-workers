// LLM Adapter for unified LLM gateway (or any OpenAI-compatible endpoint)
// Implements a subset of the Cloudflare Workers AI interface

export class LLMAdapter {
    private apiKey: string;
    private baseUrl: string;

    constructor(apiKey: string, baseUrl: string) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    }

    async run(_model: string, inputs: any): Promise<any> {
        // Map CF Workers AI models to Chutes models where possible
        // Let's assume most requests are text generation (messages/prompt) or embeddings

        let endpoint = `${this.baseUrl}/v1/chat/completions`;
        let payload: any = {};

        // Force the use of the user's preferred model or fallback to provided model
        const targetModel = process.env.LLM_MODEL || 'kimi-k2.5';

        // Heuristics to determine if this is an embedding request or a chat completion request
        if (typeof inputs.text === 'string' || Array.isArray(inputs.text)) {
            // Text Embeddings (CF: @cf/baai/bge-large-en-v1.5)
            endpoint = `${this.baseUrl}/v1/embeddings`;
            payload = {
                model: targetModel, // Chutes Embedding model if available, else standard fallback
                input: inputs.text
            };
        } else if (inputs.messages && Array.isArray(inputs.messages)) {
            // Chat Completions (CF: @cf/meta/llama-3-8b-instruct)
            // Convert CF roles to specific roles
            payload = {
                model: targetModel,
                messages: inputs.messages.map((m: any) => ({
                    role: m.role || 'user',
                    content: m.content
                }))
            };
        } else if (inputs.prompt) {
            // Basic completions
            payload = {
                model: targetModel,
                messages: [{ role: 'user', content: inputs.prompt }]
            };
        } else {
            throw new Error(`[ChutesAIAdapter] Unsupported AI input format: ${JSON.stringify(inputs)}`);
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`[ChutesAIAdapter] AI request failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data: any = await response.json();

        // Map OpenAI-like response format back to CF Workers AI expected format
        if (endpoint.endsWith('/embeddings')) {
            return {
                shape: [data.data.length, data.data[0].embedding.length],
                data: data.data.map((d: any) => d.embedding)
            };
        } else if (endpoint.endsWith('/chat/completions')) {
            return {
                response: data.choices[0].message.content
            };
        }

        return data;
    }
}
