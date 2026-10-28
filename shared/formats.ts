const formats: Record<string, string> = {
  html: 'text/html', htm: 'text/html',
  md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv',
  txt: 'text/plain', json: 'application/json', css: 'text/css', js: 'text/javascript',
  mjs: 'text/javascript', pdf: 'application/pdf', xml: 'application/xml',
  png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', cur: 'image/x-icon',
  bmp: 'image/bmp', dib: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', heif: 'image/heif', hif: 'image/heif', jxl: 'image/jxl',
  jp2: 'image/jp2', j2k: 'image/jp2', jpx: 'image/jpx', jpm: 'image/jpm',
  psd: 'image/vnd.adobe.photoshop', psb: 'image/vnd.adobe.photoshop',
  dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3',
  nef: 'image/x-nikon-nef', arw: 'image/x-sony-arw', raf: 'image/x-fuji-raf',
  orf: 'image/x-olympus-orf', rw2: 'image/x-panasonic-rw2',
  ppm: 'image/x-portable-pixmap', pgm: 'image/x-portable-graymap',
  pbm: 'image/x-portable-bitmap', pnm: 'image/x-portable-anymap',
  xbm: 'image/x-xbitmap', xpm: 'image/x-xpixmap', exr: 'image/aces', hdr: 'image/vnd.radiance',
};

export function fileType(path: string, declaredType = ''): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const known = formats[extension];
  if (known) return known;
  // Unknown image formats remain downloadable on the separate content origin.
  const mime = declaredType.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime) ? mime : 'application/octet-stream';
}

export const DEFAULT_ALLOWED_FILE_TYPES = 'image/*,.html,.htm,.md,.markdown,.csv';

export function parseAllowedFileTypes(value: string): string[] {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('The file type setting is not valid.');
  const entries = [...new Set(value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
  if (!entries.length || entries.some(item => !/^(?:\.[a-z0-9][a-z0-9.+_-]*|[a-z0-9][a-z0-9.+-]*\/(?:\*|[a-z0-9][a-z0-9.+-]*))$/.test(item))) {
    throw new Error('Use a comma-separated list of file extensions or MIME types.');
  }
  return entries;
}

export function acceptFile(path: string, declaredType: string, allowed: string[]): string | null {
  const type = fileType(path, declaredType);
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  return allowed.some(pattern => pattern.startsWith('.') ? name.endsWith(pattern)
    : pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern) ? type : null;
}

export function describeAllowedTypes(allowed: string[]): string {
  const names: Record<string, string> = {
    'image/*': 'Images', '.html': 'HTML', '.htm': 'HTML', 'text/html': 'HTML',
    '.md': 'Markdown', '.markdown': 'Markdown', 'text/markdown': 'Markdown',
    '.csv': 'CSV', 'text/csv': 'CSV',
  };
  const labels = [...new Set(allowed.map(pattern => names[pattern] ?? pattern))];
  return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(labels);
}

export function canPreview(type: string): boolean {
  return ['image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp',
    'image/avif', 'image/svg+xml', 'image/bmp', 'image/vnd.microsoft.icon'].includes(type);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
