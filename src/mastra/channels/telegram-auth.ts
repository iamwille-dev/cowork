import { createHash } from 'node:crypto';

export function telegramBridgeSecret() {
  const explicit = process.env.COWORK_TELEGRAM_BRIDGE_SECRET?.trim();
  if (explicit) return explicit;
  const key = process.env.MASTRA_ENCRYPTION_KEY?.trim();
  if (key && Buffer.byteLength(key) >= 32) {
    return createHash('sha256').update('cowork-telegram-tools\0' + key).digest('hex');
  }
}
