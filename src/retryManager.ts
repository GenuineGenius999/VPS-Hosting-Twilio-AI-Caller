import twilio from "twilio";

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_AUTH_TOKEN!
);

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10_000;

const retryMap = new Map<string, number>();

export function scheduleRetry(to: string, from: string) {
    const attempts = retryMap.get(to) ?? 0;

    if (attempts >= MAX_RETRIES) {
        console.log("🛑 Max retry reached for", to);
        retryMap.delete(to);
        return;
    }

    retryMap.set(to, attempts + 1);

    console.log(`🔁 Retry ${attempts + 1}/${MAX_RETRIES} → ${to}`);

    setTimeout(async () => {
        try {
            await client.calls.create({
                to,
                from,
                url: `${process.env.PUBLIC_URL}/twiml`,
                statusCallback: `${process.env.PUBLIC_URL}/twilio/status`,
                statusCallbackEvent: ["completed"],
            });
        } catch (err) {
            console.error("❌ Retry failed", err);
        }
    }, RETRY_DELAY_MS);
}

export function clearRetry(to: string) {
    retryMap.delete(to);
}
