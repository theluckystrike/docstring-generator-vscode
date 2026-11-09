# Compose the README images from real gate screenshots (crop only, no edits to the content).
from PIL import Image
import os, sys
D, S, P = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(P, exist_ok=True)
def pair(a, b, box_a, box_b, out, gap=14, bg=(30, 30, 30)):
    A = Image.open(a).crop(box_a); B = Image.open(b).crop(box_b)
    h = max(A.height, B.height); im = Image.new('RGB', (A.width + B.width + gap, h), bg)
    im.paste(A, (0, 0)); im.paste(B, (A.width + gap, 0)); im.save(out, optimize=True); print(out, im.size)
pair(f'{D}/suggest-dark.png', f'{D}/generate-dark.png', (0, 30, 900, 650), (0, 30, 900, 740), f'{P}/generate-dark.png')
pair(f'{D}/update-before.png', f'{D}/update-dark.png', (0, 30, 960, 520), (0, 30, 960, 560), f'{P}/update-dark.png')
tiles = [Image.open(f'{S}/style-{s}-top.png').crop((355, 160, 1000, 440)) for s in ['google', 'numpy', 'sphinx', 'epytext']]
w = max(t.width for t in tiles); h = max(t.height for t in tiles)
im = Image.new('RGB', (2 * w + 14, 2 * h + 14), (30, 30, 30))
for i, t in enumerate(tiles): im.paste(t, ((i % 2) * (w + 14), (i // 2) * (h + 14)))
im.save(f'{P}/styles.png', optimize=True); print('styles', im.size)
