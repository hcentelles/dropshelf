import { z } from 'zod';
import { HttpError } from './http';

interface FeedbackEnv extends Env {
  SLACK_BOT_TOKEN?: string;
  SLACK_CHANNEL_ID?: string;
}

export const feedbackSchema = z.strictObject({
  summary: z.string().trim().min(1).max(150).describe('A short title for the Drop Shelf issue or suggestion.'),
  details: z.string().trim().min(1).max(2000).describe('Name the affected tool and describe the observed and expected results.'),
  stepsToReproduce: z.string().trim().min(1).max(1500).optional().describe('Steps to repeat the issue with sample data.'),
  proposedFix: z.string().trim().min(1).max(1500).describe('A specific change that would address the issue.'),
});

export async function submitFeedback(env: FeedbackEnv, report: z.infer<typeof feedbackSchema>) {
  const token = env.SLACK_BOT_TOKEN?.trim();
  const channel = env.SLACK_CHANNEL_ID?.trim();
  if (!token || !channel) {
    const issues = [];
    for (const [name, value] of Object.entries({ SLACK_BOT_TOKEN: token, SLACK_CHANNEL_ID: channel })) {
      if (!value) issues.push(`${name} is ${value === undefined ? 'missing' : 'empty'}.`);
    }
    throw new HttpError(503, `Slack feedback is unavailable. ${issues.join(' ')} Set a non-empty value for each listed secret on this instance's Cloudflare app Worker.`);
  }

  // The shelf's signed transfer links and client file references grant access to private files.
  if (Object.values(report).some(value => /\/transfer\/[\w-]+\.[\w-]+\.[\w-]+|https:\/\/files\.oaiusercontent\.com\//i.test(value))) {
    throw new HttpError(400, 'Remove private file links from the report before sending it.');
  }

  const text = [
    'Drop Shelf MCP feedback',
    report.summary,
    `Issue\n${report.details}`,
    ...(report.stepsToReproduce ? [`Steps to reproduce\n${report.stepsToReproduce}`] : []),
    `Proposed fix\n${report.proposedFix}`,
  ].join('\n\n');
  const message = {
    channel, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
    text: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  };
  const unconfirmed = 'Slack did not confirm delivery. Check the feedback channel before sending this report again.';
  let response: Response;
  try {
    const request = new Request('https://slack.com/api/chat.postMessage', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(message),
    });
    response = await fetch(request);
  } catch {
    throw new HttpError(502, unconfirmed);
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'));
    throw new HttpError(429, 'Slack has limited the number of messages. Try again later.',
      Number.isSafeInteger(seconds) && seconds > 0 ? { retryAfterSeconds: seconds } : undefined);
  }
  if (!response.ok) throw new HttpError(502, unconfirmed, { slackStatus: response.status });
  const receipt = await response.json<{ ok?: boolean; ts?: string; error?: string }>().catch(() => null);
  if (receipt?.ok === false) {
    const slackError = receipt.error;
    throw new HttpError(502, 'Slack rejected the report. Check the bot token, its chat:write permission, and its access to the feedback channel.',
      typeof slackError === 'string' && /^[a-z_]{1,64}$/.test(slackError) ? { slackError } : undefined);
  }
  if (receipt?.ok !== true || typeof receipt.ts !== 'string' || !receipt.ts) throw new HttpError(502, unconfirmed);
  return { submitted: true, messageTs: receipt.ts };
}
