import { element } from './api';

export type Section = 'files' | 'trash' | 'mcp';

export function currentSection(): Section {
  return window.location.hash === '#mcp' ? 'mcp' : window.location.hash === '#trash' ? 'trash' : 'files';
}

export function initNavigation(onSection: (section: Section) => void): void {
  const sections = {
    files: { view: element('files-view'), heading: element('files-page-heading') },
    trash: { view: element('trash-view'), heading: element('trash-heading') },
    mcp: { view: element('mcp-view'), heading: element('mcp-heading') },
  };
  const scroll = { files: 0, trash: 0, mcp: 0 };
  let previous = currentSection();

  function show(focus: boolean): void {
    const section = currentSection();
    if (focus) scroll[previous] = window.scrollY;
    for (const [name, nodes] of Object.entries(sections)) nodes.view.hidden = name !== section;
    for (const menu of document.querySelectorAll<HTMLDetailsElement>('.account-menu[open]')) menu.open = false;
    if (focus) {
      sections[section].heading.focus({ preventScroll: true });
      window.scrollTo(0, section === previous ? 0 : scroll[section]);
    }
    previous = section;
    onSection(section);
  }

  window.addEventListener('hashchange', () => { show(true); });
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-section]')) {
    link.addEventListener('click', () => { if (link.dataset.section === currentSection()) show(true); });
  }
  show(false);
}
