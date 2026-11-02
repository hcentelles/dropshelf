import { expect, it } from 'vitest';
import { DAY_MS } from '../shared/retention';
import { expiryText } from '../shared/expiry-format';

const now = Date.UTC(2026, 9, 30, 12);
const active = { path: 'site/page.html', trashedAt: null, deletionPending: false };
const trash = { ...active, trashedAt: now - DAY_MS };
const windowAt = (first: number, last = first) => ({ firstAt: now + first, lastAt: now + last });

it('rounds remaining time up and changes to due at the exact boundary', () => {
  expect(expiryText({ ...active, expiry: windowAt(30 * DAY_MS) }, now).short).toBe('30 days');
  expect(expiryText({ ...active, expiry: windowAt(DAY_MS - 1) }, now).short).toBe('24 hours');
  expect(expiryText({ ...active, expiry: windowAt(60_001) }, now).short).toBe('2 minutes');
  expect(expiryText({ ...active, expiry: windowAt(1) }, now).short).toBe('1 minute');
  expect(expiryText({ ...active, expiry: windowAt(0) }, now)).toMatchObject({ short: 'Due next check', summary: 'Due to move to Trash', urgent: true });
});

it('shows folder deletion ranges and identifies a partly due folder', () => {
  expect(expiryText({ ...trash, kind: 'folder', expiry: windowAt(2 * DAY_MS, 7 * DAY_MS) }, now).short).toBe('2–7 days');
  expect(expiryText({ ...trash, kind: 'folder', expiry: windowAt(2 * 3_600_000, 2 * DAY_MS) }, now).short).toBe('2 hours–2 days');
  expect(expiryText({ ...trash, kind: 'folder', expiry: windowAt(-1, DAY_MS) }, now)).toMatchObject({ short: 'Some files due', urgent: true });
  expect(expiryText({ ...trash, kind: 'folder', expiry: windowAt(-DAY_MS, -1) }, now).short).toBe('Due next check');
});

it('distinguishes a disabled policy from deletion that already started', () => {
  expect(expiryText({ ...active, expiry: null }, now)).toMatchObject({ short: 'Off', summary: 'Automatic expiry is off', urgent: false });
  expect(expiryText({ ...trash, expiry: null }, now).summary).toBe('Automatic deletion is off');
  expect(expiryText({ ...trash, expiry: null, deletionPending: true }, now)).toMatchObject({ short: 'Pending', urgent: true });
  expect(expiryText({ ...trash, kind: 'folder', expiry: windowAt(DAY_MS), deletionPending: true }, now).short).toBe('In progress');
});

it('distinguishes permanent items from a disabled default and explains mixed folder expiry', () => {
  expect(expiryText({ ...active, expiry: null, permanent: true, permanentCount: 1 }, now)).toMatchObject({
    short: 'Permanent', summary: 'Never expires', urgent: false,
  });
  const mixed = expiryText({ ...active, kind: 'folder', expiry: windowAt(30 * DAY_MS), permanent: false, permanentCount: 2 }, now);
  expect(mixed.summary).toBe('Timed files move to Trash in 30 days');
  expect(mixed.detail).toContain('Permanent files do not expire.');
  const ranged = expiryText({ ...active, kind: 'folder', expiry: windowAt(DAY_MS, 30 * DAY_MS) }, now);
  expect(ranged.detail).toContain('Expiry dates:');
  expect(ranged.detail).not.toContain('whole top-level folder');
});
