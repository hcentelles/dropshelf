export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(response.status === 401 || response.status === 403
      ? 'Your session has ended. Reload this page to sign in.'
      : body?.error ?? 'The request failed. Try again.', response.status);
  }
  return response.json() as Promise<T>;
}

export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

let toastTimer: ReturnType<typeof setTimeout>;
export function toast(message: string): void {
  const box = element('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2800);
}

export async function copy(
  text: string, successMessage = 'Link copied.',
  failureMessage = 'Copy failed. Open the link and copy it from the address bar.',
): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); toast(successMessage); return true; }
  catch { toast(failureMessage); return false; }
}

export function icon(name: string): HTMLElement {
  const node = document.createElement('i');
  node.className = `ph ph-${name}`;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function initials(label: string): string {
  const name = label.split('@')[0] ?? label;
  const parts = name.split(/[._\s-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2)).toUpperCase();
}
