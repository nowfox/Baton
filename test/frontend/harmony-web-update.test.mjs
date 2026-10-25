import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { installHarmonyBridges } from '../../web/js/harmony-bridge.js';
import { startHarmonyWebUpdate } from '../../web/js/harmony-web-update.js';

const updaterSource = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/WebUpdater.ets', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8');

function facade(calls) {
  const record = name => args => calls.push(args === undefined ? [name] : [name, args]);
  return {
    scan: record('scan'), download: record('download'), openExternal: record('openExternal'),
    previewStart() {}, previewStop() {}, previewReset() {}, previewWrite() {},
    previewShutdownWrite() {}, previewCredit() {}, previewCloseSocket() {},
    webReady: record('webReady'), webUpdateCheck: record('webUpdateCheck'),
  };
}

function shell({ server } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://local.test/index.html' });
  const calls = [];
  const host = dom.window;
  host.harmonyBridge = facade(calls);
  if (server) host.localStorage.setItem('_as', server);
  installHarmonyBridges(host);
  return { host, calls };
}

test('a booted page reports ready, then asks the shell to check the signed-in server', () => {
  const { host, calls } = shell({ server: 'https://example.cloudfront.net' });

  assert.equal(startHarmonyWebUpdate(host), true);
  assert.deepEqual(calls[0], ['webReady']);
  assert.deepEqual(calls[1][0], 'webUpdateCheck');
  assert.deepEqual(JSON.parse(calls[1][1]), { server: 'https://example.cloudfront.net' });
});

test('before sign-in the page still reports ready but has no server to check', () => {
  const { host, calls } = shell();

  startHarmonyWebUpdate(host);
  assert.deepEqual(calls, [['webReady']]);
});

test('browsers, Tauri and shells without the updater are untouched', () => {
  assert.equal(startHarmonyWebUpdate({}), false);

  const host = { harmonyBridge: { ...facade([]), webReady: undefined } };
  installHarmonyBridges(host);
  assert.equal(host.harmonyWebUpdate, undefined);
  assert.equal(startHarmonyWebUpdate(host), false);
});

test('the shell and the build agree on the native API level', () => {
  const shellLevel = updaterSource.match(/export const NATIVE_API: number = (\d+);/)[1];
  const buildLevel = viteConfig.match(/const HARMONY_NATIVE_API = (\d+);/)[1];
  assert.equal(shellLevel, buildLevel);
});

test('the build publishes a manifest whose hashes and version match the output', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'baton-web-manifest-'));
  try {
    await build({ configFile: new URL('../../vite.config.js', import.meta.url).pathname, logLevel: 'silent', build: { outDir } });
    const manifest = JSON.parse(readFileSync(join(outDir, 'web-manifest.json'), 'utf8'));
    const paths = manifest.files.map(file => file.path);

    assert.match(manifest.version, /^[0-9a-f]{16}$/);
    assert.ok(paths.includes('landing.html') && paths.includes('index.html'));
    assert.ok(!paths.includes('web-manifest.json'));
    assert.deepEqual(paths, paths.slice().sort());
    for (const file of manifest.files) {
      // WebUpdater.ets rejects any path outside this alphabet.
      assert.match(file.path, /^[A-Za-z0-9._@~+-]+(\/[A-Za-z0-9._@~+-]+)*$/);
      const data = readFileSync(join(outDir, file.path));
      assert.equal(file.size, data.length);
      assert.equal(file.sha256, createHash('sha256').update(data).digest('hex'));
    }
    const version = createHash('sha256')
      .update(manifest.files.map(file => `${file.path}\0${file.sha256}\n`).join(''))
      .digest('hex').slice(0, 16);
    assert.equal(manifest.version, version);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('the shell serves only verified, atomically installed bundles', () => {
  const index = readFileSync(new URL('../../harmony/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');

  assert.match(index, /this\.nativeBridge\.web\.read\(path\)/);
  assert.doesNotMatch(index, /getRawFileContentSync/);
  // Every downloaded file is checked against its manifest hash.
  assert.match(updaterSource, /sha256Hex\(data\) !== file\.sha256\) \{\s*throw/);
  // A version is assembled in a temp dir and renamed into place.
  assert.match(updaterSource, /fs\.renameSync\(temp, target\)/);
  // Paths from the manifest or the request never escape the bundle directory.
  assert.match(updaterSource, /segment === '\.\.'/);
  assert.match(updaterSource, /if \(!safePath\(path\)\)/);
  // A newer native requirement keeps the current bundle.
  assert.match(updaterSource, /manifest\.nativeApi > NATIVE_API/);
  // A found version waits for the next cold start; nothing reloads a running page.
  assert.doesNotMatch(updaterSource, /\n  apply\(\)/);
  assert.match(updaterSource, /if \(this\.checked \|\| this\.state\.ready\.length > 0\)/);
  // A new app package resets the downloads so its own rawfile is served.
  assert.match(updaterSource, /this\.state\.builtin !== builtinVersion/);
});
