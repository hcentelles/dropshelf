import type { RetentionMode } from '../shared/retention';
import type { ExplorerEntry } from '../shared/types';
import { icon } from './api';
import { expiryDisplay, refreshExpiryDisplay } from './expiry';
import { placeMenu } from './interactions';

function button(label: string, symbol: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  const text = document.createElement('span');
  text.textContent = label;
  node.append(icon(symbol), text);
  return node;
}

export function expirationMenu(file: ExplorerEntry, menu: HTMLDetailsElement, main: HTMLElement,
  onSelect: (mode: RetentionMode) => void): HTMLElement {
  const submenu = document.createElement('div');
  submenu.className = 'menu-view expiration-submenu';
  submenu.id = `expiration-${crypto.randomUUID()}`;
  submenu.setAttribute('role', 'group');
  submenu.setAttribute('aria-label', 'Expiration');
  submenu.hidden = true;
  const trigger = button('Expiration', 'clock');
  trigger.className = 'submenu-trigger';
  trigger.append(icon('caret-right'));
  trigger.setAttribute('aria-controls', submenu.id);
  trigger.setAttribute('aria-expanded', 'false');
  main.append(trigger);
  const back = button('Expiration', 'caret-left');
  back.className = 'submenu-back';
  back.setAttribute('aria-label', 'Back to file options');
  const status = expiryDisplay(file, 'menu');
  submenu.append(back, status);
  for (const [mode, label, symbol] of [
    ['30-days', 'Expire in 30 days', 'calendar-plus'], ['permanent', 'Make permanent', 'infinity'],
  ] as const) {
    if (mode === 'permanent' && file.permanent) continue;
    const action = button(label, symbol);
    action.addEventListener('click', () => { menu.open = false; onSelect(mode); });
    submenu.append(action);
  }
  const show = (open: boolean, focus = true) => {
    main.hidden = open;
    submenu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) refreshExpiryDisplay(status);
    if (menu.open) placeMenu(menu);
    if (focus) (open ? back : trigger).focus({ preventScroll: true });
  };
  trigger.addEventListener('click', () => show(true));
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') { event.preventDefault(); show(true); }
  });
  back.addEventListener('click', () => show(false));
  submenu.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      show(false);
    }
  });
  menu.addEventListener('toggle', () => { if (!menu.open) show(false, false); });
  return submenu;
}
