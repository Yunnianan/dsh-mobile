# Refresh the delivery packages so they carry the current source and APK.
#
# Why this exists next to `stage-delivery.py` instead of replacing it: that script
# mirrors the working tree into the full package with `mirror(REPO, stage_plugin)`,
# which DELETES `dsh-mobile-full-stage` first. The full package is not a mirror of
# the working tree — it also holds hand-written documentation (`3-教程/`, `6-开发文档/`,
# `读我先看.txt`) and the numbered layout itself. Wiping it to refresh one APK
# destroys the parts no script can recreate, so this tool updates the sub-trees that
# are actually generated and leaves the rest untouched.
#
# Source of truth is `repo/android/` — the same tree the repository publishes and the
# APK is built from. It lives inside the repo because a second copy (the old
# `dsh-mobile/apk/`) silently drifted: the 16.9.1 swipe-gesture change was made in one
# and the packages were built from a stale path.
#
# Every copy is verified by hash afterwards; a mismatch exits non-zero.

import hashlib
import os
import shutil
import sys


def find_repo():
    """Locate the repository, from either the repo itself or the workspace above it."""
    here = os.path.dirname(os.path.abspath(__file__))
    for _ in range(4):
        candidate = here if os.path.basename(here) == 'repo' else os.path.join(here, 'repo')
        if os.path.isdir(os.path.join(candidate, 'android')):
            return candidate
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    raise SystemExit('cannot find the repository (a directory holding android/) above %s'
                     % os.path.abspath(__file__))


REPO = find_repo()
ROOT = os.path.dirname(REPO)
FULL = os.path.join(os.path.dirname(ROOT), 'dsh-mobile-full-stage')
OUT = os.path.join(ROOT, 'out')
PLUGIN = os.path.join(REPO, 'lib')


def sha(path):
    with open(path, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def tree(root):
    out = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            out[os.path.relpath(path, root)] = path
    return out


def on_rm_error(func, path, _exc):
    """Clear the read-only bit and retry, so a rmtree can finish on Windows.

    Git object files are written read-only, and this package carries a `.git` from an
    earlier mirror. shutil.rmtree refuses to unlink a read-only file, which surfaced
    as `PermissionError: [WinError 5]` halfway through a refresh — after the product
    folder had already been rewritten.
    """
    try:
        os.chmod(path, 0o700)
        func(path)
    except OSError:
        raise


def replace(src, dst, ignore=None):
    """Replace dst with a copy of src. Deletes first: Copy-Item -Recurse merges, and
    a merge is how stale files survive a refresh."""
    if os.path.exists(dst):
        if os.path.isdir(dst):
            shutil.rmtree(dst, onerror=on_rm_error)
        else:
            os.chmod(dst, 0o700)
            os.remove(dst)
    if os.path.isdir(src):
        shutil.copytree(src, dst, ignore=ignore)
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)


def same(src, dst, problems, label):
    """Compare a tree, or a single file, against its copy.

    A single file has to be handled explicitly: walking it as a tree yields nothing,
    so the check passed while comparing zero files — a no-op that looked like a pass.
    """
    if os.path.isfile(src) or os.path.isfile(dst):
        if not (os.path.isfile(src) and os.path.isfile(dst)):
            print('  FAIL  %-16s missing (src=%s dst=%s)'
                  % (label, os.path.exists(src), os.path.exists(dst)))
            problems.append(label)
        elif sha(src) != sha(dst):
            print('  FAIL  %-16s differs' % label)
            problems.append(label)
        else:
            print('  ok    %-16s 1 file' % label)
        return

    ta, tb = tree(src), tree(dst)
    missing = sorted(set(ta) - set(tb))
    extra = sorted(set(tb) - set(ta))
    differing = sorted(k for k in set(ta) & set(tb) if sha(ta[k]) != sha(tb[k]))
    if missing or extra or differing:
        print('  FAIL  %-16s missing=%d extra=%d differing=%d'
              % (label, len(missing), len(extra), len(differing)))
        for k in (missing + extra + differing)[:8]:
            print('          %s' % k)
        problems.append(label)
    else:
        print('  ok    %-16s %d files' % (label, len(ta)))


def stage_dir(number):
    """Find a numbered stage folder by its ASCII prefix, never by a literal path.

    The prefix (`1-`) is ASCII by design so a script never has to spell the Chinese
    name, but the rest of the name is not: filtering candidates on "all characters
    ASCII" rejects `1-成品` itself and finds nothing at all. Only mojibake twins are
    rejected, and that filter is a tie-breaker rather than a requirement.
    """
    candidates = [d for d in os.listdir(FULL)
                  if os.path.isdir(os.path.join(FULL, d)) and d.startswith(number + '-')]
    if not candidates:
        raise SystemExit('no stage folder for %s- under %s' % (number, FULL))
    if len(candidates) > 1:
        # A non-ASCII path read as ANSI becomes a replacement-character twin; drop
        # those first, then take what is left in a stable order.
        clean = [d for d in candidates if '\ufffd' not in d]
        return os.path.join(FULL, sorted(clean or candidates)[0])
    return os.path.join(FULL, candidates[0])


def main():
    problems = []
    apks = [f for f in os.listdir(OUT) if f.startswith('dsh-mobile-') and f.endswith('.apk')]
    if not apks:
        raise SystemExit('no APK in %s - build one first' % OUT)
    apks.sort(key=lambda f: os.path.getmtime(os.path.join(OUT, f)), reverse=True)
    apk = apks[0]
    version = apk.replace('dsh-mobile-', '').replace('.apk', '')
    print('  repo     %s' % REPO)
    print('  version  %s (%s)' % (version, apk))

    product = stage_dir('1')
    plugin = stage_dir('2')
    source = stage_dir('4')

    # 1. The APK, in the product folder. Any other version is removed: a package
    #    carrying two builds makes the reader guess which one is current.
    for name in os.listdir(product):
        if name.endswith('.apk'):
            os.remove(os.path.join(product, name))
    shutil.copy2(os.path.join(OUT, apk), product)
    print('  1-成品   %s' % apk)

    # 2. The APK source, whole.
    replace(os.path.join(REPO, 'android'), os.path.join(source, 'apk'))
    print('  4-源码   apk/')

    # 3. The plugin, in both copies the package carries, refreshed from the repo.
    #
    #    These drift silently otherwise: the copy shipped here was a revision behind
    #    on the plugin README, so a reader following it was pointed at an APK version
    #    the repository no longer has. `.git` and `dist` are excluded — the first is
    #    repository metadata, the second is the tracked APK that the product folder
    #    already provides.
    replace(REPO, os.path.join(plugin, 'dsh-mobile-public'),
            ignore=shutil.ignore_patterns('.git', 'dist'))
    replace(PLUGIN, os.path.join(plugin, 'lib'))
    print('  2-插件   dsh-mobile-public/ + lib/')

    # 4. Build inputs, so the reader can rebuild what the package ships.
    for name in ('libs', 'keystore'):
        src = os.path.join(ROOT, name)
        if os.path.isdir(src):
            replace(src, os.path.join(source, name))
            print('  4-源码   %s/' % name)
    replace(os.path.join(REPO, 'build-apk.ps1'), os.path.join(source, 'build-apk.ps1'))
    print('  4-源码   build-apk.ps1')

    # 5. Prove every copy before claiming success.
    print()
    same(os.path.join(REPO, 'android'), os.path.join(source, 'apk'), problems, 'source')
    same(PLUGIN, os.path.join(plugin, 'lib'), problems, 'plugin lib')
    same(PLUGIN, os.path.join(plugin, 'dsh-mobile-public', 'lib'), problems, 'plugin copy lib')
    same(os.path.join(ROOT, 'libs'), os.path.join(source, 'libs'), problems, 'libs')
    same(os.path.join(REPO, 'README.md'),
         os.path.join(plugin, 'dsh-mobile-public', 'README.md'), problems, 'plugin README')

    # The APK this package advertises has to be the one sitting in it.
    shipped = os.path.join(product, apk)
    if not os.path.exists(shipped):
        problems.append('product APK missing')
        print('  FAIL  product APK')
    elif sha(shipped) != sha(os.path.join(OUT, apk)):
        problems.append('product APK differs')
        print('  FAIL  product APK differs from out/')
    else:
        print('  ok    %-16s %s' % ('product APK', version))

    print()
    if problems:
        print('  NOT consistent: %s' % ', '.join(problems))
        return 1
    print('  delivery packages now carry %s' % version)
    print('  note: 读我先看.txt / 3-教程 are hand-written and were not touched -')
    print('        update the version string there by hand if it changed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
