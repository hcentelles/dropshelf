import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { submitFeedback } from '../worker/feedback';

const configured = { ...env, SLACK_CHANNEL_ID: 'C111', SLACK_BOT_TOKEN: 'test-only' };
const report = {
  summary: 'Report <!channel> as plain text',
  details: 'The tool returned an empty list when a sample file matched.',
  stepsToReproduce: 'Search for the sample file.',
  proposedFix: 'Include matches on the next page.',
};

afterEach(() => vi.unstubAllGlobals());

it('sends one plain-text Slack message to the channel for each instance and returns a receipt', async () => {
  const slack = vi.fn(async (_request: Request) =>
    Response.json({ ok: true, ts: '1780000000.000001', message: { private: 'not part of the receipt' } }));
  vi.stubGlobal('fetch', slack);
  for (const channel of ['C111', 'C222']) {
    expect(await submitFeedback({ ...configured, SLACK_CHANNEL_ID: channel }, report))
      .toEqual({ submitted: true, messageTs: '1780000000.000001' });
    const [request] = slack.mock.lastCall!;
    expect(request.url).toBe('https://slack.com/api/chat.postMessage');
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('Authorization')).toBe('Bearer test-only');
    const sent = await request.json();
    expect(sent).toEqual({
      channel, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
      text: ['Drop Shelf MCP feedback', 'Report &lt;!channel&gt; as plain text', `Issue\n${report.details}`,
        `Steps to reproduce\n${report.stepsToReproduce}`, `Proposed fix\n${report.proposedFix}`].join('\n\n'),
    });
  }
  expect(slack).toHaveBeenCalledTimes(2);
});

it.each([
  [undefined, undefined, 'SLACK_BOT_TOKEN is missing. SLACK_CHANNEL_ID is missing.'],
  [undefined, 'C111', 'SLACK_BOT_TOKEN is missing.'],
  ['test-only', undefined, 'SLACK_CHANNEL_ID is missing.'],
  ['', 'C111', 'SLACK_BOT_TOKEN is empty.'],
  ['test-only', '  \t ', 'SLACK_CHANNEL_ID is empty.'],
  [' \t', '', 'SLACK_BOT_TOKEN is empty. SLACK_CHANNEL_ID is empty.'],
  [undefined, '', 'SLACK_BOT_TOKEN is missing. SLACK_CHANNEL_ID is empty.'],
] as const)('explains the configuration error without contacting Slack (%s, %s)', async (token, channel, issues) => {
  const slack = vi.fn();
  vi.stubGlobal('fetch', slack);
  await expect(submitFeedback({ ...env, SLACK_BOT_TOKEN: token, SLACK_CHANNEL_ID: channel }, report)).rejects.toMatchObject({
    status: 503,
    message: `Slack feedback is unavailable. ${issues} Set a non-empty value for each listed secret on this instance's Cloudflare app Worker.`,
  });
  expect(slack).not.toHaveBeenCalled();
});

it('rejects private file links before contacting Slack', async () => {
  const slack = vi.fn();
  vi.stubGlobal('fetch', slack);
  for (const url of ['https://example.test/transfer/a.b.c', 'https://files.oaiusercontent.com/sample']) {
    await expect(submitFeedback(configured, { ...report, details: url })).rejects.toMatchObject({ status: 400 });
  }
  expect(slack).not.toHaveBeenCalled();
});

it('reports rejection, rate limits, and unconfirmed delivery without retrying a post', async () => {
  const slack = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: false, error: 'not_in_channel' }))
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '12' } }))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.test' } }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response('invalid JSON'))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockRejectedValueOnce(new Error('private network details'));
  vi.stubGlobal('fetch', slack);
  await expect(submitFeedback(configured, report)).rejects.toMatchObject({ status: 502, details: { slackError: 'not_in_channel' } });
  await expect(submitFeedback(configured, report)).rejects.toMatchObject({ status: 429, details: { retryAfterSeconds: 12 } });
  await expect(submitFeedback(configured, report)).rejects.toMatchObject({ status: 502, details: { slackStatus: 302 } });
  for (let attempt = 0; attempt < 4; attempt++) {
    await expect(submitFeedback(configured, report)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Check the feedback channel') });
  }
  expect(slack).toHaveBeenCalledTimes(7);
});
