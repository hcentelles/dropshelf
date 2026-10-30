import { formatSize } from '../shared/formats';
import type { SharedFile } from '../shared/types';
import { element } from './api';
import type { LocalFile } from './uploads';

export type ReplaceChoice = 'replace' | 'skip' | 'cancel';
export type ConfirmReplacement = (incoming: LocalFile, existing: SharedFile, changed: boolean) => Promise<ReplaceChoice>;

export function replacementPrompt(): ConfirmReplacement {
  const dialog = element<HTMLDialogElement>('replace-file-dialog');
  const applyAll = element<HTMLInputElement>('replace-apply-all');
  let remembered: 'replace' | 'skip' | undefined;
  let cancelled = false;
  let queue: Promise<unknown> = Promise.resolve();
  return (incoming, existing, changed) => {
    const prompt = async (): Promise<ReplaceChoice> => {
      if (cancelled) return 'cancel';
      if (remembered && !changed) return remembered;
      element('replace-file-path').textContent = incoming.path;
      element('replace-existing-size').textContent = `${formatSize(existing.size)} · ${new Date(existing.updatedAt).toLocaleString('en')}`;
      element('replace-incoming-size').textContent = formatSize(incoming.file.size);
      element('replace-file-changed').hidden = !changed;
      applyAll.checked = false;
      element('replace-apply-all-label').hidden = changed;
      dialog.returnValue = 'cancel';
      const choice = await new Promise<ReplaceChoice>(resolve => {
        dialog.addEventListener('close', () => {
          resolve(dialog.returnValue === 'replace' ? 'replace' : dialog.returnValue === 'skip' ? 'skip' : 'cancel');
        }, { once: true });
        dialog.showModal();
      });
      if (choice === 'cancel') cancelled = true;
      else if (applyAll.checked && !changed) remembered = choice;
      return choice;
    };
    const next = queue.then(prompt);
    queue = next;
    return next;
  };
}
