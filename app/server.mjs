#!/usr/bin/env node
/*
  Fast Atlas, a Fast Web Labs app (fast-web.es)
  Panel local para ver qué ocupa el disco y la RAM de tu Mac y limpiar lo que se rehace solo.
  Escucha solo en 127.0.0.1 (y ::1). No envía nada a internet.
*/

import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.resolve(process.env.FAST_ATLAS_HOME || os.homedir());
const DATA = path.resolve(process.env.FAST_ATLAS_DATA || path.join(APP_DIR, 'data'));
const RESPALDOS = path.join(DATA, 'respaldos');
const PUERTO = Number(process.env.FAST_ATLAS_PORT || 4848);
const ES_MAC = process.platform === 'darwin';
const PRUEBAS = process.env.FAST_ATLAS_TEST === '1'; // solo para probar fuera del Mac
const DEMO = process.env.FAST_ATLAS_DEMO === '1';       // datos de ejemplo, no toca nada
const TOKEN = crypto.randomBytes(24).toString('hex');
const MIN = 60e3, HORA = 60 * MIN, DIA = 24 * HORA;

let HOME_REAL = HOME;
try { HOME_REAL = fs.realpathSync(HOME); } catch {}

const lib = (...p) => path.join(HOME, 'Library', ...p);
const P = {
  library: lib(),
  vm: lib('Application Support', 'Claude', 'vm_bundles'),
  bundle: lib('Application Support', 'Claude', 'vm_bundles', 'claudevm.bundle'),
  rootfs: lib('Application Support', 'Claude', 'vm_bundles', 'claudevm.bundle', 'rootfs.img'),
  base: lib('Application Support', 'Claude', 'vm_bundles', 'claudevm.bundle', 'rootfs.img.zst'),
  caches: lib('Caches'),
  docker: lib('Containers', 'com.docker.docker'),
  xcode: lib('Developer'),
  npm: path.join(HOME, '.npm'),
  claudeCode: path.join(HOME, '.claude'),
  descargas: path.join(HOME, 'Downloads'),
  papelera: path.join(HOME, '.Trash'),
  ollama: path.join(HOME, '.ollama'),
  lmstudio: path.join(HOME, '.lmstudio'),
  hf: path.join(HOME, '.cache', 'huggingface'),
  apps: '/Applications',
};

// Carpetas que no se miden: macOS pide permisos raros o son nube.
const NO_MEDIR = new Map([
  [lib('Containers'), 'App Store app data. macOS asks for permission to look inside, so it is not measured.'],
  [lib('Group Containers'), 'Data shared between apps. macOS asks for permission to look inside, so it is not measured.'],
  [lib('Mobile Documents'), 'It is iCloud Drive. It lives in the cloud, so it is not measured.'],
  [lib('CloudStorage'), 'Cloud folders (Google Drive, Dropbox). Not measured.'],
]);

// Nombres como los enseña el Finder.
const NOMBRES = {
  Library: 'Library', Desktop: 'Desktop', Documents: 'Documents', Downloads: 'Downloads',
  Pictures: 'Pictures', Movies: 'Movies', Music: 'Music', Public: 'Public', Applications: 'Applications',
  '.npm': 'npm cache', '.claude': 'Claude Code', '.Trash': 'Trash', '.cache': 'Dev caches',
  '.nvm': 'Node versions', '.ollama': 'Ollama models', '.lmstudio': 'LM Studio models',
  '.vscode': 'VS Code extensions', '.cursor': 'Cursor', '.docker': 'Docker settings',
};
const ETIQUETAS_RUTA = new Map([
  [lib('Application Support'), 'App data'],
  [lib('Caches'), 'App caches'],
  [lib('Developer'), 'Xcode and simulators'],
  [lib('Application Support', 'Claude'), 'Claude app'],
  [P.vm, 'Cowork disk'],
  [lib('Application Support', 'Google', 'Chrome'), 'Chrome'],
]);

// Lo que se sigue de cerca.
const SEGUIMIENTO = [
  { id: 'cowork', nombre: 'Cowork', corto: 'Cowork', ruta: () => P.vm, rapido: true, nivel: 'rehace', accion: 'cowork', soloMac: true,
    que: 'The virtual machine Cowork works in. It grows with every task and never gives the space back.',
    siLimpias: 'Claude rebuilds it from scratch the next time you open Cowork. Your sessions and projects are not touched. I keep it as a backup until you confirm everything works.' },
  { id: 'npm', nombre: 'npm cache', corto: 'Your npm cache', ruta: () => P.npm, rapido: true, nivel: 'rehace', accion: 'npm',
    que: 'Copies of packages you already downloaded, to install faster. npm never empties it on its own.',
    siLimpias: 'The next npm install downloads whatever is missing. That one install is a bit slower.' },
  { id: 'deps', nombre: 'Project dependencies', corto: 'Your dependencies', plural: true, calculado: true, nivel: 'rehace', accion: 'proyectos',
    que: 'The node_modules folders: the libraries each project installs. Every project has its own.',
    siLimpias: 'They come back with each project install (npm, pnpm or yarn). Your projects shows the exact command. These are only deleted when you ask.' },
  { id: 'next', nombre: 'Next.js builds', corto: 'Your Next.js builds', plural: true, calculado: true, nivel: 'rehace', accion: 'proyectos',
    que: 'The .next folders: what Next.js generates when it builds. Their cache grows with every build.',
    siLimpias: 'They are generated again the next time you start the project. The weekly cleanup deletes the ones in idle projects.' },
  { id: 'claude-code', nombre: 'Claude Code', corto: 'Claude Code', ruta: () => P.claudeCode, rapido: true, nivel: 'mirar', accion: 'finder',
    que: 'Claude Code conversation history and settings.',
    siLimpias: 'You would lose conversations and settings. It is never touched from here.' },
  { id: 'cache-apps', nombre: 'App caches', corto: 'Your app caches', plural: true, ruta: () => P.caches, nivel: 'revisar', accion: 'carpeta',
    que: 'Temporary files from all your apps: browsers, Spotify, Figma, updaters.',
    siLimpias: 'Each app rebuilds its own, but deleting while the app is open can cause glitches. Open it to see which one takes the most.' },
  { id: 'descargas', nombre: 'Downloads', corto: 'Your downloads', plural: true, ruta: () => P.descargas, nivel: 'revisar', accion: 'carpeta',
    que: 'What you downloaded from the internet. Usually full of forgotten installers, zips and videos.',
    siLimpias: 'It is yours: review it and throw away what you do not use.' },
  { id: 'papelera', nombre: 'Trash', corto: 'Your Trash', ruta: () => P.papelera, nivel: 'revisar', accion: 'vaciar',
    que: 'What you already threw away. It does not free any space until you empty it.',
    siLimpias: 'Emptying it deletes everything inside forever, including what you trashed from Finder. It is the only way to free the space of what you move to the Trash.' },
  { id: 'docker', nombre: 'Docker', corto: 'Docker', ruta: () => P.docker, opcional: true, nivel: 'mirar', accion: 'finder',
    que: 'Docker’s virtual disk. Your containers may live here, n8n for example.',
    siLimpias: 'Do not touch it from here: you could lose your containers’ data.' },
  { id: 'ollama', nombre: 'Ollama models', corto: 'Ollama', ruta: () => P.ollama, opcional: true, nivel: 'revisar', accion: 'finder',
    que: 'AI models you downloaded to run locally. Each one weighs several GB.',
    siLimpias: 'Remove them with Ollama itself (ollama list, then ollama rm name) so it stays consistent.' },
  { id: 'lmstudio', nombre: 'LM Studio models', corto: 'LM Studio', ruta: () => P.lmstudio, opcional: true, nivel: 'revisar', accion: 'finder',
    que: 'AI models downloaded in LM Studio.', siLimpias: 'Remove them from the app itself.' },
  { id: 'hf', nombre: 'Hugging Face models', corto: 'Hugging Face', ruta: () => P.hf, opcional: true, nivel: 'revisar', accion: 'finder',
    que: 'Models and datasets downloaded by AI libraries.', siLimpias: 'They are downloaded again if something needs them.' },
  { id: 'xcode', nombre: 'Xcode and simulators', corto: 'Xcode', ruta: () => P.xcode, opcional: true, nivel: 'revisar', accion: 'carpeta',
    que: 'Xcode simulators, builds and device support files.', siLimpias: 'Better from Xcode. Open it to see what takes space.' },
];
const SEG_POR_ID = new Map(SEGUIMIENTO.map(s => [s.id, s]));

// ---------------------------------------------------------------- utilidades

function log(...a) { console.log(new Date().toISOString(), ...a); }

function run(cmd, args = [], { timeout = 10 * MIN } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', hecho = false, t = null;
    const fin = (r) => { if (!hecho) { hecho = true; clearTimeout(t); resolve(r); } };
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e.message), falta: true }); }
    t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-4e6); });
    child.stderr.on('data', d => { err += d; if (err.length > 2e5) err = err.slice(-2e5); });
    child.on('error', e => fin({ code: -1, out, err: String(e.message), falta: e.code === 'ENOENT' }));
    child.on('close', code => fin({ code, out, err }));
  });
}

const ocupado = (st) => (st && st.blocks != null ? st.blocks * 512 : st ? st.size : 0);
async function existe(p) { try { await fsp.access(p); return true; } catch { return false; } }
const espera = (ms) => new Promise(r => setTimeout(r, ms));

async function du(ruta) {
  try { await fsp.lstat(ruta); } catch { return null; }
  const r = await run('du', ['-sk', '-x', ruta], { timeout: 30 * MIN });
  const lineas = r.out.trim().split('\n').filter(Boolean);
  const kb = parseInt(lineas[lineas.length - 1] || '', 10);
  const parcial = /Operation not permitted|Permission denied/i.test(r.err);
  const nota = /\.photoslibrary/i.test(r.err) ? 'The Photos library can’t be measured without permission: check its size in System Settings > General > Storage.' : undefined;
  return { bytes: Number.isFinite(kb) ? kb * 1024 : 0, parcial, nota };
}

async function pool(tareas, n, alAvanzar) {
  const res = new Array(tareas.length);
  let i = 0, hechas = 0;
  async function trabajador() {
    while (i < tareas.length) {
      const k = i++;
      try { res[k] = await tareas[k](); } catch (e) { res[k] = null; }
      hechas++;
      if (alAvanzar) alAvanzar(hechas, tareas.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, tareas.length)) }, trabajador));
  return res;
}

function dentroDeHome(p) {
  const r = path.resolve(p);
  return r.startsWith(HOME + path.sep) || r.startsWith(HOME_REAL + path.sep);
}
// Última barrera: todo lo que se borra o se mueve pasa por aquí antes. Si algo no cuadra, lanza un error y no se toca nada.
function barrera(ruta, { minProfundidad = 2, enDatos = false } = {}) {
  const r = path.resolve(String(ruta || ''));
  if (r.split(path.sep).includes('..')) throw new Error('Safety check: invalid path');
  if (enDatos) {
    if (!r.startsWith(DATA + path.sep)) throw new Error('Safety check: path outside Fast Atlas data');
    return r;
  }
  if (!dentroDeHome(r)) throw new Error('Safety check: path outside your home folder');
  const base = r.startsWith(HOME_REAL + path.sep) ? HOME_REAL : HOME;
  if (path.relative(base, r).split(path.sep).length < minProfundidad) throw new Error('Safety check: path too close to your home folder');
  return r;
}

function permitidaParaMirar(p) {
  const r = path.resolve(p);
  return r === HOME || r === HOME_REAL || dentroDeHome(r) || r === P.apps || r.startsWith(P.apps + path.sep);
}

function gbTexto(b) {
  if (b == null) return 'sin medir';
  const g = b / 1e9;
  const f = (n, d) => n.toLocaleString('en-US', { maximumFractionDigits: d });
  if (g >= 100) return f(g, 0) + ' GB';
  if (g >= 1) return f(g, 1) + ' GB';
  return f(b / 1e6, 0) + ' MB';
}

function nombreBonito(ruta) {
  if (ETIQUETAS_RUTA.has(ruta)) return ETIQUETAS_RUTA.get(ruta);
  const base = path.basename(ruta);
  if (path.dirname(ruta) === HOME && NOMBRES[base]) return NOMBRES[base];
  if (ruta === P.apps) return 'Applications';
  return base;
}

// ---------------------------------------------------------------- datos en disco

async function anexar(archivo, obj) {
  try { await fsp.appendFile(path.join(DATA, archivo), JSON.stringify(obj) + '\n'); } catch (e) { log('could not save', archivo, e.message); }
}
async function leerJsonl(archivo) {
  try {
    const txt = await fsp.readFile(path.join(DATA, archivo), 'utf8');
    return txt.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
async function reescribirJsonl(archivo, filas) {
  const f = path.join(DATA, archivo);
  await fsp.writeFile(f + '.tmp', filas.map(x => JSON.stringify(x)).join('\n') + (filas.length ? '\n' : ''));
  await fsp.rename(f + '.tmp', f);
}
async function escribirJSON(archivo, obj) {
  const f = path.join(DATA, archivo);
  await fsp.writeFile(f + '.tmp', JSON.stringify(obj));
  await fsp.rename(f + '.tmp', f);
}
async function leerJSON(archivo, def) {
  try { return JSON.parse(await fsp.readFile(path.join(DATA, archivo), 'utf8')); } catch { return def; }
}

// ---------------------------------------------------------------- estado

const config = { limpiezaAuto: false, diasParado: 60, avisoPct: 10, instalado: Date.now(), ultimaLimpieza: null, ultimoAvisoPoco: 0, avisosCrecimiento: {}, protegidos: [], permitidos: [], enPapelera: 0 };

const estado = {
  maquina: { nombre: os.hostname() },
  disco: null, home: null, library: null, apps: null, seg: {}, proyectos: null, tm: null, cowork: null, usos: null, grandes: null,
  tCompleto: 0, tRapido: 0, ultimoError: null,
  escaneo: { enCurso: false },
  historia: [], serieLibre: [], registro: [],
  carpetas: new Map(),
  ram: null,
};

async function guardarEstado() {
  try {
    await escribirJSON('estado.json', {
      disco: estado.disco, home: estado.home, library: estado.library, apps: estado.apps, seg: estado.seg,
      proyectos: estado.proyectos, tm: estado.tm, usos: estado.usos, grandes: estado.grandes, tCompleto: estado.tCompleto, tRapido: estado.tRapido,
    });
  } catch (e) { log('could not save state', e.message); }
}
async function guardarConfig() { try { await escribirJSON('config.json', config); } catch (e) { log('config', e.message); } }

async function cargarTodo() {
  await fsp.mkdir(DATA, { recursive: true });
  await fsp.mkdir(RESPALDOS, { recursive: true });
  const c = await leerJSON('config.json', null);
  if (c) Object.assign(config, c); else await guardarConfig();
  if (!Array.isArray(config.protegidos)) config.protegidos = [];
  if (!Array.isArray(config.permitidos)) config.permitidos = [];
  await guardarConfig();
  const e = await leerJSON('estado.json', null);
  if (e) for (const k of Object.keys(e)) estado[k] = e[k];
  const ahora = Date.now();
  estado.historia = (await leerJsonl('historia.jsonl')).filter(f => ahora - f.t < 400 * DIA);
  estado.serieLibre = (await leerJsonl('libre.jsonl')).filter(f => ahora - f.t < 120 * DIA);
  estado.registro = (await leerJsonl('registro.jsonl')).slice(-500);
  // recortar archivos para que no crezcan (sería irónico)
  await reescribirJsonl('historia.jsonl', estado.historia);
  await reescribirJsonl('libre.jsonl', estado.serieLibre);
  await reescribirJsonl('registro.jsonl', estado.registro);
}

async function registrar(entrada) {
  const e = { t: Date.now(), ...entrada };
  estado.registro.push(e);
  if (estado.registro.length > 500) estado.registro = estado.registro.slice(-500);
  await anexar('registro.jsonl', e);
}

// ---------------------------------------------------------------- medir

// Lo que macOS llama «disponible»: lo libre de verdad más lo purgable (lo que macOS libera solo
// cuando hace falta). Es el número de Finder y de Ajustes. Se pide al sistema con JavaScript para
// Automatización, sin permisos. Si falla, se usa solo lo libre de verdad.
const JXA_DISPONIBLE = `ObjC.import('Foundation');
(function () {
  var k = 'NSURLVolumeAvailableCapacityForImportantUsageKey';
  var d = $.NSURL.fileURLWithPath('/').resourceValuesForKeysError($([k]), null);
  if (!d) return '';
  var v = d.objectForKey(k);
  return v ? String(ObjC.unwrap(v)) : '';
})();`;
async function disponibleSegunMac() {
  if (!ES_MAC) return null;
  const r = await run('osascript', ['-l', 'JavaScript', '-e', JXA_DISPONIBLE], { timeout: 15000 });
  const n = Number(String(r.out).trim());
  return r.code === 0 && Number.isFinite(n) && n > 0 ? n : null;
}

async function medirDisco() {
  const objetivo = ES_MAC ? '/System/Volumes/Data' : '/';
  let d = null;
  try {
    if (typeof fsp.statfs === 'function') {
      const s = await fsp.statfs(objetivo);
      const total = Number(s.blocks) * Number(s.bsize), libre = Number(s.bavail) * Number(s.bsize);
      if (total > 0) d = { total, libre, usado: total - libre, t: Date.now() };
    }
  } catch {}
  if (!d) {
    const r = await run('df', ['-k', objetivo], { timeout: 15000 });
    const campos = r.out.trim().split('\n').slice(1).join(' ').trim().split(/\s+/);
    const total = Number(campos[1]) * 1024, libre = Number(campos[3]) * 1024;
    if (!(total > 0)) throw new Error('Could not read the disk size');
    d = { total, libre, usado: total - libre, t: Date.now() };
  }
  const mac = await disponibleSegunMac().catch(() => null);
  d.disponible = mac && mac <= d.total && mac >= d.libre * 0.5 ? mac : d.libre;
  d.purgable = Math.max(0, d.disponible - d.libre);
  d.segunMac = !!(mac && d.disponible === mac);
  d.esMac = ES_MAC;
  return d;
}

async function medirHijos(dir, alAvanzar) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (e) { return { error: e.code === 'EPERM' || e.code === 'EACCES' ? 'macOS does not allow looking inside this folder.' : 'I could not read this folder.', hijos: [] }; }
  const tareas = [];
  let sueltos = 0, nSueltos = 0;
  for (const e of ents) {
    const ruta = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (NO_MEDIR.has(ruta)) { tareas.push(async () => ({ nombre: e.name, ruta, bytes: null, noMedido: NO_MEDIR.get(ruta), dir: true })); continue; }
    if (e.isDirectory()) {
      if (ruta === P.library && dir === HOME && estado.library && Date.now() - estado.library.t < HORA) {
        tareas.push(async () => {
          const h = estado.library.hijos;
          return { nombre: e.name, ruta, bytes: h.reduce((s, x) => s + (x.bytes || 0), 0), parcial: h.some(x => x.parcial || x.noMedido), dir: true };
        });
      } else {
        tareas.push(async () => { const r = await du(ruta); return { nombre: e.name, ruta, bytes: r ? r.bytes : 0, parcial: !!(r && r.parcial), nota: r && r.nota, dir: true }; });
      }
    } else if (e.isFile()) {
      tareas.push(async () => {
        try {
          const st = await fsp.lstat(ruta);
          const b = ocupado(st);
          if (b >= 50e6) return { nombre: e.name, ruta, bytes: b, dir: false };
          sueltos += b; nSueltos++;
        } catch {}
        return null;
      });
    }
  }
  const hijos = (await pool(tareas, 3, alAvanzar)).filter(Boolean);
  if (sueltos > 0) hijos.push({ nombre: nSueltos === 1 ? '1 small file' : `${nSueltos} small files`, ruta: dir, bytes: sueltos, sueltos: true, dir: false });
  hijos.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  return { hijos };
}

const SALTAR = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo', '.vercel', 'coverage', 'Pods', 'vendor', '__pycache__', 'venv', 'target', 'DerivedData', '.svelte-kit', '.nuxt', '.output']);
const SALTAR_RAIZ = new Set(['Library', 'Applications', 'Music', 'Movies', 'Pictures', 'Public']);
const SALTAR_EXT = /\.(app|photoslibrary|bundle|framework|fcpbundle|lrlibrary|lrdata|musiclibrary|tvlibrary|imovielibrary|xcarchive|plugin|kext|band|logicx|aplibrary)$/i;
const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];

async function buscarProyectos(alAvanzar) {
  const encontrados = [];
  const pila = [[HOME, 0]];
  let vistos = 0;
  while (pila.length) {
    const [dir, prof] = pila.pop();
    if (++vistos > 250000) break;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    if (dir !== HOME) {
      const nombres = new Set(ents.map(x => x.name));
      if (nombres.has('package.json') && (nombres.has('node_modules') || nombres.has('.next'))) {
        encontrados.push({
          ruta: dir, nombre: path.basename(dir), carpeta: path.relative(HOME, path.dirname(dir)) || '~',
          tieneNM: nombres.has('node_modules'), tieneNext: nombres.has('.next'),
          lock: LOCKS.find(f => nombres.has(f)) || lockArriba(dir), git: nombres.has('.git'),
        });
      }
    }
    if (prof >= 8) continue;
    for (const x of ents) {
      if (!x.isDirectory()) continue;
      const n = x.name;
      if (n.startsWith('.') || SALTAR.has(n) || SALTAR_EXT.test(n)) continue;
      if (prof === 0 && SALTAR_RAIZ.has(n)) continue;
      pila.push([path.join(dir, n), prof + 1]);
    }
    if (vistos % 400 === 0) { if (alAvanzar) alAvanzar(vistos); await new Promise(r => setImmediate(r)); }
  }
  return encontrados;
}

// En un monorepo el lockfile está en la raíz, no en cada paquete.
function lockArriba(dir) {
  let d = path.dirname(dir);
  for (let i = 0; i < 4 && d.startsWith(HOME + path.sep); i++, d = path.dirname(d)) {
    const f = LOCKS.find(x => fs.existsSync(path.join(d, x)));
    if (f) return path.relative(dir, path.join(d, f));
  }
  return null;
}

const NO_CUENTA = new Set(['node_modules', '.next', '.git', '.turbo', '.vercel', 'dist', 'build', 'out', '.DS_Store', 'coverage']);
async function ultimaVez(dir) {
  let max = 0, vistos = 0;
  async function mirar(d, prof) {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++vistos > 4000) return;
      if (NO_CUENTA.has(e.name)) continue;
      const p = path.join(d, e.name);
      try { const st = await fsp.lstat(p); if (st.mtimeMs > max) max = st.mtimeMs; } catch {}
      if (e.isDirectory() && !e.isSymbolicLink() && prof < 2) await mirar(p, prof + 1);
    }
  }
  await mirar(dir, 0);
  return max || null;
}

async function escanearProyectos(esc) {
  esc.fase = 'Looking for your projects';
  const base = await buscarProyectos(n => { esc.detalle = `${n.toLocaleString('en-US')} folders checked`; });
  esc.fase = 'Measuring your projects'; esc.detalle = '';
  const lista = await pool(base.map(p => async () => {
    const [nm, nx, tocado] = await Promise.all([
      p.tieneNM ? du(path.join(p.ruta, 'node_modules')) : null,
      p.tieneNext ? du(path.join(p.ruta, '.next')) : null,
      ultimaVez(p.ruta),
    ]);
    return { ruta: p.ruta, nombre: p.nombre, carpeta: p.carpeta, lock: p.lock, git: p.git, nm: nm ? nm.bytes : 0, next: nx ? nx.bytes : 0, tocado };
  }), 3, (h, n) => { esc.paso = h; esc.pasos = n; });
  return { t: Date.now(), lista: lista.filter(Boolean).filter(p => p.nm + p.next > 0) };
}

async function medirSeguimiento({ rapido = false } = {}) {
  const cache = new Map();
  if (!rapido) {
    for (const h of estado.home?.hijos || []) cache.set(h.ruta, h);
    for (const h of estado.library?.hijos || []) cache.set(h.ruta, h);
  }
  for (const def of SEGUIMIENTO) {
    if (def.calculado) continue;
    if (rapido && !def.rapido) continue;
    const ruta = def.ruta();
    const c = cache.get(ruta);
    let r;
    if (c && c.bytes != null) r = { bytes: c.bytes, parcial: c.parcial };
    else r = await du(ruta);
    estado.seg[def.id] = r ? { existe: true, bytes: r.bytes, parcial: !!r.parcial, t: Date.now() } : { existe: false, bytes: 0, t: Date.now() };
  }
  const lista = estado.proyectos?.lista || [];
  estado.seg.deps = { existe: lista.some(p => p.nm > 0), bytes: lista.reduce((s, p) => s + (p.nm || 0), 0), t: estado.proyectos?.t || Date.now() };
  estado.seg.next = { existe: lista.some(p => p.next > 0), bytes: lista.reduce((s, p) => s + (p.next || 0), 0), t: estado.proyectos?.t || Date.now() };
}

async function nombreMac() {
  if (!ES_MAC) return os.hostname();
  const r = await run('scutil', ['--get', 'ComputerName'], { timeout: 5000 });
  return r.code === 0 && r.out.trim() ? r.out.trim() : os.hostname();
}

async function snapshotsTM() {
  if (!ES_MAC) return null;
  const r = await run('tmutil', ['listlocalsnapshots', '/'], { timeout: 30000 });
  if (r.code !== 0) return null;
  return (r.out.match(/com\.apple\.TimeMachine/g) || []).length;
}

async function detectarCacheNpm() {
  const r = await run(rutaNpm(), ['config', 'get', 'cache'], { timeout: 20000 });
  const p = r.out.trim().split('\n').pop();
  if (r.code === 0 && p && path.isAbsolute(p)) P.npm = p;
}
function rutaNpm() {
  const junto = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(junto) ? junto : 'npm';
}

// ---------------------------------------------------------------- escaneos

async function escaneoRapido() {
  if (estado.escaneo.enCurso || DEMO) return;
  try {
    estado.disco = await medirDisco();
    await medirSeguimiento({ rapido: true });
    await estadoCowork();
    estado.tRapido = Date.now();
    await guardarEstado();
  } catch (e) { log('quick scan', e.message); }
}

async function escaneoCompleto(motivo) {
  if (estado.escaneo.enCurso || DEMO) return false;
  const esc = estado.escaneo = { enCurso: true, fase: 'Reading the disk', detalle: '', paso: 0, pasos: 0, inicio: Date.now() };
  log('full scan:', motivo);
  const avance = (h, n) => { esc.paso = h; esc.pasos = n; };
  try {
    estado.disco = await medirDisco();
    esc.fase = 'Measuring Library';
    const lib = await medirHijos(P.library, avance);
    estado.library = lib.error ? null : { t: Date.now(), hijos: lib.hijos };
    esc.fase = 'Measuring your home folder'; esc.paso = 0; esc.pasos = 0;
    const home = await medirHijos(HOME, avance);
    estado.home = { t: Date.now(), hijos: home.hijos };
    esc.paso = 0; esc.pasos = 0;
    estado.proyectos = await escanearProyectos(esc);
    esc.fase = 'Checking what your tools use'; esc.detalle = ''; esc.paso = 0; esc.pasos = 0;
    await detectarUsos();
    esc.fase = 'Looking for large files';
    estado.grandes = await buscarGrandes(esc);
    esc.fase = 'Measuring your apps'; esc.detalle = '';
    const a = await du(P.apps);
    estado.apps = a ? { bytes: a.bytes, t: Date.now() } : null;
    esc.fase = 'Checking what grows on its own';
    await medirSeguimiento();
    estado.tm = await snapshotsTM();
    await estadoCowork();
    estado.disco = await medirDisco();
    estado.tCompleto = estado.tRapido = Date.now();
    estado.ultimoError = null;
    estado.carpetas.clear();
    await guardarEstado();
    await tomarFoto();
    await avisarCrecimiento();
  } catch (e) {
    log('scan error', e.stack || e.message);
    estado.ultimoError = 'The last scan failed: ' + e.message;
  } finally {
    estado.escaneo = { enCurso: false };
  }
  return true;
}

async function tomarFoto() {
  const foto = { t: Date.now(), libre: estado.disco?.libre, usado: estado.disco?.usado, seg: {}, home: {} };
  for (const [id, v] of Object.entries(estado.seg)) foto.seg[id] = v.bytes || 0;
  for (const h of estado.home?.hijos || []) if (h.bytes != null && !h.sueltos) foto.home[h.nombre] = h.bytes;
  foto.deps = depsPorRaiz();
  estado.historia.push(foto);
  await anexar('historia.jsonl', foto);
}

async function muestrearLibre() {
  if (!estado.disco) return;
  const m = { t: Date.now(), libre: estado.disco.libre };
  estado.serieLibre.push(m);
  await anexar('libre.jsonl', m);
}

// ---------------------------------------------------------------- crecimiento y avisos

function fotoBase(dias = 7) {
  const ahora = Date.now(), objetivo = ahora - dias * DIA;
  let mejor = null;
  for (const f of estado.historia) {
    if (ahora - f.t < 20 * HORA) continue;
    if (!mejor || Math.abs(f.t - objetivo) < Math.abs(mejor.t - objetivo)) mejor = f;
  }
  return mejor;
}

function depsPorRaiz() {
  const m = {};
  for (const p of estado.proyectos?.lista || []) {
    const raiz = path.relative(HOME, p.ruta).split(path.sep)[0];
    m[raiz] = (m[raiz] || 0) + (p.nm || 0) + (p.next || 0);
  }
  return m;
}

function crecimiento() {
  const base = fotoBase(7);
  if (!base) return { desde: null, lista: [] };
  const lista = [];
  const rutasSeg = new Map();
  const deltaSeg = {};
  for (const def of SEGUIMIENTO) {
    const s = estado.seg[def.id], antes = base.seg?.[def.id];
    if (def.ruta) rutasSeg.set(def.ruta(), def.id);
    if (!s?.existe || antes == null) continue;
    const d = s.bytes - antes;
    deltaSeg[def.id] = d;
    lista.push({ clave: 'seg:' + def.id, seg: def.id, nombre: def.nombre, corto: def.corto, plural: !!def.plural, bytes: s.bytes, delta: d });
  }
  const depsAhora = depsPorRaiz();
  for (const h of estado.home?.hijos || []) {
    if (h.bytes == null || h.sueltos || rutasSeg.has(h.ruta)) continue;
    const antes = base.home?.[h.nombre];
    if (antes == null) continue;
    let d = h.bytes - antes;
    // lo que ya explica algo seguido dentro de esta carpeta no cuenta dos veces
    for (const [ruta, id] of rutasSeg) if (ruta.startsWith(h.ruta + path.sep)) d -= deltaSeg[id] || 0;
    if (base.deps) d -= (depsAhora[h.nombre] || 0) - (base.deps[h.nombre] || 0);
    lista.push({ clave: 'home:' + h.nombre, home: h.nombre, ruta: h.ruta, nombre: nombreBonito(h.ruta), corto: nombreBonito(h.ruta), plural: false, bytes: h.bytes, delta: d });
  }
  lista.sort((a, b) => b.delta - a.delta);
  return { desde: base.t, lista };
}

async function avisarCrecimiento() {
  const ayer = fotoBase(1);
  if (!ayer || !ES_MAC) return;
  for (const def of SEGUIMIENTO) {
    const ahora = estado.seg[def.id]?.bytes || 0, antes = ayer.seg?.[def.id];
    if (antes == null) continue;
    const d = ahora - antes;
    const ultimo = config.avisosCrecimiento[def.id] || 0;
    if (d > 5e9 && Date.now() - ultimo > 20 * HORA) {
      notificar(`${def.nombre} grew ${gbTexto(d)} since yesterday`, `It now takes up ${gbTexto(ahora)}. See the details at localhost:${PUERTO}`);
      config.avisosCrecimiento[def.id] = Date.now();
    }
  }
  await guardarConfig();
}

async function avisarPocoEspacio() {
  const d = estado.disco;
  if (!d) return;
  const umbral = Math.max(20e9, d.total * config.avisoPct / 100);
  const disp = d.disponible ?? d.libre;
  if (disp < umbral && Date.now() - (config.ultimoAvisoPoco || 0) > 12 * HORA) {
    notificar(`Only ${gbTexto(disp)} left on your disk`, `Open localhost:${PUERTO} to see what is taking up space.`);
    config.ultimoAvisoPoco = Date.now();
    await guardarConfig();
  }
}

function notificar(titulo, texto) {
  log('notification:', titulo, '|', texto);
  if (!ES_MAC || DEMO || PRUEBAS) return;
  const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  run('osascript', ['-e', `display notification ${q(texto)} with title ${q('Fast Atlas')} subtitle ${q(titulo)}`], { timeout: 15000 });
}

// ---------------------------------------------------------------- protección: lo que no se toca

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'login', 'tmux', 'screen', 'nu', 'dash', 'ksh']);

// Programas abiertos dentro de cada carpeta (npm run dev, Claude Code...). null si no se puede saber.
async function procesosConCarpeta() {
  const r = await run('lsof', ['-d', 'cwd', '-F', 'pcn'], { timeout: 60000 });
  if (r.falta) return null;
  const res = [];
  let actual = null;
  for (const l of r.out.split('\n')) {
    if (l.startsWith('p')) actual = { pid: l.slice(1), cmd: '' };
    else if (l.startsWith('c') && actual) actual.cmd = l.slice(1);
    else if (l.startsWith('n') && actual) res.push({ pid: actual.pid, cmd: actual.cmd, cwd: l.slice(1) });
  }
  return res;
}
function corriendoEn(procs, ruta) {
  if (!procs) return [];
  const dentro = procs.filter(x => x.cwd === ruta || x.cwd.startsWith(ruta + path.sep));
  return [...new Set(dentro.map(x => x.cmd.replace(/^-/, '')).filter(c => c && !SHELLS.has(c)))];
}

// Carpetas que usan otras herramientas: servidores MCP de Claude, Cursor o Windsurf y tareas programadas.
async function detectarUsos() {
  const usos = [];
  const leer = async (f) => { try { const t = await fsp.readFile(f, 'utf8'); return t.length > 30e6 ? null : JSON.parse(t); } catch { return null; } };
  const cadenas = (v, out) => {
    if (typeof v === 'string') { if (v.includes('/')) out.push(v); }
    else if (Array.isArray(v)) v.forEach(x => cadenas(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach(x => cadenas(x, out));
    return out;
  };
  const fuentes = [
    [lib('Application Support', 'Claude', 'claude_desktop_config.json'), 'Claude (MCP server)'],
    [path.join(HOME, '.claude.json'), 'Claude Code (MCP server)'],
    [path.join(HOME, '.cursor', 'mcp.json'), 'Cursor (MCP server)'],
    [path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), 'Windsurf (MCP server)'],
  ];
  for (const [f, motivo] of fuentes) {
    const j = await leer(f);
    if (!j || typeof j !== 'object') continue;
    const servidores = [j.mcpServers, ...Object.values(j.projects || {}).map(p => p && p.mcpServers)].filter(Boolean);
    for (const srv of servidores) for (const c of cadenas(srv, [])) usos.push({ ruta: c, motivo });
  }
  try {
    for (const n of await fsp.readdir(lib('LaunchAgents'))) {
      if (!n.endsWith('.plist') || n.startsWith('es.fast-web.')) continue;
      const t = await fsp.readFile(lib('LaunchAgents', n), 'utf8').catch(() => '');
      for (const m of t.matchAll(/<string>([^<]*\/[^<]*)<\/string>/g)) usos.push({ ruta: m[1], motivo: 'a scheduled task' });
    }
  } catch {}
  const c = await run('crontab', ['-l'], { timeout: 8000 });
  if (c.code === 0) for (const tok of c.out.split(/[\s;"'=]+/)) if (tok.includes('/')) usos.push({ ruta: tok, motivo: 'a scheduled task' });
  // De esos archivos solo se queda con rutas que existen dentro de tu carpeta. Nada más se guarda.
  const vistas = new Set();
  const lista = [];
  for (const u of usos) {
    const r = rutaReal(u.ruta);
    if (r && !vistas.has(u.motivo + r)) { vistas.add(u.motivo + r); lista.push({ motivo: u.motivo, ruta: r }); }
  }
  estado.usos = { t: Date.now(), lista };
  return lista;
}
function rutaReal(cadena) {
  const t = String(cadena).replace(/(^|[=\s"'])~\//g, `$1${HOME}/`);
  const i = t.indexOf(HOME + path.sep);
  if (i < 0) return null;
  let r = t.slice(i).split(/[\s"'=,;]/)[0];
  while (r.length > HOME.length + 1 && !fs.existsSync(r)) r = path.dirname(r);
  return r.length > HOME.length + 1 && r.startsWith(HOME + path.sep) ? r : null;
}
function motivosUso(ruta) {
  const l = (estado.usos && estado.usos.lista) || [];
  return [...new Set(l.filter(u => u.ruta === ruta || u.ruta.startsWith(ruta + path.sep)).map(u => u.motivo))];
}
function proteccion(p) {
  if (config.protegidos.includes(p.ruta)) return 'manual';
  if (motivosUso(p.ruta).length && !config.permitidos.includes(p.ruta)) return 'uso';
  return null;
}

// El comando exacto para recuperar node_modules, con el gestor del proyecto y desde donde está su lockfile.
function comandoVolver(p) {
  const l = p.lock || '';
  const gestor = l.endsWith('pnpm-lock.yaml') ? 'pnpm' : l.endsWith('yarn.lock') ? 'yarn' : /bun\.lockb?$/.test(l) ? 'bun' : 'npm';
  const dir = l ? path.dirname(path.resolve(p.ruta, l)) : p.ruta;
  const rel = path.relative(HOME, dir);
  const destino = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? '$HOME/' + rel.replace(/([$"\\`])/g, '\\$1') : dir.replace(/([$"\\`])/g, '\\$1');
  return { gestor, comando: `cd "${destino}" && ${gestor} install` };
}

// ---------------------------------------------------------------- archivos grandes

const GRANDES_SALTAR = new Set(['node_modules', '.git', '.next']);
const MIN_GRANDE = 250e6;
async function buscarGrandes(esc) {
  const top = [];
  const pila = [HOME];
  let vistos = 0;
  while (pila.length) {
    const dir = pila.pop();
    if (++vistos > 300000) break;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    const archivos = [];
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const ruta = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (dir === HOME && e.name === 'Library') continue;
        if (GRANDES_SALTAR.has(e.name) || SALTAR_EXT.test(e.name)) continue;
        pila.push(ruta);
      } else if (e.isFile()) archivos.push(ruta);
    }
    const stats = await Promise.all(archivos.map(f => fsp.lstat(f).then(st => [f, st]).catch(() => null)));
    for (const x of stats) {
      if (!x) continue;
      const b = ocupado(x[1]);
      if (b >= MIN_GRANDE) top.push({ ruta: x[0], nombre: path.basename(x[0]), carpeta: path.relative(HOME, path.dirname(x[0])) || '', bytes: b, mtime: x[1].mtimeMs });
    }
    if (vistos % 300 === 0) { if (esc) esc.detalle = `${vistos.toLocaleString('en-US')} folders checked`; await new Promise(r => setImmediate(r)); }
  }
  top.sort((a, b) => b.bytes - a.bytes);
  return { t: Date.now(), lista: top.slice(0, 25) };
}

// ---------------------------------------------------------------- limpieza

function parado(p) { return !!p.tocado && Date.now() - p.tocado > config.diasParado * DIA; }

// Lo que haría la limpieza ahora. Las cachés (npm y .next) van solas; node_modules solo si tú lo pides.
function planLimpieza() {
  const npm = estado.seg.npm && estado.seg.npm.existe && (estado.seg.npm.bytes || 0) > 50e6 ? estado.seg.npm.bytes : 0;
  const candidatos = (estado.proyectos?.lista || []).filter(p => parado(p) && !proteccion(p));
  const next = candidatos.filter(p => p.next > 0).map(p => ({ ruta: p.ruta, nombre: p.nombre, bytes: p.next, tocado: p.tocado })).sort((a, b) => b.bytes - a.bytes);
  const deps = candidatos.filter(p => p.nm > 0 && p.lock).map(p => ({ ruta: p.ruta, nombre: p.nombre, bytes: p.nm, tocado: p.tocado, ...comandoVolver(p) })).sort((a, b) => b.bytes - a.bytes);
  const suma = (l) => l.reduce((t, x) => t + x.bytes, 0);
  return { npm, next, deps, caches: npm + suma(next), dependencias: suma(deps) };
}

function proximaLimpieza() {
  if (!config.limpiezaAuto) return null;
  return (config.ultimaLimpieza || config.instalado) + 7 * DIA;
}

async function vaciarNpm() {
  if (DEMO) return { ok: true, liberado: estado.seg.npm?.bytes || 0, mensaje: 'Demo: nothing is touched.' };
  const antes = (await du(P.npm))?.bytes || 0;
  const r = await run(rutaNpm(), ['cache', 'clean', '--force'], { timeout: 15 * MIN });
  if (r.code !== 0) return { ok: false, mensaje: 'npm could not clean its cache: ' + ((r.err || '').trim().split('\n')[0] || 'code ' + r.code) };
  const despues = (await du(P.npm))?.bytes || 0;
  estado.seg.npm = { existe: true, bytes: despues, t: Date.now() };
  return { ok: true, liberado: Math.max(0, antes - despues) };
}

// Los mensajes de error empiezan en minúscula: se leen como «nombre-del-proyecto + mensaje».
async function borrarDeProyecto(ruta, que, procs) {
  if (!['node_modules', '.next'].includes(que)) return { ok: false, mensaje: 'only node_modules or .next can be deleted.' };
  const p = (estado.proyectos?.lista || []).find(x => x.ruta === ruta);
  if (!p) return { ok: false, mensaje: 'is not in the last scan. Scan again.' };
  const prot = proteccion(p);
  if (prot) return { ok: false, mensaje: prot === 'manual' ? 'is marked as Do not touch.' : `is used by ${motivosUso(p.ruta).join(' and ')}. Unlock it first if you really want to.` };
  const abiertos = corriendoEn(procs, p.ruta);
  if (abiertos.length) return { ok: false, mensaje: `has something running inside (${abiertos.join(', ')}). Close it and try again.` };
  if (DEMO) { const b = que === 'node_modules' ? p.nm : p.next; if (que === 'node_modules') p.nm = 0; else p.next = 0; return { ok: true, liberado: b }; }
  let real;
  try { real = await fsp.realpath(ruta); } catch { return { ok: false, mensaje: 'no longer exists.' }; }
  if (!dentroDeHome(real)) return { ok: false, mensaje: 'is outside your home folder.' };
  if (!(await existe(path.join(real, 'package.json')))) return { ok: false, mensaje: 'has no package.json.' };
  const objetivo = path.join(real, que);
  let st;
  try { st = await fsp.lstat(objetivo); } catch { if (que === 'node_modules') p.nm = 0; else p.next = 0; return { ok: true, liberado: 0 }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, mensaje: `has ${que} as a link. I leave it alone.` };
  const antes = que === 'node_modules' ? p.nm : p.next;
  if (path.basename(barrera(objetivo, { minProfundidad: 2 })) !== que) throw new Error('Safety check: unexpected folder');
  await fsp.rm(objetivo, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  if (que === 'node_modules') p.nm = 0; else p.next = 0;
  return { ok: true, liberado: antes };
}

async function limpiarProyectos(rutas, motivo, { anotar = true, procs, que = ['node_modules', '.next'] } = {}) {
  if (procs === undefined) procs = await procesosConCarpeta();
  let liberado = 0;
  const hechos = [], errores = [], volver = [];
  for (const ruta of rutas) {
    const p = (estado.proyectos?.lista || []).find(x => x.ruta === ruta);
    const cmd = p ? comandoVolver(p) : null;
    let suma = 0, fallo = null, sinDeps = false;
    for (const q of que) {
      const r = await borrarDeProyecto(ruta, q, procs);
      if (!r.ok) { fallo = r.mensaje; break; }
      suma += r.liberado || 0;
      if (q === 'node_modules' && r.liberado) sinDeps = true;
    }
    liberado += suma;
    const nombre = path.basename(ruta);
    if (fallo) errores.push(`${nombre} ${fallo}`); else hechos.push({ nombre, bytes: suma });
    if (sinDeps && cmd) volver.push({ nombre, ruta, ...cmd });
  }
  if (estado.proyectos) estado.proyectos.lista = estado.proyectos.lista.filter(p => p.nm + p.next > 0);
  await medirSeguimientoCalculado();
  if (anotar && hechos.length) await registrar({ tipo: motivo, liberado, detalle: hechos.map(h => h.nombre), errores, volver });
  await guardarEstado();
  return { liberado, hechos, errores, volver };
}

async function medirSeguimientoCalculado() {
  const lista = estado.proyectos?.lista || [];
  estado.seg.deps = { existe: lista.some(p => p.nm > 0), bytes: lista.reduce((s, p) => s + (p.nm || 0), 0), t: Date.now() };
  estado.seg.next = { existe: lista.some(p => p.next > 0), bytes: lista.reduce((s, p) => s + (p.next || 0), 0), t: Date.now() };
}

async function ejecutarLimpieza(auto, conDeps = false) {
  if (!DEMO) await detectarUsos();
  const plan = planLimpieza();
  const procs = await procesosConCarpeta();
  let liberado = 0;
  const partes = [], errores = [], volver = [];
  if (plan.npm) {
    const r = await vaciarNpm();
    if (r.ok) { liberado += r.liberado; partes.push('npm cache'); } else errores.push(r.mensaje);
  }
  // justo antes de borrar se comprueba otra vez que el proyecto sigue parado
  const sigueParado = async (ruta) => { if (DEMO) return true; const t = await ultimaVez(ruta); return !(t && Date.now() - t <= config.diasParado * DIA); };
  const filtrar = async (l) => { const res = []; for (const p of l) if (await sigueParado(p.ruta)) res.push(p.ruta); return res; };
  const rutasNext = await filtrar(plan.next);
  if (rutasNext.length) {
    const r = await limpiarProyectos(rutasNext, 'limpieza', { anotar: false, procs, que: ['.next'] });
    liberado += r.liberado; errores.push(...r.errores);
    if (r.hechos.length) partes.push(`${r.hechos.length} ${r.hechos.length === 1 ? 'Next.js build' : 'Next.js builds'}`);
  }
  if (!auto && conDeps) {
    const rutasDeps = await filtrar(plan.deps);
    if (rutasDeps.length) {
      const r = await limpiarProyectos(rutasDeps, 'limpieza', { anotar: false, procs, que: ['node_modules'] });
      liberado += r.liberado; errores.push(...r.errores); volver.push(...r.volver);
      if (r.hechos.length) partes.push(`dependencies of ${r.hechos.length} ${r.hechos.length === 1 ? 'project' : 'projects'}`);
    }
  }
  if (!DEMO) estado.disco = await medirDisco().catch(() => estado.disco);
  const unicos = [...new Set(errores)];
  errores.length = 0; errores.push(...unicos);
  if (liberado > 0 || errores.length) await registrar({ tipo: auto ? 'limpieza-auto' : 'limpieza', liberado, detalle: partes, errores, volver });
  if (auto) { config.ultimaLimpieza = Date.now(); await guardarConfig(); }
  await guardarEstado();
  return { ok: errores.length === 0, liberado, partes, errores, volver };
}

async function limpiezaAutoSiToca() {
  if (!config.limpiezaAuto || DEMO) return;
  const prox = proximaLimpieza();
  if (!prox || Date.now() < prox) return;
  if (!estado.proyectos || Date.now() - estado.proyectos.t > 2 * DIA) await escaneoCompleto('before cleanup');
  const r = await ejecutarLimpieza(true, false);
  if (r.liberado > 50e6) notificar('Weekly cleanup done', `Freed ${gbTexto(r.liberado)}: ${r.partes.join(' and ')}.`);
  log('automatic cleanup', JSON.stringify(r));
}

// ---------------------------------------------------------------- qué es cada cosa y qué se puede borrar

// Explicación de carpetas conocidas, por ruta dentro de tu carpeta. Nivel: rehace (se rehace sola),
// tuyo (es tuyo: revísalo), no (de macOS o de una app: no se toca desde aquí).
const EXPLICA = new Map(Object.entries({
  'Library': ['Internal data of your apps and of macOS. Look inside, but almost nothing here is deleted by hand.', 'no'],
  'Desktop': ['What is on your Desktop.', 'tuyo'],
  'Documents': ['Your documents. Your projects usually live here.', 'tuyo'],
  'Downloads': ['What you downloaded. Usually lots of leftovers: installers, zips, videos.', 'tuyo'],
  'Pictures': ['Your pictures. The Photos library lives here too.', 'tuyo'],
  'Movies': ['Videos and iMovie or Final Cut libraries.', 'tuyo'],
  'Music': ['Music and audio libraries.', 'tuyo'],
  'Public': ['Folder for network sharing. Almost always empty.', 'tuyo'],
  'Applications': ['Apps installed only for your user, like web apps (Fast Atlas included).', 'no'],
  '.npm': ['npm cache. Empty it with its button in What grows on its own.', 'rehace'],
  '.cache': ['Caches of dev and AI tools. They are downloaded again when needed.', 'rehace'],
  '.nvm': ['Node versions installed with nvm. Remove the ones you do not use with nvm uninstall.', 'no'],
  '.claude': ['Claude Code history and settings.', 'no'],
  '.Trash': ['The Trash. Everything here takes up space until you empty it.', 'tuyo'],
  '.ssh': ['Your keys to log into servers. Never delete this.', 'no'],
  '.config': ['Settings of command line tools.', 'no'],
  '.vscode': ['VS Code extensions.', 'no'],
  '.cursor': ['Cursor extensions and data.', 'no'],
  '.docker': ['Docker settings.', 'no'],
  '.ollama': ['Ollama AI models. Remove them with ollama rm.', 'no'],
  '.lmstudio': ['LM Studio AI models. Remove them from the app.', 'no'],
  '.local': ['Programs and data of command line tools.', 'no'],
  '.bun': ['Bun and its packages.', 'no'],
  '.cargo': ['Rust and its packages.', 'no'],
  '.rustup': ['Rust versions.', 'no'],
  '.pyenv': ['Python versions.', 'no'],
  '.gradle': ['Android and Java tools.', 'no'],
  '.zsh_sessions': ['History of your Terminal windows.', 'no'],
  '.fastweb-maquina': ['Fast Atlas (previous version): the program, its history and settings.', 'no'],
  'Library/Application Support': ['Your apps’ data: settings, databases and internal downloads.', 'no'],
  'Library/Caches': ['Your apps’ caches. They rebuild themselves: delete them with the app closed.', 'rehace'],
  'Library/Developer': ['Xcode: simulators and builds. DerivedData can be emptied from Xcode.', 'no'],
  'Library/Logs': ['App and macOS logs. Usually small.', 'no'],
  'Library/Preferences': ['Your apps’ settings. Never touched.', 'no'],
  'Library/Mail': ['Your email in the Mail app.', 'no'],
  'Library/Messages': ['Your messages and their attachments.', 'no'],
  'Library/Safari': ['Safari data.', 'no'],
  'Library/Keychains': ['Your passwords. Never touched.', 'no'],
  'Library/LaunchAgents': ['Programs that start on their own. The Fast Atlas one is here.', 'no'],
  'Library/Fonts': ['Fonts you installed.', 'no'],
  'Library/Saved Application State': ['Windows macOS reopens when you open each app.', 'no'],
  'Library/Metadata': ['Spotlight search indexes.', 'no'],
  'Library/Cookies': ['Browser and app cookies.', 'no'],
  'Library/WebKit': ['Data of websites opened from apps.', 'no'],
  'Library/HTTPStorages': ['Apps’ connection data.', 'no'],
  'Library/Photos': ['Photos app data.', 'no'],
  'Library/Calendars': ['Your calendars.', 'no'],
  'Library/Application Support/Claude': ['The Claude desktop app. The Cowork disk is here.', 'no'],
  'Library/Application Support/Claude/vm_bundles': ['The Cowork disk. Reset it from What grows on its own.', 'no'],
  'Library/Application Support/Google': ['Chrome: profiles, history and extensions.', 'no'],
  'Library/Application Support/Code': ['VS Code: settings and data.', 'no'],
  'Library/Application Support/Cursor': ['Cursor: settings and data.', 'no'],
  'Library/Application Support/Slack': ['Slack: messages and saved files.', 'no'],
  'Library/Application Support/Spotify': ['Spotify: songs downloaded to listen offline.', 'no'],
  'Library/Application Support/Figma': ['Figma: app data.', 'no'],
  'Library/Application Support/Blender': ['Blender: settings and add-ons.', 'no'],
  'Library/Application Support/MobileSync': ['Backups of your iPhone or iPad. Manage them from Finder with the device connected.', 'no'],
  'Library/Application Support/CrashReporter': ['App crash reports.', 'no'],
  'Library/Caches/Google': ['Chrome cache. It rebuilds itself: delete it with Chrome closed.', 'rehace'],
  'Library/Caches/com.spotify.client': ['Spotify cache: songs you already played. It rebuilds.', 'rehace'],
  'Library/Caches/ms-playwright': ['Playwright test browsers. Downloaded again when needed.', 'rehace'],
  'Library/Caches/Homebrew': ['Homebrew downloads already installed. Not needed.', 'rehace'],
  'Library/Caches/pip': ['Python (pip) cache. It rebuilds.', 'rehace'],
  'Library/Caches/Yarn': ['Yarn cache. It rebuilds.', 'rehace'],
  'Library/Caches/pnpm': ['pnpm cache. It rebuilds.', 'rehace'],
  'Library/Caches/node-gyp': ['Files to compile Node modules. They rebuild.', 'rehace'],
  'Library/Caches/typescript': ['TypeScript cache. It rebuilds.', 'rehace'],
  'Library/Caches/JetBrains': ['JetBrains editors’ caches. They rebuild.', 'rehace'],
  'Library/Caches/Cypress': ['Cypress versions for testing. Downloaded again when needed.', 'rehace'],
  '.cache/huggingface': ['Hugging Face models and datasets. Downloaded again if something needs them.', 'rehace'],
  '.cache/puppeteer': ['Puppeteer browsers. Downloaded again when needed.', 'rehace'],
  '.cache/ms-playwright': ['Playwright test browsers. Downloaded again when needed.', 'rehace'],
}));
const TIPOS_ARCHIVO = [
  [/\.(dmg|pkg)$/i, 'Installer: if the app is already installed, you do not need it.'],
  [/\.(iso|img)$/i, 'Disk image.'],
  [/\.(zip|rar|7z|tar|gz|tgz|xz)$/i, 'Archive: if you already unzipped it, you probably do not need it.'],
  [/\.(mov|mp4|mkv|avi|m4v|webm|mxf)$/i, 'Video.'],
  [/\.(wav|aif|aiff|flac|mp3|m4a)$/i, 'Audio.'],
  [/\.(safetensors|gguf|ckpt|pt|pth|onnx)$/i, 'AI model.'],
  [/\.blend\d*$/i, 'Blender project.'],
  [/\.(psd|psb|ai|fig|sketch|aep|prproj)$/i, 'Design file.'],
  [/\.(vmdk|vdi|qcow2|utm)$/i, 'Virtual disk.'],
  [/\.(pdf)$/i, 'PDF document.'],
  [/\.(jpg|jpeg|png|heic|tif|tiff|raw|cr2|cr3|nef|arw|dng)$/i, 'Image.'],
];
const BLOQ_RAIZ = new Set(['Library', 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', 'Public', 'Applications', 'Sites']);
const DENTRO_DE_PAQUETE = /\.(app|photoslibrary|bundle|framework|fcpbundle|lrlibrary|lrdata|musiclibrary|tvlibrary|imovielibrary|xcarchive|plugin|kext|band|logicx|aplibrary)\//i;

function explicar(ruta, esDir) {
  const rel = path.relative(HOME, ruta).split(path.sep).join('/');
  if (EXPLICA.has(rel)) { const [texto, nivel] = EXPLICA.get(rel); return { texto, nivel }; }
  const padre = path.posix.dirname(rel), nombre = path.posix.basename(rel);
  if (NO_MEDIR.has(ruta)) return { texto: NO_MEDIR.get(ruta), nivel: 'no' };
  if (nombre === 'node_modules') return { texto: 'A project’s dependencies. Delete them in Your projects.', nivel: 'no' };
  if (nombre === '.next') return { texto: 'A project’s Next.js build. Delete it in Your projects or with Clean now.', nivel: 'no' };
  if (nombre === '.git') return { texto: 'The project’s git history. Never touched.', nivel: 'no' };
  if (padre === 'Library/Caches') return nombre.startsWith('com.apple.') ? { texto: 'macOS cache. It manages itself.', nivel: 'no' } : { texto: `Cache of “${nombre}”. It rebuilds itself: delete it with that app closed.`, nivel: 'rehace' };
  if (padre === 'Library/Application Support') return nombre.startsWith('com.apple.') ? { texto: 'macOS data.', nivel: 'no' } : { texto: `Data of the “${nombre}” app. If you already uninstalled it, it is leftover: delete it from Finder.`, nivel: 'no' };
  if (padre === '.cache') return { texto: `Cache of “${nombre}”. Created again when needed.`, nivel: 'rehace' };
  if (rel === 'Library' || rel.startsWith('Library/')) return { texto: 'Data of macOS or of an app.', nivel: 'no' };
  const proyecto = (estado.proyectos?.lista || []).find(p => p.ruta === ruta);
  if (proyecto) return { texto: 'Project. Manage its dependencies and build in Your projects.', nivel: 'tuyo' };
  if (!esDir) { const t = TIPOS_ARCHIVO.find(([re]) => re.test(nombre)); if (t) return { texto: t[1], nivel: 'tuyo' }; }
  return null;
}

// Si algo NO se puede mandar a la Papelera desde el panel, devuelve el motivo. null = se puede.
function motivoNoBorrar(ruta) {
  const r = path.resolve(ruta);
  if (!dentroDeHome(r)) return 'Only things inside your home folder can be deleted from here.';
  const rel = path.relative(HOME, r);
  const partes = rel.split(path.sep);
  if (partes.length === 1) return BLOQ_RAIZ.has(partes[0]) ? 'It is one of your Mac’s main folders.' : 'It sits at the top of your home folder. Move it from Finder if you are sure.';
  if (partes[0] === 'Library') {
    if (partes[1] === 'Caches' && partes.length >= 3) return partes[2].startsWith('com.apple.') ? 'It is a macOS cache: it manages itself.' : null;
    return 'It is internal app or macOS data. It is not deleted from here.';
  }
  if (partes[0].startsWith('.')) {
    if (partes[0] === '.cache' && partes.length >= 2) return null;
    return 'It is a settings or tools folder. It is not deleted from here.';
  }
  // el paquete entero sí se puede mandar a la Papelera; lo de dentro, no
  if (DENTRO_DE_PAQUETE.test(path.dirname(rel) + '/')) return 'It is inside a package (an app or a photo or video library).';
  if (partes.includes('node_modules') || partes.includes('.next')) return 'Dependencies and builds are deleted in Your projects.';
  if (partes.includes('.git')) return 'It is a project’s git history: never touched.';
  for (const p of estado.proyectos?.lista || []) {
    if (!proteccion(p)) continue;
    if (r === p.ruta || r.startsWith(p.ruta + path.sep)) return 'It is locked: never touched.';
    if (p.ruta.startsWith(r + path.sep)) return 'There is a locked project inside.';
  }
  const usos = (estado.usos && estado.usos.lista) || [];
  const uso = usos.find(u => u.ruta === r || u.ruta.startsWith(r + path.sep) || r.startsWith(u.ruta + path.sep));
  if (uso) return `It is used by ${uso.motivo}.`;
  return null;
}

const TRASH_NATIVO = '/usr/bin/trash';
function hayTrashNativo() { return ES_MAC && fs.existsSync(TRASH_NATIVO); }
const SIN_PERMISO = /-1743|not authori[sz]ed|no autoriz/i;

// Manda algo a la Papelera de macOS (se puede recuperar hasta que la vacías).
async function aPapelera(ruta) {
  const r = path.resolve(String(ruta || ''));
  const motivo = motivoNoBorrar(r);
  if (motivo) return { ok: false, mensaje: motivo };
  let st;
  try { st = await fsp.lstat(r); } catch { return { ok: false, mensaje: 'It no longer exists.' }; }
  if (st.isDirectory()) {
    const abiertos = corriendoEn(await procesosConCarpeta(), r);
    if (abiertos.length) return { ok: false, mensaje: `Something is running inside (${abiertos.join(', ')}). Close it and try again.` };
  }
  const bytes = st.isDirectory() ? ((await du(r))?.bytes || 0) : ocupado(st);
  const nombre = path.basename(r);
  if (DEMO) return { ok: false, mensaje: 'Demo: nothing is touched.' };
  barrera(r, { minProfundidad: 2 });
  if (ES_MAC && !PRUEBAS) {
    if (hayTrashNativo()) await run(TRASH_NATIVO, [r], { timeout: 5 * MIN });
    if (fs.existsSync(r)) {
      const f = await run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', r], { timeout: 5 * MIN });
      if (fs.existsSync(r)) return { ok: false, mensaje: SIN_PERMISO.test(f.err) ? 'macOS did not allow using Finder. Turn it on in System Settings > Privacy & Security > Automation (node > Finder) and try again.' : 'macOS did not allow moving it to the Trash.' };
    }
  } else if (PRUEBAS) {
    await fsp.mkdir(P.papelera, { recursive: true });
    await fsp.rename(r, path.join(P.papelera, nombre + '-' + Date.now()));
  } else return { ok: false, mensaje: 'The Trash only works on a Mac.' };
  config.enPapelera = (config.enPapelera || 0) + bytes;
  await guardarConfig();
  await registrar({ tipo: 'papelera', liberado: 0, enviado: bytes, detalle: [nombre] });
  estado.carpetas.delete(path.dirname(r)); estado.carpetas.delete(r);
  if (estado.grandes) estado.grandes.lista = estado.grandes.lista.filter(g => g.ruta !== r && !g.ruta.startsWith(r + path.sep));
  for (const k of ['home', 'library']) if (estado[k]) estado[k].hijos = estado[k].hijos.filter(h => h.ruta !== r);
  await guardarEstado();
  return { ok: true, enviado: bytes, mensaje: `“${nombre}” is in the Trash (${gbTexto(bytes)}). The space is freed when you empty it.` };
}

async function vaciarPapelera() {
  if (DEMO) return { ok: false, mensaje: 'Demo: nothing is touched.' };
  if (PRUEBAS) {
    for (const n of await fsp.readdir(P.papelera).catch(() => [])) await fsp.rm(barrera(path.join(P.papelera, n), { minProfundidad: 2 }), { recursive: true, force: true });
    config.enPapelera = 0; await guardarConfig();
    return { ok: true, liberado: 0, mensaje: 'Trash emptied (test mode).' };
  }
  if (!ES_MAC) return { ok: false, mensaje: 'Emptying the Trash only works on a Mac.' };
  const antes = (await medirDisco()).libre;
  const r = await run('osascript', ['-e', 'tell application "Finder" to empty trash'], { timeout: 15 * MIN });
  if (r.code !== 0) return { ok: false, mensaje: SIN_PERMISO.test(r.err) ? 'macOS did not allow using Finder. Turn it on in System Settings > Privacy & Security > Automation (node > Finder) and try again.' : 'I could not empty it. You can do it from Finder: right-click the Trash in the Dock > Empty Trash.' };
  await espera(1500);
  estado.disco = await medirDisco();
  const liberado = Math.max(0, estado.disco.libre - antes);
  config.enPapelera = 0;
  await guardarConfig();
  await registrar({ tipo: 'papelera-vaciada', liberado, detalle: [] });
  return { ok: true, liberado, mensaje: `Trash emptied. Freed ${gbTexto(liberado)}.` };
}

// ---------------------------------------------------------------- Cowork

async function claudeAbierto() {
  const r = await run('pgrep', ['-x', 'Claude'], { timeout: 8000 });
  return r.code === 0;
}
async function enUso(f) {
  const r = await run('lsof', ['-t', f], { timeout: 60000 });
  if (r.falta) return null;
  return r.out.trim().length > 0;
}
async function listarRespaldos() {
  try {
    const ents = await fsp.readdir(RESPALDOS);
    const res = [];
    for (const n of ents) {
      if (!/^cowork-rootfs-[\w-]+\.img$/.test(n)) continue;
      const st = await fsp.lstat(path.join(RESPALDOS, n)).catch(() => null);
      if (st) res.push({ archivo: n, bytes: ocupado(st), t: st.mtimeMs, rehecho: n.includes('-rehecho-') });
    }
    return res.sort((a, b) => b.t - a.t);
  } catch { return []; }
}
async function estadoCowork() {
  if (DEMO) return estado.cowork;
  const c = { disponible: ES_MAC || PRUEBAS };
  c.existe = await existe(P.bundle);
  let st = null;
  try { st = await fsp.lstat(P.rootfs); } catch {}
  c.disco = st ? ocupado(st) : 0;
  c.base = await existe(P.base);
  c.claudeAbierto = c.disponible ? await claudeAbierto() : false;
  c.enUso = st && c.disponible && !c.claudeAbierto ? await enUso(P.rootfs) : null;
  c.respaldos = await listarRespaldos();
  c.t = Date.now();
  estado.cowork = c;
  return c;
}
function marcaTiempo() {
  const d = new Date(); const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
async function comprobarCoworkLibre(c) {
  if (!c.disponible) return 'This only works on a Mac.';
  if (c.claudeAbierto) return 'Claude is still open. Quit it completely (Cmd+Q in the desktop app) and try again.';
  if (c.enUso === null && (await existe(P.rootfs))) return 'I cannot check whether the Cowork disk is in use, so I leave it alone.';
  if (c.enUso) return 'The Cowork disk is still in use. Wait a few seconds after quitting Claude and try again.';
  return null;
}
async function reiniciarCowork() {
  if (DEMO) return { ok: false, mensaje: 'Demo: nothing is touched.' };
  const c = await estadoCowork();
  if (!c.disco) return { ok: false, mensaje: 'There is no Cowork disk to reset.' };
  const bloqueo = await comprobarCoworkLibre(c);
  if (bloqueo) return { ok: false, mensaje: bloqueo };
  const destino = path.join(RESPALDOS, `cowork-rootfs-${marcaTiempo()}.img`);
  barrera(P.rootfs, { minProfundidad: 5 }); barrera(destino, { enDatos: true });
  try { await fsp.rename(P.rootfs, destino); }
  catch (e) { return { ok: false, mensaje: e.code === 'EXDEV' ? 'The backup would have to go to another disk and take too long. I will not do it.' : 'Could not move it: ' + e.message }; }
  await registrar({ tipo: 'cowork-reinicio', liberado: 0, detalle: [`backup of ${gbTexto(c.disco)}`] });
  await estadoCowork();
  return { ok: true, mensaje: `Done. The backup (${gbTexto(c.disco)}) is kept until you delete it.` };
}
async function restaurarCowork(archivo) {
  if (DEMO) return { ok: false, mensaje: 'Demo: nothing is touched.' };
  if (!/^cowork-rootfs-[\w-]+\.img$/.test(archivo || '')) return { ok: false, mensaje: 'Invalid backup.' };
  const origen = path.join(RESPALDOS, archivo);
  if (!(await existe(origen))) return { ok: false, mensaje: 'That backup no longer exists.' };
  const c = await estadoCowork();
  const bloqueo = await comprobarCoworkLibre(c);
  if (bloqueo) return { ok: false, mensaje: bloqueo };
  if (!(await existe(P.bundle))) return { ok: false, mensaje: 'I cannot find the Cowork folder to put it back.' };
  barrera(P.rootfs, { minProfundidad: 5 }); barrera(origen, { enDatos: true });
  if (await existe(P.rootfs)) await fsp.rename(P.rootfs, barrera(path.join(RESPALDOS, `cowork-rootfs-rehecho-${marcaTiempo()}.img`), { enDatos: true }));
  await fsp.rename(origen, P.rootfs);
  await registrar({ tipo: 'cowork-restaurado', liberado: 0, detalle: [archivo] });
  await estadoCowork();
  return { ok: true, mensaje: 'Restored. Cowork is back to how it was before the reset.' };
}
async function borrarRespaldo(archivo) {
  if (DEMO) return { ok: false, mensaje: 'Demo: nothing is touched.' };
  if (!/^cowork-rootfs-[\w-]+\.img$/.test(archivo || '')) return { ok: false, mensaje: 'Invalid backup.' };
  const f = barrera(path.join(RESPALDOS, archivo), { enDatos: true });
  const st = await fsp.lstat(f).catch(() => null);
  if (!st) return { ok: false, mensaje: 'That backup no longer exists.' };
  await fsp.rm(f, { force: true });
  await registrar({ tipo: 'cowork-copia-borrada', liberado: ocupado(st), detalle: [archivo] });
  estado.disco = await medirDisco().catch(() => estado.disco);
  await estadoCowork();
  return { ok: true, liberado: ocupado(st), mensaje: `Backup deleted. Freed ${gbTexto(ocupado(st))}.` };
}

// ---------------------------------------------------------------- Finder

async function abrirEnFinder(ruta) {
  if (!ruta || !permitidaParaMirar(ruta)) return { ok: false, mensaje: 'I only open your folders or Applications.' };
  const real = path.resolve(ruta);
  let st;
  try { st = await fsp.lstat(real); } catch { return { ok: false, mensaje: 'That path no longer exists.' }; }
  if (!ES_MAC || PRUEBAS) return { ok: true, mensaje: 'Opening in Finder only works on a Mac.' };
  const paquete = /\.(app|bundle|photoslibrary|framework|plugin|appex|pkg)$/i.test(real);
  const args = st.isDirectory() && !paquete ? [real] : ['-R', real];
  const r = await run('open', args, { timeout: 15000 });
  return r.code === 0 ? { ok: true } : { ok: false, mensaje: 'Could not open Finder.' };
}

// ---------------------------------------------------------------- RAM

function nombreApp(comm) {
  const i = comm.indexOf('.app/');
  if (i > 0) { const antes = comm.slice(0, i); return antes.slice(antes.lastIndexOf('/') + 1); }
  if (comm.endsWith('.app')) return path.basename(comm, '.app');
  const base = path.basename(comm);
  if (['node', 'claude', 'python3', 'python', 'bun', 'deno', 'ollama', 'docker', 'com.docker.backend', 'qemu-system-aarch64', 'vfkit'].includes(base)) return base;
  if (!comm.includes('/') || /^\/(System|usr|sbin|bin|Library\/Apple|private)\//.test(comm)) return 'macOS';
  return base;
}
const ETIQUETA_APP = { macOS: 'macOS and its services', node: 'Node (projects and tools)', claude: 'Claude Code', 'com.docker.backend': 'Docker', vfkit: 'Virtual machine (Cowork or Docker)', 'qemu-system-aarch64': 'Virtual machine' };

async function medirRam() {
  if (DEMO) return estado.ram;
  if (estado.ram && Date.now() - estado.ram.t < 3000) return estado.ram;
  const total = os.totalmem();
  let usada = total - os.freemem(), swap = null, comprimida = 0;
  if (ES_MAC) {
    const v = await run('vm_stat', [], { timeout: 8000 });
    const pagina = Number((v.out.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
    const leer = (et) => { const m = v.out.match(new RegExp('^' + et + ':\\s+(\\d+)', 'm')); return m ? Number(m[1]) * pagina : 0; };
    const anon = leer('Anonymous pages'), purgable = leer('Pages purgeable'), cableada = leer('Pages wired down');
    comprimida = leer('Pages occupied by compressor');
    const calc = anon ? (anon - purgable) + cableada + comprimida : leer('Pages active') + cableada + comprimida;
    if (calc > 0) usada = Math.min(total, calc);
    const s = await run('sysctl', ['-n', 'vm.swapusage'], { timeout: 8000 });
    const m = s.out.match(/total = ([\d.,]+)([MG]).*?used = ([\d.,]+)([MG])/);
    if (m) { const u = (n, x) => parseFloat(n.replace(',', '.')) * (x === 'G' ? 1073741824 : 1048576); swap = { total: u(m[1], m[2]), usada: u(m[3], m[4]) }; }
  } else {
    const txt = await fsp.readFile('/proc/meminfo', 'utf8').catch(() => '');
    const kv = k => Number((txt.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')) || [])[1] || 0) * 1024;
    if (kv('MemAvailable')) usada = kv('MemTotal') - kv('MemAvailable');
    swap = { total: kv('SwapTotal'), usada: kv('SwapTotal') - kv('SwapFree') };
  }
  const p = await run('ps', ['-axo', 'rss=,comm='], { timeout: 8000 });
  const grupos = new Map();
  for (const linea of p.out.split('\n')) {
    const m = linea.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const nombre = nombreApp(m[2].trim());
    const g = grupos.get(nombre) || { nombre, etiqueta: ETIQUETA_APP[nombre] || nombre, bytes: 0, procesos: 0 };
    g.bytes += Number(m[1]) * 1024; g.procesos++;
    grupos.set(nombre, g);
  }
  const apps = [...grupos.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  estado.ram = { total, usada, comprimida, swap, apps, t: Date.now() };
  return estado.ram;
}

// ---------------------------------------------------------------- vistas para el panel

function reparto() {
  const d = estado.disco;
  if (!d || !estado.home) return null;
  const cowork = estado.seg.cowork?.existe ? estado.seg.cowork.bytes : 0;
  const depsPorHijo = new Map(); let deps = 0;
  for (const p of estado.proyectos?.lista || []) {
    const raiz = path.relative(HOME, p.ruta).split(path.sep)[0];
    const b = (p.nm || 0) + (p.next || 0);
    depsPorHijo.set(raiz, (depsPorHijo.get(raiz) || 0) + b);
    deps += b;
  }
  let enHome = 0, npm = 0;
  const resto = [];
  for (const h of estado.home.hijos) {
    if (h.bytes == null) continue;
    enHome += h.bytes;
    let b = h.bytes;
    if (h.ruta === P.library) b -= cowork;
    b -= depsPorHijo.get(h.nombre) || 0;
    if (h.ruta === P.npm) { npm = h.bytes; continue; }
    resto.push({ id: 'h:' + h.nombre, nombre: h.sueltos ? 'Loose files' : nombreBonito(h.ruta), bytes: Math.max(0, b), ruta: h.sueltos ? null : h.ruta });
  }
  resto.sort((a, b) => b.bytes - a.bytes);
  const segs = [];
  if (cowork) segs.push({ id: 'cowork', nombre: 'Cowork', bytes: cowork, ruta: P.vm, crece: true });
  if (deps) segs.push({ id: 'deps', nombre: 'Dependencies and builds', bytes: deps, ir: 'proyectos', crece: true });
  if (npm) segs.push({ id: 'npm', nombre: 'npm cache', bytes: npm, ruta: P.npm, crece: true });
  const principales = resto.slice(0, 5), otros = resto.slice(5);
  segs.push(...principales);
  const sumaOtros = otros.reduce((s, x) => s + x.bytes, 0);
  if (sumaOtros > 0) segs.push({ id: 'otros', nombre: 'Your other folders', bytes: sumaOtros, ruta: HOME, incluye: otros.map(x => x.id) });
  const apps = estado.apps?.bytes || 0;
  if (apps) segs.push({ id: 'apps', nombre: 'Applications', bytes: apps, ruta: P.apps });
  const purgable = d.purgable || 0;
  segs.push({ id: 'sistema', nombre: 'System and protected', bytes: Math.max(0, d.usado - enHome - apps - purgable), nota: 'macOS, swap, local Time Machine snapshots and folders macOS does not let anyone measure (Photos, Mail, App Store app data).' });
  if (purgable >= 0.5e9) segs.push({ id: 'purgable', nombre: 'Purgeable', bytes: purgable, purgable: true });
  segs.push({ id: 'libre', nombre: 'Free', bytes: d.libre, libre: true });
  const FIJAS = {
    cowork: 'the Cowork disk. It grows with every task and never gives space back.',
    deps: 'the node_modules and .next folders of your projects. They can be rebuilt.',
    npm: 'copies of packages you already downloaded. Safe to empty.',
    otros: 'your smaller folders, grouped.',
    apps: 'the apps in your Applications folder.',
    sistema: 'macOS, swap and what macOS does not let anyone measure (Photos, Mail, App Store app data).',
    purgable: 'space macOS counts as free because it releases it on its own when needed.',
    libre: 'truly free space, right now.',
  };
  for (const sg of segs) {
    if (FIJAS[sg.id]) sg.explica = FIJAS[sg.id];
    else if (sg.ruta) { const ex = explicar(sg.ruta, true); sg.explica = ex ? ex.texto.charAt(0).toLowerCase() + ex.texto.slice(1) : 'a folder of yours.'; }
    else sg.explica = 'loose files in your home folder.';
  }
  return segs;
}

function segDeClave(clave, segs) {
  if (!segs) return null;
  const hay = (id) => segs.some(s => s.id === id);
  const mapa = { 'seg:cowork': 'cowork', 'seg:deps': 'deps', 'seg:next': 'deps', 'seg:npm': 'npm' };
  if (mapa[clave] && hay(mapa[clave])) return mapa[clave];
  let id = null;
  if (clave.startsWith('home:')) id = 'h:' + clave.slice(5);
  else if (clave.startsWith('seg:')) {
    const r = SEG_POR_ID.get(clave.slice(4))?.ruta?.();
    if (r && dentroDeHome(r)) id = 'h:' + path.relative(HOME, r).split(path.sep)[0];
  }
  if (!id) return null;
  if (hay(id)) return id;
  if (segs.some(s => s.id === 'otros' && s.incluye?.includes(id))) return 'otros';
  return null;
}

function titular(segs, crec) {
  const d = estado.disco;
  if (!d) return { l1: 'Looking at your Mac.', l2: 'Give me a couple of minutes.', sub: 'The first scan measures the whole disk. The next ones are faster.', seg: null };
  const disp = d.disponible ?? d.libre;
  const l1 = `You have ${gbCorto(disp)} left.`;
  const usoMac = d.total - disp;
  const purg = (d.purgable || 0) >= 1e9 ? ` Of the ${gbCorto(disp)} left, ${gbCorto(d.purgable)} is purgeable: macOS frees it on its own when it needs the space.` : '';
  const dias = crec.desde ? Math.max(1, Math.round((Date.now() - crec.desde) / DIA)) : null;
  const top = crec.lista.find(x => x.delta >= 1e9);
  let l2, sub, clave = null;
  if (top) {
    l2 = `${top.corto} grew ${gbCorto(top.delta)}.`;
    sub = `That's in the last ${dias === 1 ? 'day' : `${dias} days`}. You're using ${gbCorto(usoMac)} of ${gbCorto(d.total)}.${purg}`;
    clave = top.clave;
  } else {
    const candidatos = ['cowork', 'deps', 'npm'].map(id => ({ id, def: SEG_POR_ID.get(id), s: estado.seg[id] })).filter(x => x.s?.existe && x.s.bytes >= 1e9).sort((a, b) => b.s.bytes - a.s.bytes);
    if (candidatos.length) {
      const c = candidatos[0];
      l2 = `${c.def.corto} ${c.def.plural ? 'take up' : 'takes up'} ${gbCorto(c.s.bytes)}.`;
      clave = 'seg:' + c.id;
    } else l2 = 'Nothing odd is growing.';
    sub = `You're using ${gbCorto(usoMac)} of ${gbCorto(d.total)}.${purg}${crec.desde ? '' : ' Tomorrow I can tell you what is growing.'}`;
  }
  return { l1, l2, sub, seg: clave ? segDeClave(clave, segs) : null, clave };
}
function gbCorto(b) {
  const g = b / 1e9;
  if (g >= 10) return Math.round(g).toLocaleString('en-US') + ' GB';
  if (g >= 1) return g.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' GB';
  return Math.round(b / 1e6).toLocaleString('en-US') + ' MB';
}

function vistaSeguimiento(crec) {
  const deltas = new Map(crec.lista.filter(x => x.seg).map(x => [x.seg, x.delta]));
  return SEGUIMIENTO.filter(def => {
    if (def.soloMac && !ES_MAC && !PRUEBAS && !DEMO) return false;
    const s = estado.seg[def.id];
    if (def.opcional) return s?.existe && s.bytes > 0;
    return true;
  }).map(def => {
    const s = estado.seg[def.id] || {};
    return {
      id: def.id, nombre: def.nombre, que: def.que, siLimpias: def.siLimpias, nivel: def.nivel, accion: def.accion,
      ruta: def.ruta ? def.ruta() : null, existe: !!s.existe, bytes: s.bytes ?? null, parcial: !!s.parcial, t: s.t || null,
      delta: deltas.has(def.id) ? deltas.get(def.id) : null,
    };
  }).sort((a, b) => (ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel]) || ((b.delta ?? -Infinity) - (a.delta ?? -Infinity)) || ((b.bytes || 0) - (a.bytes || 0)));
}
const ORDEN_NIVEL = { rehace: 0, revisar: 1, mirar: 2 };

// Proyectos a los que se les borró node_modules en los últimos 30 días y aún no se recuperaron.
function paraVolver() {
  const corte = Date.now() - 30 * DIA;
  const conDeps = new Set((estado.proyectos?.lista || []).filter(p => p.nm > 0).map(p => p.ruta));
  const vistos = new Map();
  for (const r of estado.registro) {
    if (r.t < corte || !Array.isArray(r.volver)) continue;
    for (const v of r.volver) if (!conDeps.has(v.ruta)) vistos.set(v.ruta, { ...v, t: r.t });
  }
  return [...vistos.values()].sort((a, b) => b.t - a.t).slice(0, 20);
}

function vistaEstado() {
  const segs = reparto();
  const crec = crecimiento();
  const plan = planLimpieza();
  const lista = (estado.proyectos?.lista || []).slice().sort((a, b) => (b.nm + b.next) - (a.nm + a.next));
  const corte = Date.now() - 30 * DIA;
  return {
    version: VERSION, ahora: Date.now(), puerto: PUERTO, demo: DEMO,
    maquina: estado.maquina,
    disco: estado.disco,
    escaneo: estado.escaneo, tCompleto: estado.tCompleto, tRapido: estado.tRapido, error: estado.ultimoError,
    titular: titular(segs, crec),
    reparto: segs,
    seguimiento: vistaSeguimiento(crec),
    proyectos: estado.proyectos ? { t: estado.proyectos.t, lista: lista.map(p => ({ ...p, ...comandoVolver(p), proteccion: proteccion(p), usadoPor: motivosUso(p.ruta) })) } : null,
    volver: paraVolver(),
    grandes: estado.grandes ? { t: estado.grandes.t, lista: estado.grandes.lista.map(g => ({ ...g, noBorrar: motivoNoBorrar(g.ruta) })) } : null,
    papelera: { enviado: config.enPapelera || 0, nativo: hayTrashNativo(), esMac: ES_MAC },
    crecimiento: { desde: crec.desde, lista: crec.lista.filter(x => x.delta >= 50e6).slice(0, 6) },
    historia: {
      libre: estado.serieLibre.filter(x => x.t >= corte).map(x => [x.t, x.libre]),
      eventos: estado.registro.filter(x => x.t >= corte && x.liberado > 50e6).map(x => ({ t: x.t, liberado: x.liberado, tipo: x.tipo })),
    },
    config: { limpiezaAuto: config.limpiezaAuto, diasParado: config.diasParado, avisoPct: config.avisoPct },
    limpieza: { proxima: proximaLimpieza(), ultima: config.ultimaLimpieza, plan },
    registro: estado.registro.slice(-8).reverse(),
    cowork: estado.cowork,
    tm: estado.tm,
    home: HOME,
  };
}

async function vistaCarpeta(ruta) {
  const real = path.resolve(ruta || HOME);
  if (!permitidaParaMirar(real)) return { ok: false, mensaje: 'I only look inside your home folder or Applications.' };
  const raiz = real === P.apps || real.startsWith(P.apps + path.sep) ? P.apps : HOME;
  const migas = [];
  let cur = real;
  while (true) {
    migas.unshift({ nombre: cur === HOME ? 'Home' : nombreBonito(cur), ruta: cur });
    if (cur === raiz || cur === path.dirname(cur)) break;
    cur = path.dirname(cur);
  }
  const base = { ok: true, ruta: real, migas, nota: NO_MEDIR.get(real) || null };
  if (NO_MEDIR.has(real)) return { ...base, hijos: [] };
  const decorar = (hijos) => hijos.map(h => {
    if (h.sueltos) return { ...h, etiqueta: null };
    const ex = explicar(h.ruta, h.dir);
    return {
      ...h,
      etiqueta: ETIQUETAS_RUTA.get(h.ruta) || (path.dirname(h.ruta) === HOME && NOMBRES[h.nombre]) || null,
      seg: SEGUIMIENTO.find(s => s.ruta && s.ruta() === h.ruta)?.id || null,
      explica: ex ? ex.texto : null, nivel: ex ? ex.nivel : null,
      noBorrar: h.noMedido ? 'It cannot be measured or deleted from here.' : motivoNoBorrar(h.ruta),
    };
  });
  if (real === HOME && estado.home) return { ...base, hijos: decorar(estado.home.hijos), t: estado.home.t };
  if (real === P.library && estado.library) return { ...base, hijos: decorar(estado.library.hijos), t: estado.library.t };
  if (DEMO) return { ...base, hijos: [], t: Date.now() };
  const c = estado.carpetas.get(real);
  if (c && (c.pendiente || Date.now() - c.t < 30 * MIN)) return { ...base, hijos: c.hijos ? decorar(c.hijos) : null, pendiente: !!c.pendiente, error: c.error, t: c.t };
  const trabajo = { pendiente: true, t: Date.now(), hijos: null };
  estado.carpetas.set(real, trabajo);
  if (estado.carpetas.size > 60) estado.carpetas.delete(estado.carpetas.keys().next().value);
  medirHijos(real).then(r => { trabajo.hijos = r.hijos; trabajo.error = r.error; }).catch(e => { trabajo.error = String(e.message); }).finally(() => { trabajo.pendiente = false; trabajo.t = Date.now(); });
  return { ...base, hijos: null, pendiente: true };
}

// ---------------------------------------------------------------- acciones

let accionEnCurso = false;
async function accion(b) {
  const tipo = b && b.tipo;
  if (tipo === 'escanear') {
    if (estado.escaneo.enCurso) return { ok: true, mensaje: 'Already scanning.' };
    escaneoCompleto('manual');
    return { ok: true, mensaje: 'Scanning. It takes a few minutes.' };
  }
  if (tipo === 'finder') return abrirEnFinder(b.ruta);
  if (tipo === 'cowork-estado') return { ok: true, cowork: await estadoCowork() };
  if (tipo === 'proteger') {
    const p = (estado.proyectos?.lista || []).find(x => x.ruta === b.ruta);
    if (!p) return { ok: false, mensaje: 'That project is not in the last scan.' };
    const quitar = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
    if (b.valor) { if (!config.protegidos.includes(p.ruta)) config.protegidos.push(p.ruta); quitar(config.permitidos, p.ruta); }
    else { quitar(config.protegidos, p.ruta); if (motivosUso(p.ruta).length && !config.permitidos.includes(p.ruta)) config.permitidos.push(p.ruta); }
    await guardarConfig();
    return { ok: true, mensaje: b.valor ? `${p.nombre}: never touched, neither by hand nor by the weekly cleanup.` : `${p.nombre}: unlocked.` };
  }
  if (accionEnCurso) return { ok: false, mensaje: 'Wait for the previous action to finish.' };
  accionEnCurso = true;
  try {
    if (tipo === 'npm') {
      const r = await vaciarNpm();
      if (r.ok) await registrar({ tipo: 'npm', liberado: r.liberado, detalle: ['npm cache'] });
      estado.disco = await medirDisco().catch(() => estado.disco);
      return r.ok ? { ok: true, liberado: r.liberado, mensaje: `npm cache emptied. Freed ${gbTexto(r.liberado)}.` } : r;
    }
    if (tipo === 'borrar-proyectos') {
      const rutas = Array.isArray(b.rutas) ? b.rutas.filter(x => typeof x === 'string').slice(0, 500) : [];
      if (!rutas.length) return { ok: false, mensaje: 'No projects selected.' };
      const r = await limpiarProyectos(rutas, 'proyectos');
      estado.disco = await medirDisco().catch(() => estado.disco);
      if (!r.hechos.length) return { ok: false, liberado: 0, mensaje: 'Nothing was deleted. ' + r.errores.join(' ') };
      const msg = `Freed ${gbTexto(r.liberado)} in ${r.hechos.length} ${r.hechos.length === 1 ? 'project' : 'projects'}.`;
      return { ok: r.errores.length === 0, liberado: r.liberado, volver: r.volver, mensaje: r.errores.length ? msg + ' Could not do: ' + r.errores.join(' ') : msg };
    }
    if (tipo === 'limpiar') {
      const r = await ejecutarLimpieza(false, b.dependencias === true);
      const salto = r.errores.length ? ' Skipped: ' + r.errores.join(' ') : '';
      return { ok: r.liberado > 0 || !r.errores.length, liberado: r.liberado, volver: r.volver, mensaje: r.liberado > 0 ? `Freed ${gbTexto(r.liberado)}.${salto}` : (salto.trim() || 'There was nothing to clean.') };
    }
    if (tipo === 'papelera') return await aPapelera(b.ruta);
    if (tipo === 'vaciar-papelera') return await vaciarPapelera();
    if (tipo === 'cowork-reiniciar') return await reiniciarCowork();
    if (tipo === 'cowork-restaurar') return await restaurarCowork(b.archivo);
    if (tipo === 'cowork-borrar-copia') return await borrarRespaldo(b.archivo);
    return { ok: false, mensaje: 'Unknown action.' };
  } catch (e) {
    log('action', tipo, e.stack || e.message);
    return { ok: false, mensaje: 'Something failed: ' + e.message };
  } finally {
    accionEnCurso = false;
  }
}

async function cambiarConfig(b) {
  if (typeof b.limpiezaAuto === 'boolean') {
    config.limpiezaAuto = b.limpiezaAuto;
    if (b.limpiezaAuto && (!config.ultimaLimpieza || Date.now() - config.ultimaLimpieza > 7 * DIA)) config.ultimaLimpieza = Date.now();
  }
  if ([30, 60, 90].includes(b.diasParado)) config.diasParado = b.diasParado;
  if ([10, 15, 20].includes(b.avisoPct)) config.avisoPct = b.avisoPct;
  await guardarConfig();
  return { ok: true };
}

// ---------------------------------------------------------------- servidor

const HOSTS = new Set([`localhost:${PUERTO}`, `127.0.0.1:${PUERTO}`, `[::1]:${PUERTO}`]);
const ORIGENES = new Set([`http://localhost:${PUERTO}`, `http://127.0.0.1:${PUERTO}`, `http://[::1]:${PUERTO}`]);
const FUENTES = new Set(['Inter-400.woff2', 'Inter-700.woff2', 'SpaceGrotesk-700.woff2']);
const ICONOS = new Set(['app-1024.png', 'app-512.png', 'app-192.png', 'app-mascara-512.png']);

// La app instalable (como hace Hostinger con su panel): Safari > Archivo > Añadir al Dock, o Instalar en Chrome.
const MANIFIESTO = JSON.stringify({
  id: '/', name: 'Fast Atlas', short_name: 'Fast Atlas', lang: 'en', dir: 'ltr',
  description: 'A map of your Mac: what takes up disk and memory, what each thing is, and what is safe to remove.',
  start_url: '/', scope: '/', display: 'standalone', background_color: '#09090b', theme_color: '#09090b',
  icons: [
    { src: '/icons/app-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/app-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/app-1024.png?v=2', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
    { src: '/icons/app-mascara-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});
const SIN_CONEXION = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#09090b"><title>Fast Atlas · FASTWEB</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#a1a1aa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<main style="padding:32px;max-width:540px">
<p style="margin:0;font-size:11px;text-transform:uppercase;color:#a1a1aa">FASTWEB · Fast Atlas</p>
<h1 style="margin:14px 0 0;font-size:44px;line-height:.98;letter-spacing:-.04em;color:#fff">Fast Atlas is not responding.<br><span style="color:#22c55e">Give it a minute.</span></h1>
<p style="margin:24px 0 0;font-size:15px;line-height:1.6">It starts on its own when your Mac starts. If you just turned it on, wait a moment and retry. If it keeps happening, run the install command again in Terminal: you will not lose anything.</p>
<button onclick="location.reload()" style="margin-top:28px;height:48px;padding:0 24px;border:0;border-radius:9999px;background:#fff;color:#09090b;font:inherit;font-size:14px;cursor:pointer">Retry</button>
</main></body></html>`;
// El service worker no guarda nada: solo enseña el aviso de arriba si el panel no contesta.
const SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(${JSON.stringify(SIN_CONEXION)}, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
`;
const ISO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 78 101"><rect width="78" height="17" fill="#0CB111"/><rect x="26" y="42" width="52" height="17" fill="#0CB111"/><rect x="52" y="84" width="26" height="17" fill="#0CB111"/></svg>';

function responder(res, codigo, cuerpo, tipo, extra = {}) {
  res.writeHead(codigo, { 'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(cuerpo);
}
const json = (res, obj, codigo = 200) => responder(res, codigo, JSON.stringify(obj), 'application/json; charset=utf-8');

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let datos = '';
    req.setEncoding('utf8');
    req.on('data', c => { datos += c; if (datos.length > 1e6) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(datos ? JSON.parse(datos) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

async function manejar(req, res) {
  try {
    if (!HOSTS.has(String(req.headers.host || '').toLowerCase())) return responder(res, 403, 'Host not allowed', 'text/plain; charset=utf-8');
    const url = new URL(req.url, 'http://localhost');
    const ruta = url.pathname;
    if (req.method === 'GET' && ruta === '/') {
      const html = (await fsp.readFile(path.join(APP_DIR, 'panel.html'), 'utf8')).replace('%%TOKEN%%', TOKEN);
      return responder(res, 200, html, 'text/html; charset=utf-8', {
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'",
      });
    }
    if (req.method === 'GET' && ruta === '/salud') return responder(res, 200, 'ok', 'text/plain');
    if (req.method === 'GET' && ruta === '/favicon.svg') return responder(res, 200, ISO, 'image/svg+xml');
    if (req.method === 'GET' && ruta === '/manifest.webmanifest') return responder(res, 200, MANIFIESTO, 'application/manifest+json; charset=utf-8');
    if (req.method === 'GET' && ruta === '/sw.js') return responder(res, 200, SW, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && ruta.startsWith('/icons/')) {
      const n = ruta.slice('/icons/'.length);
      if (!ICONOS.has(n)) return responder(res, 404, '', 'text/plain');
      return responder(res, 200, await fsp.readFile(path.join(APP_DIR, 'icons', n)), 'image/png', { 'Cache-Control': 'public, max-age=86400' });
    }
    if (req.method === 'GET' && ruta.startsWith('/fonts/')) {
      const n = ruta.slice('/fonts/'.length);
      if (!FUENTES.has(n)) return responder(res, 404, '', 'text/plain');
      const datos = await fsp.readFile(path.join(APP_DIR, 'fonts', n));
      return responder(res, 200, datos, 'font/woff2', { 'Cache-Control': 'public, max-age=31536000' });
    }
    if (ruta.startsWith('/api/')) {
      if (req.headers['x-fast-atlas-token'] !== TOKEN) return json(res, { ok: false, mensaje: 'The session expired. Reload the page.' }, 403);
      const origen = req.headers.origin;
      if (origen && !ORIGENES.has(origen)) return json(res, { ok: false, mensaje: 'Origin not allowed.' }, 403);
      if (req.method === 'GET' && ruta === '/api/estado') return json(res, vistaEstado());
      if (req.method === 'GET' && ruta === '/api/ram') return json(res, await medirRam());
      if (req.method === 'GET' && ruta === '/api/carpeta') return json(res, await vistaCarpeta(url.searchParams.get('ruta')));
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, { ok: false, mensaje: 'Invalid format.' }, 415);
        const cuerpo = await leerCuerpo(req);
        if (ruta === '/api/accion') return json(res, await accion(cuerpo));
        if (ruta === '/api/config') return json(res, await cambiarConfig(cuerpo));
      }
    }
    responder(res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (e) {
    log('request', e.stack || e.message);
    json(res, { ok: false, mensaje: 'Internal error: ' + e.message }, 500);
  }
}

// ---------------------------------------------------------------- demo (solo para ver el diseño)

function cargarDemo() {
  const ahora = Date.now();
  const G = 1e9;
  estado.maquina.nombre = 'MacBook Pro';
  estado.disco = { total: 994.66 * G, libre: 86.4 * G, usado: 908.26 * G, disponible: 118.2 * G, purgable: 31.8 * G, segunMac: true, t: ahora - 4 * MIN };
  const h = (n, b, extra = {}) => ({ nombre: n, ruta: path.join(HOME, n), bytes: b * G, dir: true, ...extra });
  estado.library = { t: ahora, hijos: [
    { nombre: 'Application Support', ruta: lib('Application Support'), bytes: 131.2 * G, dir: true },
    { nombre: 'Caches', ruta: lib('Caches'), bytes: 38.4 * G, dir: true },
    { nombre: 'Developer', ruta: lib('Developer'), bytes: 9.1 * G, dir: true },
    { nombre: 'Containers', ruta: lib('Containers'), bytes: null, noMedido: NO_MEDIR.get(lib('Containers')), dir: true },
    { nombre: 'Group Containers', ruta: lib('Group Containers'), bytes: null, noMedido: NO_MEDIR.get(lib('Group Containers')), dir: true },
  ] };
  estado.home = { t: ahora, hijos: [
    h('Library', 214.6, { parcial: true }), h('Documents', 318.3), h('Downloads', 44.2), h('Desktop', 61.7), h('Pictures', 22.4, { parcial: true }),
    h('Movies', 88.1), h('.npm', 6.2), h('.cache', 4.8), h('.nvm', 3.1), h('.Trash', 2.2, { parcial: true }), h('.claude', 1.4), h('Music', 0.9),
  ] };
  estado.apps = { bytes: 61.5 * G, t: ahora };
  const nombres = [
    ['agency-site', 'Documents/repos', 1.9, 0.62, 3], ['restaurant-landing', 'Documents/repos', 1.4, 0.41, 12], ['photographer-portfolio', 'Documents/repos/clients', 1.2, 0.33, 75],
    ['booking-demo', 'Documents/repos/demos', 1.3, 0.52, 96], ['shop-catalog', 'Documents/repos/clients', 1.1, 0.29, 131], ['internal-dashboard', 'Documents/repos', 1.6, 0.48, 1],
    ['3d-configurator', 'Documents/repos/labs', 2.2, 0.71, 64], ['studio-blog', 'Desktop/tests', 0.9, 0.18, 210], ['clinic-booking', 'Documents/repos/demos', 1.0, 0.27, 88],
    ['renovation-landing', 'Documents/repos/demos', 0.8, 0.22, 140], ['ai-experiment', 'Desktop/tests', 0.7, 0, 45], ['wine-shop', 'Documents/repos/clients', 1.2, 0.37, 180],
    ['search-mcp', 'Documents/tools', 0.4, 0, 150],
  ];
  estado.proyectos = { t: ahora, lista: nombres.map(([n, c, nm, nx, dias]) => ({ ruta: path.join(HOME, c, n), nombre: n, carpeta: c, lock: n === 'ai-experiment' ? null : ['agency-site', 'internal-dashboard', 'search-mcp', 'booking-demo'].includes(n) ? 'pnpm-lock.yaml' : 'package-lock.json', git: true, nm: nm * G, next: nx * G, tocado: ahora - dias * DIA })) };
  const dep = estado.proyectos.lista.reduce((s, p) => s + p.nm, 0), nx = estado.proyectos.lista.reduce((s, p) => s + p.next, 0);
  estado.seg = {
    cowork: { existe: true, bytes: 13.6 * G }, npm: { existe: true, bytes: 6.2 * G }, deps: { existe: true, bytes: dep }, next: { existe: true, bytes: nx },
    'claude-code': { existe: true, bytes: 1.4 * G }, 'cache-apps': { existe: true, bytes: 38.4 * G }, descargas: { existe: true, bytes: 44.2 * G },
    papelera: { existe: true, bytes: 2.2 * G, parcial: true }, docker: { existe: true, bytes: 21.3 * G }, xcode: { existe: true, bytes: 9.1 * G },
  };
  for (const k of Object.keys(estado.seg)) estado.seg[k].t = ahora;
  estado.tCompleto = ahora - 4 * MIN; estado.tRapido = ahora - 4 * MIN;
  const libreHoy = 86.4;
  estado.serieLibre = [];
  for (let i = 30 * 24; i >= 0; i -= 3) {
    const t = ahora - i * HORA, dia = 30 - i / 24;
    let v = 158 - dia * 3.1 + Math.sin(i / 7) * 1.4;
    if (dia > 17) v += 21;
    estado.serieLibre.push({ t, libre: Math.max(40, Math.min(v, 190)) * G });
  }
  estado.serieLibre[estado.serieLibre.length - 1].libre = libreHoy * G;
  estado.registro = [
    { t: ahora - 13 * DIA, tipo: 'limpieza-auto', liberado: 21.4 * G, detalle: ['npm cache', '7 Next.js builds'] },
    { t: ahora - 6 * DIA, tipo: 'limpieza-auto', liberado: 2.1 * G, detalle: ['npm cache'] },
    { t: ahora - 3 * DIA, tipo: 'proyectos', liberado: 1.6 * G, detalle: ['gym-landing', 'old-booking-demo'], volver: [
      { nombre: 'gym-landing', ruta: path.join(HOME, 'Documents/repos/demos/gym-landing'), gestor: 'npm', comando: 'cd "$HOME/Documents/repos/demos/gym-landing" && npm install' },
      { nombre: 'old-booking-demo', ruta: path.join(HOME, 'Documents/repos/demos/old-booking-demo'), gestor: 'pnpm', comando: 'cd "$HOME/Documents/repos/demos/old-booking-demo" && pnpm install' },
    ] },
  ];
  estado.usos = { t: ahora, lista: [{ ruta: path.join(HOME, 'Documents/tools/mcp-buscador/dist/index.js'), motivo: 'Claude (MCP server)' }] };
  config.protegidos = [path.join(HOME, 'Documents/repos/clients/tienda-vinos')];
  config.permitidos = [];
  const grande = (n, c, gb, dias) => ({ ruta: path.join(HOME, c, n), nombre: n, carpeta: c, bytes: gb * G, mtime: ahora - dias * DIA });
  estado.grandes = { t: ahora, lista: [
    grande('flux-dev.safetensors', 'Documents/ai/models', 23.8, 140), grande('workshop-recording.mov', 'Movies', 6.4, 320), grande('render-final-v3.mp4', 'Desktop', 2.9, 41),
    grande('site-backup-2025.zip', 'Downloads', 2.1, 260), grande('terrace-scene.blend', 'Documents/3d', 1.3, 12), grande('Blender-4.5-arm64.dmg', 'Downloads', 0.42, 95),
    grande('ubuntu-24.04-arm64.iso', 'Downloads', 2.6, 400),
  ].sort((a, b) => b.bytes - a.bytes) };
  const base = { t: ahora - 7 * DIA, libre: 104 * G, usado: 890 * G, seg: { cowork: 7.5 * G, npm: 4.9 * G, deps: dep - 1.2 * G, next: nx - 0.3 * G, 'claude-code': 1.1 * G, 'cache-apps': 36.9 * G, descargas: 40.8 * G, papelera: 2.2 * G, docker: 21.3 * G, xcode: 9.1 * G }, home: { Library: 207.1 * G, Documents: 316.1 * G, Downloads: 40.8 * G, Desktop: 61.5 * G, Pictures: 22.4 * G, Movies: 88.1 * G, '.npm': 4.9 * G, '.cache': 4.8 * G, '.nvm': 3.1 * G, '.Trash': 2.2 * G, '.claude': 1.1 * G, Music: 0.9 * G } };
  estado.historia = [base];
  config.instalado = ahora - 20 * DIA; config.ultimaLimpieza = ahora - 6 * DIA;
  estado.cowork = { disponible: true, existe: true, disco: 12.4 * G, base: true, claudeAbierto: true, enUso: null, respaldos: [], t: ahora };
  estado.ram = { total: 64 * 1073741824, usada: 41.3 * G, comprimida: 3.2 * G, swap: { total: 2 * 1073741824, usada: 0.6 * 1073741824 }, t: ahora, apps: [
    { nombre: 'Google Chrome', etiqueta: 'Google Chrome', bytes: 9.8 * G, procesos: 61 }, { nombre: 'Claude', etiqueta: 'Claude', bytes: 6.4 * G, procesos: 14 },
    { nombre: 'macOS', etiqueta: 'macOS y sus servicios', bytes: 5.2 * G, procesos: 412 }, { nombre: 'node', etiqueta: 'Node (proyectos y herramientas)', bytes: 3.1 * G, procesos: 9 },
    { nombre: 'Blender', etiqueta: 'Blender', bytes: 2.8 * G, procesos: 1 }, { nombre: 'Figma', etiqueta: 'Figma', bytes: 1.9 * G, procesos: 7 },
    { nombre: 'Cursor', etiqueta: 'Cursor', bytes: 1.6 * G, procesos: 11 }, { nombre: 'Slack', etiqueta: 'Slack', bytes: 0.9 * G, procesos: 6 },
  ] };
}

// ---------------------------------------------------------------- arranque

async function tickHora() {
  try {
    await escaneoRapido();
    await muestrearLibre();
    await avisarPocoEspacio();
    if (Date.now() - estado.tCompleto > 24 * HORA) await escaneoCompleto('daily');
    await limpiezaAutoSiToca();
  } catch (e) { log('tick', e.stack || e.message); }
}

async function main() {
  await cargarTodo();
  if (DEMO) cargarDemo();
  else {
    await detectarCacheNpm().catch(() => {});
    estado.maquina.nombre = await nombreMac();
  }
  const servidor = http.createServer(manejar);
  servidor.on('error', e => {
    if (e.code === 'EADDRINUSE') { log(`Port ${PUERTO} is busy. Is another Fast Atlas already running?`); process.exit(1); }
    log('servidor', e.message);
  });
  servidor.listen(PUERTO, '127.0.0.1', () => log(`Fast Atlas ${VERSION} at http://localhost:${PUERTO}`));
  const servidor6 = http.createServer(manejar);
  servidor6.on('error', () => {});
  servidor6.listen(PUERTO, '::1');
  if (DEMO) return;
  setTimeout(async () => {
    await escaneoRapido();
    if (!estado.serieLibre.length || Date.now() - estado.serieLibre[estado.serieLibre.length - 1].t > 50 * MIN) await muestrearLibre();
    if (Date.now() - estado.tCompleto > 20 * HORA) await escaneoCompleto('startup');
    await limpiezaAutoSiToca();
  }, 1500);
  setInterval(tickHora, HORA);
}

process.on('unhandledRejection', e => log('unhandled promise', e && (e.stack || e.message || e)));
main().catch(e => { log('could not start', e.stack || e.message); process.exit(1); });
