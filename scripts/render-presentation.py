#!/usr/bin/env python3
"""Render only the approved PDF pages into local website assets with Poppler and Pillow."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

from PIL import Image


PAGES = [*range(1, 11), *range(12, 16)]
ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'fe/public/presentation')
    args = parser.parse_args()
    pdf = args.pdf.resolve(strict=True)
    info = subprocess.check_output(['pdfinfo', str(pdf)], text=True)
    count = int(re.search(r'^Pages:\s+(\d+)', info, re.MULTILINE)[1])
    if count < max(PAGES):
        raise ValueError('The presentation must contain at least 15 pages.')
    args.output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix='onmaul-presentation-') as temporary:
        def render(page):
            prefix = Path(temporary) / f'page-{page:02d}'
            subprocess.run([
                'pdftoppm', '-f', str(page), '-l', str(page), '-singlefile',
                '-scale-to', '2400', '-png', str(pdf), str(prefix),
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            destination = args.output / f'page-{page:02d}.webp'
            with Image.open(prefix.with_suffix('.png')) as image:
                image.convert('RGB').save(destination, 'WEBP', quality=95, method=6)
                width, height = image.size
            text = subprocess.check_output([
                'pdftotext', '-layout', '-f', str(page), '-l', str(page), str(pdf), '-',
            ], text=True).replace('\f', '').strip()
            title = next((line.strip() for line in text.splitlines() if line.strip()), '온 마을 서비스 소개')
            return {
                'page': page, 'image': f'/presentation/{destination.name}',
                'width': width, 'height': height, 'title': title, 'text': text,
            }

        with ThreadPoolExecutor(max_workers=4) as pool:
            slides = list(pool.map(render, PAGES))
    manifest = {
        'sourceName': pdf.name,
        'sourceSha256': hashlib.sha256(pdf.read_bytes()).hexdigest(),
        'originalPageCount': count,
        'slides': slides,
    }
    (args.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f'Rendered {len(slides)} pages: {PAGES}. Original PDF and omitted pages are not website assets.')


if __name__ == '__main__':
    main()
