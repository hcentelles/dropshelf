import type { SharedFile } from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, public status: number, public conflict?: SharedFile) { super(message); }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; conflict?: SharedFile } | null;
    throw new ApiError(response.status === 401 || response.status === 403
      ? 'Your session has ended. Reload this page to sign in.'
      : body?.error ?? 'The request failed. Try again.', response.status, body?.conflict);
  }
  return response.json() as Promise<T>;
}

export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastRemaining = 0;
let toastStarted = 0;
let toastReady = false;
let toastHovered = false;
let toastReturnFocus: HTMLElement | null = null;

function pauseToast(): void {
  if (!toastTimer) return;
  clearTimeout(toastTimer);
  toastTimer = undefined;
  toastRemaining = Math.max(0, toastRemaining - (Date.now() - toastStarted));
}

function resumeToast(): void {
  const box = element('toast');
  if (box.hidden || document.hidden || toastHovered || box.contains(document.activeElement)) return;
  pauseToast();
  toastStarted = Date.now();
  toastTimer = setTimeout(() => { box.hidden = true; toastTimer = undefined; }, toastRemaining);
}

export function toast(message: string): void {
  const box = element('toast');
  if (!toastReady) {
    element('dismiss-toast').addEventListener('click', () => {
      const restoreFocus = box.contains(document.activeElement);
      pauseToast();
      box.hidden = true;
      if (restoreFocus && toastReturnFocus?.isConnected) toastReturnFocus.focus({ preventScroll: true });
    });
    box.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') { toastHovered = true; pauseToast(); } });
    box.addEventListener('pointerleave', () => { toastHovered = false; resumeToast(); });
    box.addEventListener('focusin', pauseToast);
    box.addEventListener('focusout', () => { setTimeout(resumeToast, 0); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pauseToast(); else resumeToast(); });
    toastReady = true;
  }
  pauseToast();
  if (document.activeElement instanceof HTMLElement && !box.contains(document.activeElement)) toastReturnFocus = document.activeElement;
  element('toast-message').textContent = message;
  box.hidden = false;
  toastRemaining = Math.min(12_000, Math.max(5_000, message.length * 70));
  resumeToast();
}

const copyFeedback = new WeakMap<HTMLButtonElement, { icon: string; timer: ReturnType<typeof setTimeout> }>();
export async function copy(
  text: string, successMessage = 'Link copied.',
  failureMessage = 'Copy failed. Open the link and copy it from the address bar.',
  button?: HTMLButtonElement,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage);
    const glyph = button?.querySelector<HTMLElement>('.ph');
    if (button && glyph) {
      const previous = copyFeedback.get(button);
      clearTimeout(previous?.timer);
      const original = previous?.icon ?? glyph.className;
      glyph.className = 'ph ph-check';
      button.classList.add('is-copied');
      copyFeedback.set(button, { icon: original, timer: setTimeout(() => {
        glyph.className = original;
        button.classList.remove('is-copied');
        copyFeedback.delete(button);
      }, 1800) });
    }
    return true;
  }
  catch { toast(failureMessage); return false; }
}

export function icon(name: string): HTMLElement {
  const node = document.createElement('i');
  node.className = `ph ph-${name}`;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function identityLabel(label: string): string {
  return label.replace(/^([^\s@]+)@[^\s@]+$/, '$1');
}

export function initials(label: string): string {
  const name = label.split('@')[0] ?? label;
  const parts = name.split(/[._\s-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2)).toUpperCase();
}
