export interface SendEmail {
    send(message: {
        from: string;
        to: string;
        subject: string;
        text?: string;
        html?: string;
    }): Promise<{ messageId: string }>;
}

export class ResendEmailAdapter implements SendEmail {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async send(message: {
        from: string;
        to: string;
        subject: string;
        text?: string;
        html?: string;
    }): Promise<{ messageId: string }> {
        if (!this.apiKey) {
            throw new Error('[ResendEmailAdapter] RESEND_API_KEY is missing');
        }

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                from: message.from,
                to: message.to,
                subject: message.subject,
                text: message.text,
                html: message.html
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`[ResendEmailAdapter] Failed to send email: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data: any = await response.json();
        return { messageId: data.id };
    }
}
