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
from scipy.cluster.vq import kmeans2


def export_hex_mosaic(image_paths, hex_radius=4, canvas_size=144, palette_size=128):
    """Export hex mosaic data for multiple images as deflate-compressed base64.

    Generates a pointy-top hexagonal grid inside an inscribed circle.
    Colors are sampled from each image and indexed via a shared k-means palette.
    Grid positions are deterministic and recomputed client-side.

    Binary layout (little-endian):
        [uint8 hex_radius]          hex cell radius in canvas pixels
        [uint8 nc]                  palette size
        [uint8 n_images]            number of images
        [uint16 n_cells]            number of hex cells
        [uint8 r,g,b] * nc          shared color palette
        [uint8 idx] * n_cells       image 0 color indices
        [uint8 idx] * n_cells       image 1 color indices (if present)
        ...
    """
    cr = canvas_size / 2.0  # circle radius

    # Generate pointy-top hex grid inside circle
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
    n_images = len(image_paths)
    print(f"Hex grid: r={hex_radius}px, {n_cells} cells, {n_images} images")

    # Sample colors from each image at cell centers (255 = transparent)
    all_opaque_colors = []
    image_colors = []    # RGB per cell (only meaningful for opaque cells)
    image_alpha = []     # True = opaque, False = transparent per cell
    for img_path in image_paths:
        img = Image.open(img_path).convert("RGBA")
        img = img.resize((canvas_size, canvas_size), Image.LANCZOS)
        rgba = np.array(img)
        alpha = rgba[:, :, 3]
        rgb = np.array(img.convert("RGB"))

        colors = []
        opaque_flags = []
        for cx, cy in cells:
            px = min(int(cx), canvas_size - 1)
            py = min(int(cy), canvas_size - 1)
            is_opaque = alpha[py, px] >= 128
            opaque_flags.append(is_opaque)
            if is_opaque:
                colors.append(rgb[py, px])
            else:
                colors.append([0, 0, 0])  # placeholder, won't enter palette
        colors = np.array(colors, dtype=np.uint8)
        image_colors.append(colors)
        image_alpha.append(opaque_flags)
        # Only include opaque cells in palette building
        opaque_colors = colors[np.array(opaque_flags)]
        if len(opaque_colors) > 0:
            all_opaque_colors.append(opaque_colors)

    # Build shared palette from opaque cells only
    combined = np.vstack(all_opaque_colors).astype(np.float64)
    nc = min(palette_size, len(np.unique(combined, axis=0)))
    palette, _ = kmeans2(combined, nc, minit='points', iter=20)
    palette = np.clip(np.round(palette), 0, 255).astype(np.uint8)

    # Map each image's colors to palette indices (255 = transparent)
    image_labels = []
    for colors, opaque_flags in zip(image_colors, image_alpha):
        dists = np.linalg.norm(
            colors[:, None].astype(float) - palette[None, :].astype(float), axis=2)
        labels = np.argmin(dists, axis=1).astype(np.uint8)
        # Mark transparent cells with sentinel 255
        for i, is_opaque in enumerate(opaque_flags):
            if not is_opaque:
                labels[i] = 255
        image_labels.append(labels)

    # Pack binary
    buf = struct.pack('<BBBH', hex_radius, nc, n_images, n_cells)
    buf += palette.tobytes()
    for labels in image_labels:
        buf += labels.tobytes()

    raw_size = len(buf)
    compressed = zlib.compress(buf, 9)
    encoded = base64.b64encode(compressed).decode('ascii')

    print(f"Palette: {nc} colors")
    print(f"Binary: {raw_size:,} bytes → deflate: {len(compressed):,} → base64: {len(encoded):,}")
    return encoded
