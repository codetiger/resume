"""
Hex Mosaic Generator

Generates a hexagonal mosaic from avatar images for embedding in the resume.
Colors are sampled at hex cell centers and encoded via a shared k-means palette,
then deflate-compressed and base64-encoded for inline use.

Used by build.py via: from triangulate import export_hex_mosaic
"""

import base64
import io
import math
import struct
import zlib
from collections.abc import Iterable
from pathlib import Path

import numpy as np
from PIL import Image, UnidentifiedImageError


def _open_image(image_path: str | Path) -> Image.Image:
    """Open an image, raising a clear error if it's missing or undecodable
    (instead of a bare FileNotFoundError / UnidentifiedImageError from PIL)."""
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(f"avatar image not found: {path}")
    try:
        return Image.open(path)
    except UnidentifiedImageError as e:
        raise ValueError(f"cannot decode avatar image {path}: {e}") from e


def _pack_bits(values: Iterable[int], bits: int) -> bytes:
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


def export_hex_mosaic(
    image_path: str | Path,
    hex_radius: int = 2,
    canvas_size: int = 144,
    index_bits: int = 5,
    coarse_factor: int = 2,
) -> str:
    """Export hex mosaic data for a single image as deflate-compressed base64.

    Generates a pointy-top hexagonal grid inside an inscribed circle.
    Client draws the coarse grid (the hidden state) and reveals the real photo
    underneath on hover. The coarse hexagon size is hex_radius * coarse_factor;
    both radii travel in the header so the client never hardcodes the factor.

    Palette holds 2^index_bits colors (indices 0..nc-1).

    Binary layout (little-endian):
        [uint8 fine_radius×10]      fine hex radius (fixed-point ×10)
        [uint8 coarse_radius×10]    coarse/hidden hex radius (fixed-point ×10)
        [uint8 index_bits]          bits per cell index
        [uint16 n_cells]            number of cells
        [uint8 r,g,b] * nc          palette (nc = 2^index_bits)
        [packed bits]               ceil(n_cells * index_bits / 8) bytes
    """
    palette_size = 1 << index_bits
    coarse_radius = hex_radius * coarse_factor
    cr = canvas_size / 2.0  # circle radius

    # Generate pointy-top hex grid at fine resolution
    dx = math.sqrt(3) * hex_radius
    dy = 1.5 * hex_radius
    cells = []  # (cx, cy) in canvas pixel coords
    for row in range(int(canvas_size / dy) + 2):
        for col in range(int(canvas_size / dx) + 2):
            cx = col * dx + (dx / 2 if row % 2 else 0)
            cy = row * dy
            dist = math.sqrt((cx - cr) ** 2 + (cy - cr) ** 2)
            if dist + hex_radius * 0.8 <= cr:
                cells.append((cx, cy))

    n_cells = len(cells)
    print(f"Hex grid: fine r={hex_radius}px, coarse r={coarse_radius}px, {n_cells} cells")

    # Step 1: Load image and sample at cell centers (full color depth)
    img = _open_image(image_path).convert("RGB")
    img = img.resize((canvas_size, canvas_size), Image.Resampling.LANCZOS)
    rgb = np.array(img)

    all_sampled = []
    for cx, cy in cells:
        px = min(int(cx), canvas_size - 1)
        py = min(int(cy), canvas_size - 1)
        all_sampled.append(rgb[py, px])

    # Step 2: Quantize only the sampled colors.
    # MEDIANCUT is deterministic within a Pillow version but the palette it picks
    # can shift across versions — that's why Pillow is pinned in requirements.txt
    # (an unpinned bump would change the generated resume.html byte-for-byte).
    sample_img = Image.new("RGB", (len(all_sampled), 1))
    for k, c in enumerate(all_sampled):
        sample_img.putpixel((k, 0), (int(c[0]), int(c[1]), int(c[2])))
    quantized_sample = sample_img.quantize(colors=palette_size, method=Image.Quantize.MEDIANCUT)

    pal_data = quantized_sample.getpalette()
    assert pal_data is not None  # a quantized ('P'-mode) image always has a palette
    # Always pad to full palette_size so JS decoder reads correct offset
    palette = np.array(pal_data[: palette_size * 3], dtype=np.uint8).reshape(palette_size, 3)
    nc = palette_size

    # Step 3: Map each cell to nearest palette entry (0-based)
    labels = np.empty(n_cells, dtype=np.uint8)
    for j in range(n_cells):
        color = all_sampled[j]
        dists = np.sum((palette.astype(int) - color.astype(int)) ** 2, axis=1)
        labels[j] = np.argmin(dists)

    # Pack binary: header + palette + bit-packed indices
    buf = struct.pack(
        "<BBBH", round(hex_radius * 10), round(coarse_radius * 10), index_bits, n_cells
    )
    buf += palette.tobytes()
    buf += _pack_bits(labels, index_bits)

    raw_size = len(buf)
    compressed = zlib.compress(buf, 9)
    encoded = base64.b64encode(compressed).decode("ascii")

    print(f"Palette: {nc} colors")
    print(f"Binary: {raw_size:,} bytes → deflate: {len(compressed):,} → base64: {len(encoded):,}")
    return encoded


def export_photo(image_path: str | Path, size: int = 432, quality: int = 88) -> str:
    """Embed the real avatar photo as a square base64 JPEG.

    This is the layer revealed pixel-by-pixel when the hex mosaic lifts on hover,
    so it is sized for crispness (default 3x the 144px avatar), not for byte count.
    Stretched to a square the same way the mosaic samples it, so the two align.
    """
    img = _open_image(image_path).convert("RGB").resize((size, size), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality, optimize=True)
    data = out.getvalue()
    encoded = base64.b64encode(data).decode("ascii")
    print(f"Photo: {size}x{size} JPEG {len(data):,} bytes → base64: {len(encoded):,}")
    return encoded
