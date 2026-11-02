import { DAY_MS } from './retention';
import type { ExpiryWindow } from './types';

interface ExpirySubject {
  expiry: ExpiryWindow | null;
  trashedAt: number | null;
  deletionPending: boolean;
  path: string;
  kind?: 'folder';
  permanent?: boolean;
  permanentCount?: number;
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
  if (!inTrash && file.permanent) return {
    short: 'Permanent', summary: 'Never expires', urgent: false,
    detail: 'A team member can change expiry or move this item to Trash.',
  };
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
  const folder = !inTrash && file.kind === 'folder';
  const summary = inTrash ? due ? ranged && lastAt > now ? 'Some files are due for deletion' : 'Due for permanent deletion'
    : `Deletes permanently in ${short}` : due ? folder ? 'Timed files are due to move to Trash' : 'Due to move to Trash'
      : `${folder ? 'Timed files move' : 'Moves'} to Trash in ${short}`;
  const dates = ranged ? `${inTrash ? 'Deletion' : 'Expiry'} dates: ${dateFormat.format(firstAt)} to ${dateFormat.format(lastAt)}.`
    : `Eligible from ${dateFormat.format(firstAt)}.`;
  return { short, summary, detail: `${dates} Checked each hour.${!inTrash && file.permanentCount ? ' Permanent files do not expire.' : ''}`, urgent: firstAt - now <= DAY_MS };
}
