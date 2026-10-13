r"""Check that the README's APK table matches the file actually in dist/.

Written because the same mistake happened twice: the version number in that table was
updated while the size and SHA-256 next to it were left behind, which is worse than having no
数字 at all — a reader who verifies a download against a stale hash concludes the file is
tampered with.

Run before every push:

    python verify_readme_apk.py
"""

import hashlib
import os
import re
import sys

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'repo')
README = os.path.join(REPO, 'README.md')
DIST = os.path.join(REPO, 'dist')

ROW = re.compile(r'\|\s*(\d+\.\d+)\s*\|\s*\[`dist/([^`]+)`\][^|]*\|\s*([\d.]+\s*KB)\s*\|\s*`([0-9A-Fa-f]{8,})`\s*\|')


def main():
    if not os.path.exists(README):
        print('README not found: ' + README)
        return 1
    if not os.path.isdir(DIST):
        print('dist not found: ' + DIST)
        return 1

    text = open(README, encoding='utf-8').read()
    rows = ROW.findall(text)
    if not rows:
        print('FAIL: no APK row found in the README table')
        return 1

    apks = [f for f in os.listdir(DIST) if f.endswith('.apk')]
    problems = []
    for version, filename, size_text, hash_prefix in rows:
        path = os.path.join(DIST, filename)
        if not os.path.exists(path):
            problems.append('row %s names %s, which is not in dist/' % (version, filename))
            continue
        data = open(path, 'rb').read()
        real_hash = hashlib.sha256(data).hexdigest().upper()
        real_kb = len(data) / 1024.0
        # The hash is written truncated to 16 hex characters.
        if not real_hash.startswith(hash_prefix.upper()):
            problems.append('row %s: README hash %s... but the file is %s...'
                            % (version, hash_prefix.upper(), real_hash[:16]))
        documented_kb = float(size_text.split()[0])
        if abs(documented_kb - real_kb) > 0.15:
            problems.append('row %s: README says %.1f KB but the file is %.1f KB'
                            % (version, documented_kb, real_kb))
        print('  row %-5s %-24s %8.1f KB  %s' % (version, filename, real_kb, real_hash[:16]))

    for apk in apks:
        if apk not in [r[1] for r in rows]:
            problems.append('%s is in dist/ but has no README row' % apk)

    print()
    if problems:
        for p in problems:
            print('FAIL: ' + p)
        print('%d problem(s)' % len(problems))
        return 1
    print('README APK table matches dist/ (%d row(s), %d file(s))' % (len(rows), len(apks)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
