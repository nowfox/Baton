import { createHash } from 'crypto';
import { resolve } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

// Dev-only: read BATON_API_URL from .env.local so /api/* in dev proxies to the real Lambda.
function devApiUrl() {
  try {
    const txt = readFileSync(resolve(__dirname, '.env.local'), 'utf-8');
    const m = txt.match(/^BATON_API_URL=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// The HarmonyOS shell (harmony/.../bridge/WebUpdater.ets) updates its bundled
// frontend from this file list. Bump together with NATIVE_API there when the
// frontend starts relying on native code older shells lack.
const HARMONY_NATIVE_API = 2;
const WEB_MANIFEST = 'web-manifest.json';

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? listFiles(resolve(dir, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]);
}

function webManifest() {
  let outDir = '';
  return {
    name: 'web-manifest',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      if (!existsSync(outDir)) return;
      const files = listFiles(outDir).filter(path => path !== WEB_MANIFEST).sort().map(path => {
        const data = readFileSync(resolve(outDir, path));
        return { path, sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
      });
      const version = createHash('sha256')
        .update(files.map(file => `${file.path}\0${file.sha256}\n`).join(''))
        .digest('hex').slice(0, 16);
      writeFileSync(resolve(outDir, WEB_MANIFEST), JSON.stringify({ version, nativeApi: HARMONY_NATIVE_API, files }));
    },
  };
}

export default defineConfig({
  root: 'web',
  base: './',
  cacheDir: '../node_modules/.vite',
  plugins: [webManifest()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index:   resolve(__dirname, 'web/index.html'),
        landing: resolve(__dirname, 'web/landing.html'),
        setup:   resolve(__dirname, 'web/setup.html'),
        tabs:    resolve(__dirname, 'web/tabs.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: devApiUrl() ? {
      '/api': { target: devApiUrl(), changeOrigin: true, secure: true },
    } : undefined,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: devApiUrl() ? {
      '/api': { target: devApiUrl(), changeOrigin: true, secure: true },
    } : undefined,
  },
});
