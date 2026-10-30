import { DAY_MS } from './retention';
import type { ExpiryWindow } from './types';

interface ExpirySubject {
  expiry: ExpiryWindow | null;
  trashedAt: number | null;
  deletionPending: boolean;
  path: string;
  kind?: 'folder';
}

function duration(milliseconds: number) {
  const unit = milliseconds >= DAY_MS ? 'day' : milliseconds >= 3_600_000 ? 'hour' : 'minute';
  const count = Math.max(1, Math.ceil(milliseconds / (unit === 'day' ? DAY_MS : unit === 'hour' ? 3_600_000 : 60_000)));
  return { count, unit, label: `${count} ${unit}${count === 1 ? '' : 's'}` };
}

const dateFormat = new Intl.DateTimeFormat('en', {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

export function expiryText(file: ExpirySubject, now = Date.now()) {
  const inTrash = file.trashedAt !== null;
  if (file.deletionPending) return {
    short: file.kind === 'folder' ? 'In progress' : 'Pending', summary: 'Permanent deletion has started', urgent: true,
    detail: file.kind === 'folder' ? 'Open the folder to see the status of each file.'
      : 'The server will finish or retry deletion. This file cannot be restored.',
  };
  if (file.expiry === undefined) return { short: 'Unavailable', summary: 'Expiry date is unavailable', detail: 'Reload the list to try again.', urgent: false };
  if (file.expiry === null) return {
    short: 'Off', summary: inTrash ? 'Automatic deletion is off' : 'Automatic expiry is off', urgent: false,
    detail: inTrash ? 'A team member can restore or permanently delete this item.' : 'A team member can move this item to Trash.',
  };
  const { firstAt, lastAt } = file.expiry;
  const ranged = firstAt !== lastAt;
  const due = firstAt <= now;
  let short: string;
  if (due) short = ranged && lastAt > now ? 'Some files due' : 'Due next check';
  else {
    const first = duration(firstAt - now);
    const last = duration(lastAt - now);
    short = first.label === last.label ? first.label : first.unit === last.unit
      ? `${first.count}–${last.count} ${last.unit}s` : `${first.label}–${last.label}`;
  }
  const summary = inTrash ? due ? ranged && lastAt > now ? 'Some files are due for deletion' : 'Due for permanent deletion'
    : `Deletes permanently in ${short}` : due ? 'Due to move to Trash' : `Moves to Trash in ${short}`;
  const dates = ranged ? `Deletion dates: ${dateFormat.format(firstAt)} to ${dateFormat.format(lastAt)}.`
    : `Eligible from ${dateFormat.format(firstAt)}.`;
  const group = !inTrash && (file.kind === 'folder' || file.path.includes('/'))
    ? ' Uses the date for the whole top-level folder.' : '';
  return { short, summary, detail: `${dates} Checked each hour.${group}`, urgent: firstAt - now <= DAY_MS };
}
