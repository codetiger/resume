"""
Hex Mosaic Generator

Generates a hexagonal mosaic from avatar images for embedding in the resume.
Colors are sampled at hex cell centers and encoded via a shared k-means palette,
then deflate-compressed and base64-encoded for inline use.

Used by build.py via: from triangulate import export_hex_mosaic
"""

import math
import struct
import zlib
import base64

import numpy as np
from PIL import Image


def _pack_bits(values, bits):
    """Pack an array of small integers into a bit stream, MSB first."""
    result = bytearray()
    buf = 0
    n = 0
    for v in values:
        buf = (buf << bits) | int(v)
        n += bits
        while n >= 8:
            n -= 8
            result.append((buf >> n) & 0xFF)
    if n > 0:
        result.append((buf << (8 - n)) & 0xFF)
    return bytes(result)


def export_hex_mosaic(image_path, hex_radius=2, canvas_size=144, index_bits=5):
    """Export hex mosaic data for a single image as deflate-compressed base64.

    Generates a pointy-top hexagonal grid inside an inscribed circle.
    Client derives coarse grid (1-level tessellation) for default display.

    Palette holds 2^index_bits colors (indices 0..nc-1).

    Binary layout (little-endian):
        [uint8 fine_radius×10]      hex radius (fixed-point ×10)
        [uint8 index_bits]          bits per cell index
        [uint16 n_cells]            number of cells
        [uint8 r,g,b] * nc          palette (nc = 2^index_bits)
        [packed bits]               ceil(n_cells * index_bits / 8) bytes
    """
    palette_size = 1 << index_bits
    cr = canvas_size / 2.0  # circle radius

    # Generate pointy-top hex grid at fine resolution
    dx = math.sqrt(3) * hex_radius
    dy = 1.5 * hex_radius
    cells = []  # (cx, cy) in canvas pixel coords
    for row in range(int(canvas_size / dy) + 2):
        for col in range(int(canvas_size / dx) + 2):
            cx = col * dx + (dx / 2 if row % 2 else 0)
            cy = row * dy
            dist = math.sqrt((cx - cr)**2 + (cy - cr)**2)
            if dist + hex_radius * 0.8 <= cr:
                cells.append((cx, cy))

    n_cells = len(cells)
    print(f"Hex grid: r={hex_radius}px, {n_cells} cells")

    # Step 1: Load image and sample at cell centers (full color depth)
    img = Image.open(image_path).convert("RGB")
    img = img.resize((canvas_size, canvas_size), Image.LANCZOS)
    rgb = np.array(img)

    all_sampled = []
    for cx, cy in cells:
        px = min(int(cx), canvas_size - 1)
        py = min(int(cy), canvas_size - 1)
        all_sampled.append(rgb[py, px])

    # Step 2: Quantize only the sampled colors
    sample_img = Image.new("RGB", (len(all_sampled), 1))
    for k, c in enumerate(all_sampled):
        sample_img.putpixel((k, 0), (int(c[0]), int(c[1]), int(c[2])))
    quantized_sample = sample_img.quantize(colors=palette_size, method=Image.Quantize.MEDIANCUT)

    pal_data = quantized_sample.getpalette()
    # Always pad to full palette_size so JS decoder reads correct offset
    palette = np.array(pal_data[:palette_size * 3], dtype=np.uint8).reshape(palette_size, 3)
    nc = palette_size

    # Step 3: Map each cell to nearest palette entry (0-based)
    labels = np.empty(n_cells, dtype=np.uint8)
    for j in range(n_cells):
        color = all_sampled[j]
        dists = np.sum((palette.astype(int) - color.astype(int)) ** 2, axis=1)
        labels[j] = np.argmin(dists)

    # Pack binary: header + palette + bit-packed indices
    buf = struct.pack('<BBH', round(hex_radius * 10), index_bits, n_cells)
    buf += palette.tobytes()
    buf += _pack_bits(labels, index_bits)

    raw_size = len(buf)
    compressed = zlib.compress(buf, 9)
    encoded = base64.b64encode(compressed).decode('ascii')

    print(f"Palette: {nc} colors")
    print(f"Binary: {raw_size:,} bytes → deflate: {len(compressed):,} → base64: {len(encoded):,}")
    return encoded
