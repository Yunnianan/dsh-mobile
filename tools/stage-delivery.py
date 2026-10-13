# Mirror the working tree into the delivery packages, then verify the result.
#
# Python, not PowerShell. The PowerShell version of this ran three times and produced three different
# silent failures: a `Copy-Item -Recurse` that merged instead of replacing, a `res/res` that survived
# every run, and finally a `Mirror-Tree` that reported success while copying nothing at all — the slim
# package came out current and the full one kept a `widget.js` from hours earlier, from the same call in
# the same run. Each was found only by comparing file hashes afterwards.
#
# So this file does the copying and the checking in one place, and the checking is the part that matters:
# it compares every file by hash and exits non-zero on any difference. Run `verify-packages.py`
# afterwards as well — it reads the archives, which this cannot.
#
# Two rules the PowerShell version taught:
#   1. Delete before copying, or stale files and stale nesting survive.
#   2. Never trust the copy: hash it.

import hashlib
import os
import shutil
import sys
import zipfile

def find_root():
    """The workspace root, found by looking for the folders this tool operates on.

    Not `dirname(dirname(__file__))`: that assumes one fixed depth, and this file lives in two places —
    `dsh-mobile/tools/` (two levels up is right) and the delivery copy at `dsh-mobile/repo/tools/`
    (where two levels up is `repo/`, so the first run from there failed with
    `FileNotFoundError: ...\\dsh-mobile\\out`). Walking up until the expected folders appear works from
    either location.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    for _ in range(4):
        if os.path.isdir(os.path.join(here, 'apk')) and os.path.isdir(os.path.join(here, 'repo')):
            return here
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    raise SystemExit('cannot find the dsh-mobile workspace above %s' % os.path.abspath(__file__))


ROOT = find_root()
STAGE = os.path.join(ROOT, '_zipstage')
REPO = os.path.join(ROOT, 'repo')
OUT = os.path.join(ROOT, 'out')
FULL = os.path.join(os.path.dirname(ROOT), 'dsh-mobile-full-stage')

# Stage folders are found by their ASCII prefix, never written as literals.
# A non-ASCII path in a script read as ANSI becomes a mojibake twin directory — measured, twice:
# `2-鎻掍欢` and `4-婧愮爜` appeared alongside the real folders and were written to instead.
def stage(number):
    candidates = [d for d in os.listdir(FULL)
                  if os.path.isdir(os.path.join(FULL, d)) and d.startswith(number + '-')]
    if not candidates:
        raise SystemExit('no stage folder for %s- under %s' % (number, FULL))
    if len(candidates) > 1:
        # Drop anything that is not a clean name, then take what is left.
        good = [d for d in candidates if d.isprintable() and '\ufffd' not in d
                and all(ord(c) < 128 for c in d.replace('-', '')) or d.isascii()]
        keep = (good or candidates)[0]
        for other in candidates:
            if other != keep:
                shutil.rmtree(os.path.join(FULL, other), ignore_errors=True)
                print('removed duplicate stage %s' % other)
        return os.path.join(FULL, keep)
    return os.path.join(FULL, candidates[0])


def mirror(src, dst, ignore=None):
    """Replace dst with a copy of src. Returns the number of files copied."""
    if os.path.isfile(src):
        # A single file is a legitimate input (`build-apk.ps1`, the keystore): copy it into place rather
        # than treating it as a tree, which raised NotADirectoryError on the first attempt.
        parent = os.path.dirname(dst)
        if parent:
            os.makedirs(parent, exist_ok=True)
        if os.path.exists(dst):
            os.remove(dst)
        shutil.copy2(src, dst)
        return 1
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=ignore)
    return sum(len(files) for _r, _d, files in os.walk(dst))


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


def compare(label, source, staged, problems):
    """Compare a source tree against its staged copy.

    Arguments are (label, source, staged) — source first. Getting this backwards is not harmless:
    the first version passed them the other way round and reported every file as missing, because the
    "reference" tree was the empty destination.
    """
    ta, tb = tree(source), tree(staged)
    # Printed always: a comparison that reports "everything missing" is otherwise indistinguishable from
    # a comparison whose destination path is wrong, and that ambiguity has cost more time than the line
    # it takes to remove.
    print('        [%s] source=%r(%d) staged=%r(%d)'
          % (label, source, len(tree(source)), staged, len(tree(staged))))
    missing = sorted(set(ta) - set(tb))
    extra = sorted(set(tb) - set(ta))
    differing = sorted(k for k in set(ta) & set(tb) if sha(ta[k]) != sha(tb[k]))
    if missing or extra or differing:
        print('  FAIL  %-8s missing=%d extra=%d differing=%d'
              % (label, len(missing), len(extra), len(differing)))
        for k in (missing + extra + differing)[:6]:
            print('          %s' % k)
        problems.append(label)
    else:
        print('  ok    %-8s %d files' % (label, len(ta)))


def main():
    problems = []
    stage_product = stage('1')
    stage_plugin = stage('2')
    stage_source = stage('4')

    # 1. The slim package: plugin subtree plus the notes that live beside it.
    plugin_stage = os.path.join(STAGE, 'plugin')
    if os.path.exists(plugin_stage):
        shutil.rmtree(plugin_stage)
    for name in ('lib', 'test', 'features', 'tools'):
        source = os.path.join(REPO, name)
        if os.path.isdir(source):
            shutil.copytree(source, os.path.join(plugin_stage, name))
    for name in ('README.md', 'cordis.patch.yml', 'package.json', 'install.mjs', 'LICENSE'):
        source = os.path.join(REPO, name)
        if os.path.isfile(source):
            shutil.copy2(source, os.path.join(plugin_stage, name))

    # 2. The APK source, whole. One copytree, so nesting is impossible.
    mirror(os.path.join(ROOT, 'apk'), os.path.join(stage_source, 'apk'))
    # A second source tree is worse than none: the reader cannot tell which was built.
    for stale in ('res', 'github-repo', os.path.join('apk', 'src', 'src')):
        path = os.path.join(stage_source, stale)
        if os.path.exists(path):
            shutil.rmtree(path)
            print('  removed stale %s' % stale)

    # 3. Build inputs, so the reader can rebuild the APK.
    for name in ('build-apk.ps1', 'keystore', 'libs'):
        source = os.path.join(ROOT, name)
        if os.path.exists(source):
            mirror(source, os.path.join(stage_source, name))

    # 4. The built APK, newest first, taken from `out`.
    if os.path.exists(stage_product):
        shutil.rmtree(stage_product)
    os.makedirs(stage_product)
    apks = [f for f in os.listdir(OUT) if f.startswith('dsh-mobile-') and f.endswith('.apk')]
    apks.sort(key=lambda f: os.path.getmtime(os.path.join(OUT, f)), reverse=True)
    if not apks:
        print('  WARNING: no APK in out/ - the product folder is empty')
        version = 'unknown'
    else:
        version = apks[0].replace('dsh-mobile-', '').replace('.apk', '')
        shutil.copy2(os.path.join(OUT, apks[0]), stage_product)
        # The slim package carries it at its root, not in a product folder: that package is what someone
        # installs from directly. Omitting this copy is how the first Python version shipped a slim
        # package whose only missing part was the APK.
        old = [f for f in os.listdir(STAGE) if f.startswith('dsh-mobile-') and f.endswith('.apk')]
        for name in old:
            os.remove(os.path.join(STAGE, name))
        shutil.copy2(os.path.join(OUT, apks[0]), STAGE)
        print('  product %s' % apks[0])

    # 5. The plugin, mirrored whole, in both copies the full package carries.
    mirror(REPO, os.path.join(stage_plugin, 'dsh-mobile-public'),
           ignore=shutil.ignore_patterns('.git', 'dist'))
    mirror(os.path.join(REPO, 'lib'), os.path.join(stage_plugin, 'lib'))

    # 6. Prove it before saying so.
    print()
    compare('source', os.path.join(ROOT, 'apk'), os.path.join(stage_source, 'apk'), problems)
    compare('plugin', os.path.join(REPO, 'lib'), os.path.join(stage_plugin, 'lib'), problems)
    compare('tests', os.path.join(REPO, 'test'), os.path.join(STAGE, 'plugin', 'test'), problems)
    compare('plugincopy', os.path.join(REPO, 'lib'),
            os.path.join(stage_plugin, 'dsh-mobile-public', 'lib'), problems)
    if problems:
        print('  staging is NOT consistent: %s' % ', '.join(problems))
        return 1

    # 7. Zip, in the same run, so nothing can change between mirror and archive.
    for name in os.listdir(OUT):
        if name.startswith('dsh-mobile-') and name.endswith('.zip'):
            os.remove(os.path.join(OUT, name))
    slim_zip = os.path.join(OUT, 'dsh-mobile-%s-plugin-and-apk.zip' % version)
    full_zip = os.path.join(OUT, 'dsh-mobile-%s-full.zip' % version)
    for source_dir, target in ((STAGE, slim_zip), (FULL, full_zip)):
        with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for base, _dirs, files in os.walk(source_dir):
                for name in files:
                    path = os.path.join(base, name)
                    archive.write(path, os.path.relpath(path, source_dir))
    print('  slim %s  %d bytes' % (os.path.basename(slim_zip), os.path.getsize(slim_zip)))
    print('  full %s  %d bytes' % (os.path.basename(full_zip), os.path.getsize(full_zip)))
    print('  now run build/verify-packages.py to check the archives themselves')
    return 0


if __name__ == '__main__':
    sys.exit(main())
