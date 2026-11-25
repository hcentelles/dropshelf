import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const browserLicenses = [
  ['Drop Shelf\nCopyright 2026 the Drop Shelf contributors.', './LICENSE'],
  ['Inter', './node_modules/@fontsource-variable/inter/LICENSE'],
  ['Phosphor Icons', './node_modules/@phosphor-icons/web/LICENSE'],
  ['Vite module preload helper', './node_modules/vite/LICENSE.md'],
] as const;

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  plugins: [{
    name: 'browser-license-notices',
    generateBundle() {
      const notices = browserLicenses.map(([name, path]) => {
        const license = readFileSync(new URL(path, import.meta.url), 'utf8');
        return `${name}\n\n${license}`;
      });
      this.emitFile({ type: 'asset', fileName: 'assets/licenses.txt', source: notices.join('\n\n') });
    },
  }],
});
