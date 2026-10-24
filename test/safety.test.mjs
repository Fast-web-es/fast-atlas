// Safety tests for Fast Atlas.
// They build a fake home folder full of dangerous cases, start the real server against it in test mode
// and check that only what should go, goes. Nothing on the machine running the tests is touched:
// test mode never uses the real Trash, Finder or notifications.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-atlas-test-'));
const HOME = path.join(TMP, 'home');
const DATA = path.join(TMP, 'data');
const OUT = path.join(TMP, 'outside');
const BIN = path.join(TMP, 'bin');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const H = (...p) => path.join(HOME, ...p);
let server, token;

function file(p, bytes = 2000) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes, 7)); }
function project(dir, lock, { nm = true, next = false } = {}) {
  file(path.join(dir, 'package.json'), 20);
  if (lock) file(path.join(dir, lock), 20);
  file(path.join(dir, 'src', 'index.js'), 50);
  if (nm) file(path.join(dir, 'node_modules', 'lib', 'index.js'), 40000);
  if (next) file(path.join(dir, '.next', 'cache', 'webpack.pack'), 30000);
}
function makeOld(p) {
  const t = new Date(Date.now() - 120 * 86400e3);
  const walk = (q) => {
    const st = fs.lstatSync(q);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const n of fs.readdirSync(q)) walk(path.join(q, n));
    fs.lutimesSync(q, t, t);
  };
  walk(p);
}
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

async function api(ruta, body) {
  const opts = { headers: { 'X-Fast-Atlas-Token': token } };
  if (body !== undefined) Object.assign(opts, { method: 'POST', body: JSON.stringify(body), headers: { ...opts.headers, 'Content-Type': 'application/json' } });
  const r = await fetch(`http://127.0.0.1:${PORT}${ruta}`, opts);
  return { status: r.status, json: await r.json().catch(() => null) };
}
const trash = (ruta) => api('/api/accion', { tipo: 'papelera', ruta });
function rawRequest({ host, method = 'GET', ruta = '/', headers = {}, body }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: ruta, headers: { Host: host, ...headers } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  // Your projects
  project(H('Documents', 'repos', 'old-app'), 'package-lock.json', { next: true }); makeOld(H('Documents', 'repos', 'old-app'));
  project(H('Documents', 'repos', 'new-app'), 'pnpm-lock.yaml', { next: true });
  project(H('Documents', 'repos', 'no-lock-app'), null); makeOld(H('Documents', 'repos', 'no-lock-app'));
  project(H('Documents', 'repos', 'running-app'), 'package-lock.json', { next: true }); makeOld(H('Documents', 'repos', 'running-app'));
  project(H('Documents', 'tools', 'mcp-tool'), 'package-lock.json', { next: true }); makeOld(H('Documents', 'tools', 'mcp-tool'));
  // Workspaces and pnpm put links inside node_modules: deleting must never follow them
  project(H('Documents', 'repos', 'workspace-app'), 'package-lock.json');
  file(H('Documents', 'repos', 'shared-code', 'keep.js'), 50);
  file(path.join(OUT, 'store', 'keep.js'), 50);
  fs.symlinkSync(H('Documents', 'repos', 'shared-code'), H('Documents', 'repos', 'workspace-app', 'node_modules', 'local-pkg'));
  fs.symlinkSync(path.join(OUT, 'store'), H('Documents', 'repos', 'workspace-app', 'node_modules', 'store-pkg'));
  makeOld(H('Documents', 'repos', 'workspace-app'));
  // node_modules that is itself a link to somewhere else
  project(H('Documents', 'repos', 'linked-nm'), 'package-lock.json', { nm: false });
  file(path.join(OUT, 'linked-target', 'keep.js'), 50);
  fs.symlinkSync(path.join(OUT, 'linked-target'), H('Documents', 'repos', 'linked-nm', 'node_modules'));
  makeOld(H('Documents', 'repos', 'linked-nm'));
  // Claude uses mcp-tool as an MCP server; its config also holds a fake secret
  file(H('Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 0);
  fs.writeFileSync(H('Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { tool: { command: 'node', args: [H('Documents', 'tools', 'mcp-tool', 'dist', 'index.js')], env: { API_KEY: '/sk-fake-secret/123' } } } }));
  // Things that must never be deleted from the panel
  file(H('.ssh', 'id_test'), 100);
  file(H('Library', 'Application Support', 'SomeApp', 'data.db'), 1000);
  file(H('Library', 'Caches', 'com.apple.Safari', 'cache.db'), 1000);
  file(H('Library', 'Preferences', 'com.example.plist'), 100);
  file(H('Movies', 'Lib.imovielibrary', 'Media', 'clip.mov'), 1000);
  file(H('top-level-file.zip'), 1000);
  file(path.join(OUT, 'sentinel.txt'), 100);
  // Things that can go to the Trash
  file(H('Downloads', 'installer.dmg'), 5000);
  file(H('Library', 'Caches', 'com.example.app', 'cache.bin'), 5000);
  file(H('.cache', 'huggingface', 'model.bin'), 5000);
  file(H('Movies', 'Old.imovielibrary', 'Media', 'clip.mov'), 1000);
  // Cowork disk
  const bundle = H('Library', 'Application Support', 'Claude', 'vm_bundles', 'claudevm.bundle');
  file(path.join(bundle, 'rootfs.img'), 50000); file(path.join(bundle, 'rootfs.img.zst'), 5000); file(path.join(bundle, 'sessiondata.img'), 5000);
  // npm cache
  file(H('.npm', '_cacache', 'content-v2', 'x'), 20000);
  // A fake lsof: "node" is running inside running-app, and nobody holds the Cowork disk
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'lsof'), `#!/bin/sh\nif [ "$1" = "-d" ]; then printf 'p101\\ncnode\\nfcwd\\nn${H('Documents', 'repos', 'running-app')}\\np102\\nc-zsh\\nfcwd\\nn${H('Documents', 'repos', 'new-app')}\\n'; exit 0; fi\nexit 1\n`);
  fs.chmodSync(path.join(BIN, 'lsof'), 0o755);

  server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.mjs')], {
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FAST_ATLAS_TEST: '1', FAST_ATLAS_HOME: HOME, FAST_ATLAS_DATA: DATA, FAST_ATLAS_PORT: String(PORT), npm_config_cache: H('.npm') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text(); token = html.match(/name="fast-atlas-token" content="([a-f0-9]+)"/)[1]; break; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  assert.ok(token, 'server started');
  await api('/api/accion', { tipo: 'escanear' });
  for (let i = 0; i < 300; i++) {
    const { json } = await api('/api/estado');
    if (json && json.tCompleto && !json.escaneo.enCurso) break;
    await new Promise(r => setTimeout(r, 200));
  }
});

after(() => {
  if (server) server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('nothing is deleted automatically by default', () => {
  const config = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
  assert.equal(config.limpiezaAuto, false);
});

test('refuses requests without the token, from other websites or other hosts', async () => {
  const sinToken = await fetch(`http://127.0.0.1:${PORT}/api/accion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: 'npm' }) });
  assert.equal(sinToken.status, 403);
  const otraWeb = await fetch(`http://127.0.0.1:${PORT}/api/accion`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fast-Atlas-Token': token, Origin: 'https://evil.example' }, body: JSON.stringify({ tipo: 'npm' }) });
  assert.equal(otraWeb.status, 403);
  assert.equal(await rawRequest({ host: `evil.example:${PORT}` }), 403);
});

test('never moves protected things to the Trash', async () => {
  const blocked = [
    H('Documents'), H('Library'), H('top-level-file.zip'), H('.ssh'), H('.ssh', 'id_test'),
    H('Library', 'Application Support', 'SomeApp'), H('Library', 'Preferences', 'com.example.plist'),
    H('Library', 'Caches', 'com.apple.Safari'), H('Movies', 'Lib.imovielibrary', 'Media', 'clip.mov'),
    H('Documents', 'repos', 'new-app', 'node_modules'), H('Documents', 'tools', 'mcp-tool'), H('Documents', 'tools'),
    H('Documents', 'repos', 'running-app'), path.join(OUT, 'sentinel.txt'), '/etc/hosts', HOME, `${HOME}/Downloads/../.ssh/id_test`, '', '/',
  ];
  for (const p of blocked) {
    const { json } = await trash(p);
    assert.equal(json.ok, false, `should refuse: ${p}`);
  }
  for (const p of [H('Documents'), H('.ssh', 'id_test'), H('Library', 'Application Support', 'SomeApp', 'data.db'), H('Library', 'Caches', 'com.apple.Safari', 'cache.db'), H('Movies', 'Lib.imovielibrary', 'Media', 'clip.mov'), H('top-level-file.zip'), path.join(OUT, 'sentinel.txt')]) {
    assert.ok(exists(p), `still there: ${p}`);
  }
});

test('moves your own files to the Trash, where they can be recovered', async () => {
  for (const p of [H('Downloads', 'installer.dmg'), H('Library', 'Caches', 'com.example.app'), H('.cache', 'huggingface'), H('Movies', 'Old.imovielibrary')]) {
    const { json } = await trash(p);
    assert.equal(json.ok, true, `should allow: ${p} (${json.mensaje})`);
    assert.ok(!exists(p), `moved: ${p}`);
  }
  assert.equal(fs.readdirSync(H('.Trash')).length, 4, 'all four are in the Trash');
});

test('cleanup only removes node_modules and .next of idle projects with a lockfile, and never follows links', async () => {
  const { json } = await api('/api/accion', { tipo: 'limpiar', dependencias: true });
  assert.ok(json.liberado > 0, json.mensaje);
  // idle with lockfile: dependencies and build gone, code intact
  assert.ok(!exists(H('Documents', 'repos', 'old-app', 'node_modules')));
  assert.ok(!exists(H('Documents', 'repos', 'old-app', '.next')));
  assert.ok(exists(H('Documents', 'repos', 'old-app', 'src', 'index.js')));
  assert.ok(exists(H('Documents', 'repos', 'old-app', 'package-lock.json')));
  // recent project, project without lockfile, locked by MCP, something running: untouched
  assert.ok(exists(H('Documents', 'repos', 'new-app', 'node_modules')));
  assert.ok(exists(H('Documents', 'repos', 'no-lock-app', 'node_modules')));
  assert.ok(exists(H('Documents', 'tools', 'mcp-tool', 'node_modules')));
  assert.ok(exists(H('Documents', 'tools', 'mcp-tool', '.next')));
  assert.ok(exists(H('Documents', 'repos', 'running-app', 'node_modules')));
  assert.ok(exists(H('Documents', 'repos', 'running-app', '.next')));
  // links inside node_modules are removed, never what they point to
  assert.ok(!exists(H('Documents', 'repos', 'workspace-app', 'node_modules')));
  assert.ok(exists(H('Documents', 'repos', 'shared-code', 'keep.js')));
  assert.ok(exists(path.join(OUT, 'store', 'keep.js')));
  // node_modules that is itself a link: left alone
  assert.ok(exists(path.join(OUT, 'linked-target', 'keep.js')));
});

test('manual delete refuses projects that are locked or have something running', async () => {
  const { json } = await api('/api/accion', { tipo: 'borrar-proyectos', rutas: [H('Documents', 'tools', 'mcp-tool'), H('Documents', 'repos', 'running-app'), '/etc', `${HOME}/../outside`] });
  assert.equal(json.ok, false);
  assert.ok(exists(H('Documents', 'tools', 'mcp-tool', 'node_modules')));
  assert.ok(exists(H('Documents', 'repos', 'running-app', 'node_modules')));
});

test('secrets in tool configs are never stored', () => {
  const all = fs.readdirSync(DATA).filter(f => !fs.statSync(path.join(DATA, f)).isDirectory()).map(f => fs.readFileSync(path.join(DATA, f), 'utf8')).join('\n');
  assert.ok(!all.includes('sk-fake-secret'));
});

test('Cowork: reset keeps a backup, restore puts it back, and backup names cannot escape', async () => {
  const rootfs = H('Library', 'Application Support', 'Claude', 'vm_bundles', 'claudevm.bundle', 'rootfs.img');
  let r = await api('/api/accion', { tipo: 'cowork-reiniciar' });
  assert.equal(r.json.ok, true, r.json.mensaje);
  assert.ok(!exists(rootfs));
  const [backup] = fs.readdirSync(path.join(DATA, 'respaldos'));
  assert.match(backup, /^cowork-rootfs-/);
  for (const bad of ['../config.json', '/etc/hosts', 'cowork-rootfs-x/../../config.json']) {
    r = await api('/api/accion', { tipo: 'cowork-borrar-copia', archivo: bad });
    assert.equal(r.json.ok, false, bad);
  }
  assert.ok(exists(path.join(DATA, 'config.json')));
  r = await api('/api/accion', { tipo: 'cowork-restaurar', archivo: backup });
  assert.equal(r.json.ok, true, r.json.mensaje);
  assert.ok(exists(rootfs));
});

test('the npm cache is emptied with npm itself, only inside its cache folder', async (t) => {
  if (spawnSync('npm', ['--version']).status !== 0) return t.skip('npm not available');
  const { json } = await api('/api/accion', { tipo: 'npm' });
  assert.equal(json.ok, true, json.mensaje);
  assert.ok(!exists(H('.npm', '_cacache', 'content-v2', 'x')));
  assert.ok(exists(path.join(OUT, 'sentinel.txt')));
});

test('nothing outside the home folder was touched', () => {
  for (const p of ['sentinel.txt', path.join('store', 'keep.js'), path.join('linked-target', 'keep.js')]) assert.ok(exists(path.join(OUT, p)), p);
});
