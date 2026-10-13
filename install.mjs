#!/usr/bin/env node
/**
 * Install this plugin into a DSH profile.
 *
 * DSH reads a plugin from three places, and all three have to agree:
 *   1. the profile's `package.json` → `dependencies` declares it (as a `link:` path),
 *   2. the same file's `dsh.profile.bundles` array lists its name,
 *   3. `node_modules/<name>` resolves to this directory (a junction/symlink, since there is
 *      nothing to download and no build step).
 *
 * Getting any one of them wrong is silent: the plugin simply never mounts, and the pairing panel
 * never appears. That is why this script does all three and then checks the result, instead of
 * leaving it as instructions to follow by hand.
 *
 * Usage:
 *   node install.mjs                 # install into the default profile
 *   node install.mjs --profile <dir> # a specific profile directory
 *   node install.mjs --dry-run       # print what would change, touch nothing
 *
 * The profile directory defaults to `~/.dsh/profiles/desktop`.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'dsh-mobile-public';
const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { profile: join(homedir(), '.dsh', 'profiles', 'desktop'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile' && argv[i + 1]) args.profile = resolve(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // Refusing beats "repairing" a file whose syntax is already broken: rewriting it would hide
    // whatever the user was in the middle of editing.
    throw new Error(file + ' is not valid JSON (' + error.message + '); fix it first.');
  }
}

/** Add `name` to the bundles array, if it is not already there. */
function ensureBundle(profile, name) {
  profile.dsh = profile.dsh || {};
  profile.dsh.profile = profile.dsh.profile || {};
  const bundles = profile.dsh.profile.bundles || (profile.dsh.profile.bundles = []);
  if (bundles.includes(name)) return false;
  bundles.push(name);
  return true;
}

/** Point `dependencies[name]` at this directory. */
function ensureDependency(profile, name, target) {
  profile.dependencies = profile.dependencies || {};
  // Forward slashes: npm's `link:` value is a path, and backslashes are fragile inside JSON.
  const wanted = 'link:' + target.replace(/\\/g, '/');
  if (profile.dependencies[name] === wanted) return false;
  profile.dependencies[name] = wanted;
  return true;
}

/**
 * Make node_modules/<name> resolve to this directory.
 *
 * The check compares `realpath` on both sides rather than the raw link text: a Windows junction
 * reports its target through `readlinkSync`, but the value can be absolute or relative, and its
 * case need not match what was passed in. Comparing resolved paths is what makes a second run
 * report "already correct" instead of recreating an identical link.
 */
function ensureLink(linkPath, target, dryRun) {
  const wants = safeRealpath(target);
  const existing = safeLstat(linkPath);

  if (existing) {
    if (!existing.isSymbolicLink()) {
      // A real directory here belongs to someone else's install; deleting it would delete files.
      throw new Error(linkPath + ' exists and is not a link; move it away yourself if you want this one.');
    }
    if (safeRealpath(linkPath) === wants) return 'already correct';
    if (dryRun) return 'would-repoint';
    rmSync(linkPath, { recursive: true, force: true });
  }

  if (dryRun) return 'would-create';
  mkdirSync(dirname(linkPath), { recursive: true });
  // 'junction' on Windows works without developer mode or administrator rights; a directory
  // symlink elsewhere.
  symlinkSync(target, linkPath, platform() === 'win32' ? 'junction' : 'dir');
  return 'created';
}

function safeLstat(p) {
  try {
    return lstatSync(p);
  } catch (error) {
    return null;
  }
}

/** Resolve a path that may not exist yet, without throwing. */
function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch (error) {
    return resolve(p);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileFile = join(args.profile, 'package.json');
  console.log('plugin   : ' + HERE);
  console.log('profile  : ' + args.profile);
  console.log('mode     : ' + (args.dryRun ? 'dry run (nothing will change)' : 'install'));
  console.log();

  if (!existsSync(args.profile)) {
    throw new Error('profile directory does not exist: ' + args.profile
      + '\nOpen DSH once so it creates the profile, or pass --profile <dir>.');
  }

  const profile = readJson(profileFile);
  if (!profile) throw new Error('no package.json at ' + profileFile);

  const depChanged = ensureDependency(profile, PLUGIN_NAME, HERE);
  const bundleChanged = ensureBundle(profile, PLUGIN_NAME);
  const linkPath = join(args.profile, 'node_modules', PLUGIN_NAME);
  const linkAction = ensureLink(linkPath, HERE, args.dryRun);

  if (!args.dryRun && (depChanged || bundleChanged)) {
    // Written last: if the link fails above, the profile file is left exactly as it was.
    writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  }

  console.log('  dependencies  : ' + (depChanged ? 'updated' : 'already correct'));
  console.log('  bundles       : ' + (bundleChanged ? 'added ' + PLUGIN_NAME : 'already listed'));
  console.log('  node_modules  : ' + linkAction);
  console.log();

  if (args.dryRun) {
    console.log('Dry run finished. Re-run without --dry-run to apply.');
    return;
  }

  console.log('Done. Now:');
  console.log('  1. fully quit DSH and start it again (plugins mount at startup only);');
  console.log('  2. check http://127.0.0.1:19387/m/api/status returns JSON;');
  console.log('  3. for phone access, make sure the web server listens on 0.0.0.0:');
  console.log('     ' + join(args.profile, 'cordis.patch.yml') + ' → webserver.host: \'0.0.0.0\'');
}

try {
  main();
} catch (error) {
  console.error('install failed: ' + error.message);
  process.exit(1);
}
