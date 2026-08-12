#!/usr/bin/env python3
# Overlay a label in Didot Italic (top-left) onto a base PNG.
# Usage: _overlay-label.py <in.png> <out.png> "<label>"
#
# Didot.ttc subfont indices (verified via fc-query):
#   0 Didot Regular, 1 Didot Italic, 2 Didot Bold
import sys
from PIL import Image, ImageDraw, ImageFont

in_path, out_path, label = sys.argv[1], sys.argv[2], sys.argv[3]
TTC = "/System/Library/Fonts/Supplemental/Didot.ttc"
SIZE_PT = 96
PAD = 100

img = Image.open(in_path).convert("RGBA")
draw = ImageDraw.Draw(img)

# Try Didot Italic (index 1); fall back to Regular if missing.
try:
    font = ImageFont.truetype(TTC, SIZE_PT, index=1)
except Exception:
    font = ImageFont.truetype(TTC, SIZE_PT, index=0)

draw.text((PAD, PAD), label, fill=(28, 28, 30, 255), font=font)
img.save(out_path, "PNG", optimize=True)
