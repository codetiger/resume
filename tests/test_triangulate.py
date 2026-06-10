"""Tests for the avatar hex-mosaic encoder (triangulate.py)."""

import triangulate


def unpack_bits(data: bytes, bits: int, n: int) -> list[int]:
    """Inverse of triangulate._pack_bits: read `n` MSB-first values of `bits` each."""
    values: list[int] = []
    buf = 0
    nbits = 0
    bi = 0
    mask = (1 << bits) - 1
    for _ in range(n):
        while nbits < bits:
            buf = (buf << 8) | data[bi]
            bi += 1
            nbits += 8
        nbits -= bits
        values.append((buf >> nbits) & mask)
    return values


def test_pack_bits_roundtrips_across_widths() -> None:
    for bits in (1, 2, 3, 4, 5, 8):
        hi = (1 << bits) - 1
        values = [(i * 7 + 3) & hi for i in range(37)]
        packed = triangulate._pack_bits(values, bits)
        assert unpack_bits(packed, bits, len(values)) == values


def test_pack_bits_packs_tightly() -> None:
    # 8 three-bit values = 24 bits = exactly 3 bytes.
    assert len(triangulate._pack_bits([7] * 8, 3)) == 3
    # 5 five-bit values = 25 bits -> 4 bytes (last byte padded).
    assert len(triangulate._pack_bits([1] * 5, 5)) == 4


def test_open_image_rejects_missing_file() -> None:
    try:
        triangulate._open_image("does/not/exist.png")
    except FileNotFoundError as e:
        assert "not found" in str(e)
    else:  # pragma: no cover
        raise AssertionError("expected FileNotFoundError")
