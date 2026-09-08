#!/usr/bin/env python3
"""Re-inline client/logo-banner.svg into client/app.html.

The banner lives in the header bar and is inlined rather than <img>-linked,
because an external SVG cannot read the page's CSS theme variables. That means
the markup exists in two files, and editing the .svg alone silently leaves the
app rendering the old artwork with no error to show for it. Run this after any
change to logo-banner.svg.

    python scripts/sync-logo.py
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG = os.path.join(ROOT, 'client', 'logo-banner.svg')
HTML = os.path.join(ROOT, 'client', 'app.html')

NOTE = ('<!-- Generated from client/logo-banner.svg by scripts/sync-logo.py.\n'
        '     Edit that file and re-run the script; do not hand-edit this block. -->')

ROOT_TAG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 14 760 138" '
            'width="760" height="138" role="img" aria-label="BroFerence">')
INLINE_TAG = ('<svg class="header-banner" xmlns="http://www.w3.org/2000/svg" '
              'viewBox="0 14 760 138" role="img" aria-label="BroFerence">')

BLOCK_RE = re.compile(
    r'[ \t]*(?:<!-- Generated from client/logo-banner\.svg.*?-->\s*)?'
    r'<svg class="header-banner".*?</svg>',
    re.S)


def indent(block, pad):
    return "\n".join((pad + ln) if ln.strip() else ln for ln in block.split("\n"))


def main():
    with open(SVG, encoding='utf-8') as f:
        svg = f.read().rstrip()

    if ROOT_TAG not in svg:
        sys.exit('logo-banner.svg root <svg> tag is not what this script expects')
    block = NOTE + "\n" + svg.replace(ROOT_TAG, INLINE_TAG)

    with open(HTML, encoding='utf-8') as f:
        html = f.read()

    m = BLOCK_RE.search(html)
    if not m:
        sys.exit('could not find the header banner block in app.html')

    html = html[:m.start()] + indent(block, ' ' * 12) + html[m.end():]
    with open(HTML, 'w', encoding='utf-8', newline='') as f:
        f.write(html)

    print('synced the header banner from logo-banner.svg')


if __name__ == '__main__':
    main()
