#!/usr/bin/env python3
"""Regenerates icon-192.png / icon-512.png: a simple accent-colored circle on navy,
no external dependencies (pure stdlib zlib/struct PNG encoder). Run from this directory:
    python3 generate.py
"""
import struct, zlib, os

def png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

def make_png(path, size, bg=(5, 15, 36), fg=(0, 164, 254)):
    w = h = size
    r = size * 0.28
    cx = cy = size / 2
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            dx, dy = x - cx, y - cy
            row += bytes(fg) if dx * dx + dy * dy <= r * r else bytes(bg)
        rows.append(bytes(row))
    raw = b"".join(rows)
    compressed = zlib.compress(raw, 9)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    out = sig + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", compressed) + png_chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(out)

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    make_png(os.path.join(here, "icon-192.png"), 192)
    make_png(os.path.join(here, "icon-512.png"), 512)
    print("wrote icon-192.png and icon-512.png")
