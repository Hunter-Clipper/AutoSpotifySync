import type { Logger } from './logger.js';

/**
 * POST a message to a webhook. The payload carries the text under the field names that
 * Discord (content), Slack (text) and Gotify (title/message) expect, so one URL works for each.
 * Failures only warn: a broken webhook must never break a sync.
 */
export async function notify(url: string | undefined, title: string, body: string, log: Logger): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message: body, content: `**${title}**\n${body}`, text: `${title}\n${body}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log.warn('Notification endpoint returned an error', { status: res.status });
  } catch (err) {
    log.warn('Notification failed', { error: err });
  }
}
