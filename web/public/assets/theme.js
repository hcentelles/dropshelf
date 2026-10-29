// This classic script runs in the head, before the page can paint.
(() => {
  const storageKey = 'dropshelf-theme';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';

  function applyTheme(value) {
    preference = value === 'light' || value === 'dark' ? value : 'system';
    document.documentElement.dataset.theme = preference;
    const dark = preference === 'dark' || (preference === 'system' && systemTheme.matches);
    document.querySelector('meta[name="color-scheme"]').content = preference === 'system' ? 'light dark' : preference;
    document.querySelector('meta[name="theme-color"]').content = dark ? '#11151c' : '#ffffff';
    for (const option of document.querySelectorAll('input[name="theme"]')) {
      option.checked = option.value === preference;
    }
  }

  try { preference = localStorage.getItem(storageKey) || 'system'; }
  catch { /* System is the default when storage is unavailable. */ }
  applyTheme(preference);

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(preference);
    document.getElementById('theme-options').addEventListener('change', event => {
      const option = event.target;
      if (!(option instanceof HTMLInputElement) || option.name !== 'theme') return;
      applyTheme(option.value);
      try { localStorage.setItem(storageKey, preference); }
      catch { /* Keep the selection for this page when storage is unavailable. */ }
    });
  });

  systemTheme.addEventListener('change', () => { applyTheme(preference); });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue);
  });
})();
