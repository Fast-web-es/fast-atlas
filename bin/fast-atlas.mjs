#!/usr/bin/env node
/*
  Fast Atlas CLI. A Fast Web Labs app (https://fast-web.es).

    npx fast-atlas             install or update, then open the panel
    npx fast-atlas open        open the panel
    npx fast-atlas status      is it running?
    npx fast-atlas uninstall   stop it and remove it

  It never uses sudo and only writes inside your home folder:
  ~/.fast-atlas (the app and its data) and ~/Library/LaunchAgents/es.fast-web.fast-atlas.plist.
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST = process.env.FAST_ATLAS_TEST === '1';
const HOME = TEST ? process.env.FAST_ATLAS_HOME : os.homedir();
const PORT = Number(process.env.FAST_ATLAS_PORT || 4848);
const LABEL = 'es.fast-web.fast-atlas';
const DEST = path.join(HOME, '.fast-atlas');
const AGENTS = path.join(HOME, 'Library', 'LaunchAgents');
const PLIST = path.join(AGENTS, `${LABEL}.plist`);
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = { label: 'es.fast-web.maquina', dir: path.join(HOME, '.fastweb-maquina'), plist: path.join(AGENTS, 'es.fast-web.maquina.plist') };
const UID = process.getuid ? process.getuid() : 0;
const URL = `http://localhost:${PORT}`;

const green = (s) => `\x1b[32m${s}\x1b[0m`, grey = (s) => `\x1b[90m${s}\x1b[0m`, red = (s) => `\x1b[31m${s}\x1b[0m`;
const ok = (s) => console.log(`  ${green('✓')} ${s}`);
const note = (s) => console.log(`  ${grey(s)}`);
function fail(s) { console.error(`\n  ${red(s)}\n`); process.exit(1); }
function sh(cmd, args, opts = {}) {
  try { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }); } catch { return null; }
}
const loaded = (label) => !TEST && sh('launchctl', ['print', `gui/${UID}/${label}`]) !== null;
function bootout(label) { if (!TEST) sh('launchctl', ['bootout', `gui/${UID}/${label}`]); }
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function healthy() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/salud`); return r.ok; } catch { return false; }
}
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}
// Only ever deletes its own folder or its own launch agent file, checked by exact path.
function removeOwn(p) {
  const allowed = [DEST, PLIST, OLD.plist];
  if (!allowed.includes(p)) throw new Error(`Refusing to delete ${p}`);
  fs.rmSync(p, { recursive: true, force: true });
}

async function install() {
  console.log(`\n  Fast Atlas · a Fast Web Labs app\n`);
  if (process.platform !== 'darwin' && !TEST) fail('Fast Atlas only runs on macOS.');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fail(`Your Node is version ${major}. Fast Atlas needs Node 18 or newer.`);
  ok(`Node ${process.version} at ${process.execPath}`);

  // Stop the current version, if any (only ours, by its exact label).
  if (loaded(LABEL)) { bootout(LABEL); await sleep(800); ok('Stopped the running version'); }

  // Coming from Fast Cleaner (the private version)? Turn it off and bring its history.
  if (fs.existsSync(OLD.plist) || loaded(OLD.label)) {
    bootout(OLD.label);
    await sleep(800);
    if (fs.existsSync(OLD.plist)) removeOwn(OLD.plist);
    const oldData = path.join(OLD.dir, 'data');
    if (fs.existsSync(oldData) && !fs.existsSync(path.join(DEST, 'data'))) {
      fs.mkdirSync(DEST, { recursive: true });
      // Moved, not copied: a Cowork backup can weigh 10 GB and must not be duplicated.
      try { fs.renameSync(oldData, path.join(DEST, 'data')); }
      catch { fs.cpSync(oldData, path.join(DEST, 'data'), { recursive: true }); }
      ok('Brought over history, settings and backups from Fast Cleaner');
    }
    note(`Fast Cleaner is off. Its old folder is still at ${OLD.dir}: delete it when you want.`);
  }

  if (!TEST && sh('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN']) !== null) {
    fail(`Port ${PORT} is used by another app. Try: FAST_ATLAS_PORT=4949 npx fast-atlas`);
  }

  // Copy the app. The data folder (history, settings, Cowork backups) is never overwritten.
  for (const dir of ['app/fonts', 'app/icons', 'bin', 'data']) fs.mkdirSync(path.join(DEST, dir), { recursive: true });
  for (const f of ['app/server.mjs', 'app/panel.html', 'bin/fast-atlas.mjs', 'package.json']) fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
  for (const dir of ['app/fonts', 'app/icons']) for (const f of fs.readdirSync(path.join(SRC, dir))) fs.copyFileSync(path.join(SRC, dir, f), path.join(DEST, dir, f));
  fs.chmodSync(DEST, 0o700);
  ok(`Installed in ${DEST}`);

  // Start on login with launchd, at low priority so it never slows you down.
  fs.mkdirSync(AGENTS, { recursive: true });
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(DEST, 'app', 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(DEST)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path.dirname(process.execPath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>FAST_ATLAS_PORT</key><string>${PORT}</string>
    <key>FAST_ATLAS_DATA</key><string>${xml(path.join(DEST, 'data'))}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Nice</key><integer>10</integer>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(DEST, 'data', 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(DEST, 'data', 'server.log'))}</string>
</dict>
</plist>
`);
  if (TEST) { ok('Launch agent written (test mode: not started)'); return; }
  if (sh('plutil', ['-lint', PLIST]) === null) fail(`The launch agent file is invalid: ${PLIST}`);
  if (sh('launchctl', ['bootstrap', `gui/${UID}`, PLIST]) === null) fail(`macOS did not start it. See ${path.join(DEST, 'data', 'server.log')}`);
  for (let i = 0; i < 40 && !(await healthy()); i++) await sleep(500);
  if (!(await healthy())) fail(`It is not answering. See ${path.join(DEST, 'data', 'server.log')}`);
  ok(`Running at ${URL}. It starts again on its own when your Mac starts`);
  sh('open', [URL]);
  console.log('');
  note('The first scan takes a few minutes. macOS may ask whether "node" can access your');
  note('Desktop, Documents and Downloads: allow it, or those folders are not measured.');
  note('You may also see "Background items added": that is Fast Atlas.');
  note('Nothing is ever deleted unless you click and confirm.');
  note('To remove it: npx fast-atlas uninstall');
  console.log('');
}

async function uninstall() {
  console.log(`\n  Fast Atlas · uninstall\n`);
  const backups = path.join(DEST, 'data', 'respaldos');
  if (fs.existsSync(backups) && fs.readdirSync(backups).length) {
    note('There is a Cowork backup kept by Fast Atlas:');
    for (const f of fs.readdirSync(backups)) note(`  ${f}`);
    note('Open the panel and delete or restore it first. Nothing was touched.');
    console.log('');
    process.exit(1);
  }
  note(`This stops Fast Atlas, removes ${PLIST}`);
  note(`and deletes ${DEST} (the app, its history and settings). Nothing else on your Mac.`);
  const answer = TEST ? 'yes' : await ask('\n  Type yes to continue: ');
  if (!/^(y|yes|s|si|sí)$/i.test(answer)) { note('Nothing was touched.'); console.log(''); return; }
  bootout(LABEL);
  if (fs.existsSync(PLIST)) removeOwn(PLIST);
  if (fs.existsSync(DEST)) removeOwn(DEST);
  ok('Removed. Check with: launchctl list | grep fast-atlas (it should print nothing)');
  note('If you installed it as an app, drag Fast Atlas from Applications to the Trash.');
  console.log('');
}

async function status() {
  const on = await healthy();
  console.log(`\n  Fast Atlas is ${on ? green('running') : red('not running')} at ${URL}`);
  console.log(`  Installed: ${fs.existsSync(path.join(DEST, 'app', 'server.mjs')) ? 'yes' : 'no'} (${DEST})\n`);
}

const cmd = process.argv[2] || 'install';
if (cmd === 'install' || cmd === 'update') await install();
else if (cmd === 'uninstall') await uninstall();
else if (cmd === 'open') { if (!TEST) sh('open', [URL]); }
else if (cmd === 'status') await status();
else {
  console.log(`
  Fast Atlas · a local map of your Mac's disk and memory

    npx fast-atlas             install or update, then open the panel
    npx fast-atlas open        open the panel (${URL})
    npx fast-atlas status      is it running?
    npx fast-atlas uninstall   stop it and remove it
`);
}
