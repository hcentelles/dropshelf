import { element } from './api';
import { currentSection } from './navigation';

const menuSelector = '.account-menu, .file-menu';

function openMenus(): HTMLDetailsElement[] {
  return [...document.querySelectorAll<HTMLDetailsElement>('.account-menu[open], .file-menu[open]')];
}

function placeMenu(menu: HTMLDetailsElement): void {
  const panel = menu.querySelector<HTMLElement>('.menu-panel');
  const trigger = menu.querySelector('summary');
  if (!panel || !trigger) return;
  delete menu.dataset.side;
  delete menu.dataset.align;
  const bounds = panel.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  if (bounds.bottom > window.innerHeight - 12 && anchor.top > bounds.height + 12) menu.dataset.side = 'above';
  if (bounds.left < 12) menu.dataset.align = 'start';
}

export function initInteractions(): void {
  document.querySelector<HTMLAnchorElement>('.skip-link')?.addEventListener('click', event => {
    event.preventDefault();
    element('main-content').focus();
  });
  document.addEventListener('pointerdown', () => { document.documentElement.dataset.input = 'pointer'; }, { passive: true });
  document.addEventListener('keydown', event => {
    document.documentElement.dataset.input = 'keyboard';
    if (event.key === 'Escape') {
      const menus = openMenus();
      const activeMenu = menus.find(menu => event.target instanceof Node && menu.contains(event.target));
      for (const menu of menus) menu.open = false;
      if (activeMenu) {
        activeMenu.querySelector<HTMLElement>('summary')?.focus();
        event.preventDefault();
      }
    }
    const target = event.target;
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey &&
      !document.querySelector('dialog[open]') && target instanceof HTMLElement &&
      !target.closest('input, textarea, select, [contenteditable]') && currentSection() !== 'mcp') {
      event.preventDefault();
      element<HTMLInputElement>(currentSection() === 'trash' ? 'trash-search' : 'search').focus();
    }
  });
  document.addEventListener('toggle', event => {
    const menu = event.target;
    if (!(menu instanceof HTMLDetailsElement) || !menu.matches(menuSelector) || !menu.open) return;
    for (const other of openMenus()) if (other !== menu) other.open = false;
    placeMenu(menu);
  }, true);
  for (const type of ['click', 'focusin']) {
    document.addEventListener(type, event => {
      for (const menu of openMenus()) {
        if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
      }
    });
  }
  window.addEventListener('resize', () => { for (const menu of openMenus()) menu.open = false; });
}
