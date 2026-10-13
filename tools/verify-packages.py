# Verify the delivery packages against the tree they were built from.
#
# Python rather than PowerShell, on purpose. The PowerShell verification this replaces ran inside the
# staging script and reported success while the packages were wrong — three separate times, for three
# different reasons, each of which turned its own check into a no-op. A checker that shares a runtime
# with the thing it checks will eventually inherit its mistakes; this one reads the archives and the
# source tree with nothing in common but the files.
#
# Exits non-zero with a list of mismatches, so it can gate a release.

import hashlib
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.join(ROOT, 'repo')
OUT = os.path.join(ROOT, 'out')
FULL = os.path.join(os.path.dirname(ROOT), 'dsh-mobile-full-stage')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def newest_apk():
    apks = [f for f in os.listdir(OUT) if f.startswith('dsh-mobile-') and f.endswith('.apk')]
    if not apks:
        return None
    apks.sort(key=lambda f: os.path.getmtime(os.path.join(OUT, f)), reverse=True)
    return apks[0]


def check(label, data_a, data_b, problems):
    if data_a == data_b:
        print('  ok    %s' % label)
        return
    if data_a is None:
        print('  MISS  %s' % label)
        problems.append('%s missing' % label)
        return
    print('  FAIL  %s' % label)
    problems.append(label)


def main():
    apk = newest_apk()
    if apk is None:
        print('  no APK in out/')
        return 1
    version = apk.replace('dsh-mobile-', '').replace('.apk', '')
    slim_zip = os.path.join(OUT, 'dsh-mobile-%s-plugin-and-apk.zip' % version)
    full_zip = os.path.join(OUT, 'dsh-mobile-%s-full.zip' % version)
    problems = []

    print('  version %s' % version)
    for path in (slim_zip, full_zip):
        if not os.path.exists(path):
            print('  MISS  %s' % os.path.basename(path))
            return 1

    slim = zipfile.ZipFile(slim_zip)
    full = zipfile.ZipFile(full_zip)

    def zip_read(z, name):
        try:
            return z.read(name)
        except KeyError:
            return None

    def disk(path):
        try:
            return open(path, 'rb').read()
        except OSError:
            return None

    # The plugin, in every copy the two packages carry. Each is a place a user may take the plugin from,
    # so each has to be the same revision.
    for name in ('lib/index.js', 'lib/widget.js'):
        base = os.path.basename(name)
        source = disk(os.path.join(REPO, name))
        check('slim  plugin/%s' % name, zip_read(slim, 'plugin/%s' % name), source, problems)
        for prefix in ('2-\u63d2\u4ef6/dsh-mobile-public', '2-\u63d2\u4ef6'):
            check('full  %s/%s' % (prefix.split('/')[0], base),
                  zip_read(full, '%s/%s' % (prefix, name)), source, problems)

    # The tests travel with the plugin, so a reader can run them.
    for name in ('test/store-idle-test.mjs', 'test/selftest.mjs'):
        base = os.path.basename(name)
        source = disk(os.path.join(REPO, name))
        check('slim  plugin/%s' % name, zip_read(slim, 'plugin/%s' % name), source, problems)
        check('full  tests/%s' % base,
              zip_read(full, '2-\u63d2\u4ef6/dsh-mobile-public/%s' % name), source, problems)

    # The APK source, which the full package exists to carry.
    source_root = os.path.join(ROOT, 'apk')
    for name in ('AndroidManifest.xml', 'src/com/dshmobile/app/MainActivity.java',
                 'src/com/dshmobile/app/SplashView.java', 'res/values-v31/styles.xml',
                 'res/values/strings.xml', 'assets/diag.js'):
        source = disk(os.path.join(source_root, name.replace('/', os.sep)))
        check('full  source/%s' % name,
              zip_read(full, '4-\u6e90\u7801/apk/%s' % name), source, problems)

    # And the APK itself, in both packages. Read from inside the archive rather than from `out/`, which
    # holds only the newest build — the first version of this check looked for the file on disk and
    # reported the slim package's own copy as missing whenever `out` had been cleared.
    def apk_bytes(z, name):
        for entry in z.namelist():
            if entry.endswith(name):
                return z.read(entry)
        return None

    slim_apk = apk_bytes(slim, apk)
    full_apk = apk_bytes(full, apk)
    check('apk in slim', slim_apk, full_apk, problems)
    check('apk non-empty', None if not slim_apk else 'ok', 'ok', problems)

    # Whole-tree comparison of the staged source, so a file nobody thought to list is still covered.
    staged = os.path.join(FULL, '4-\u6e90\u7801', 'apk')
    if not os.path.isdir(staged):
        problems.append('staged source tree missing')
        print('  MISS  staged source tree')
    else:
        disk_tree = {}
        for root, _dirs, files in os.walk(source_root):
            for name in files:
                path = os.path.join(root, name)
                disk_tree[os.path.relpath(path, source_root)] = sha(open(path, 'rb').read())
        staged_tree = {}
        for root, _dirs, files in os.walk(staged):
            for name in files:
                path = os.path.join(root, name)
                staged_tree[os.path.relpath(path, staged)] = sha(open(path, 'rb').read())
        missing = sorted(set(disk_tree) - set(staged_tree))
        extra = sorted(set(staged_tree) - set(disk_tree))
        differing = sorted(k for k in set(disk_tree) & set(staged_tree)
                           if disk_tree[k] != staged_tree[k])
        if missing or extra or differing:
            print('  FAIL  staged source tree: missing=%d extra=%d differing=%d'
                  % (len(missing), len(extra), len(differing)))
            for k in (missing + extra + differing)[:8]:
                print('          %s' % k)
            problems.append('staged source tree differs')
        else:
            print('  ok    staged source tree (%d files)' % len(disk_tree))

    print()
    if problems:
        print('  %d problem(s)' % len(problems))
        return 1
    print('  packages match the tree')
    return 0


if __name__ == '__main__':
    sys.exit(main())
