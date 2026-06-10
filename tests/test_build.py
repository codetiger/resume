"""Tests for the static-résumé builder (build.py)."""

import base64
import json
import zlib

import build


def load_resume() -> dict:
    return json.loads((build.RESUME_PATH).read_text(encoding="utf-8"))


def test_format_date() -> None:
    assert build.format_date("2023-11-02") == "Nov 2023"
    assert build.format_date("") == "Present"
    assert build.format_date(None) == "Present"
    assert build.format_date("garbage") == "garbage"


def test_format_year() -> None:
    assert build.format_year("2000-05-04") == "2000"
    assert build.format_year(None) == "Present"


def test_strip_url() -> None:
    assert build.strip_url("https://www.example.com/x") == "example.com/x"
    assert build.strip_url("http://example.com") == "example.com"
    assert build.strip_url("") == ""
    assert build.strip_url(None) is None


def test_minify_css_collapses_and_keeps_rules() -> None:
    assert build.minify_css("body {\n  color: red;\n}\n") == "body{color:red}"
    # Leading-zero shorthand.
    assert build.minify_css("a{margin:0.5rem}") == "a{margin:.5rem}"


def test_minify_js_preserves_string_literals() -> None:
    out = build.minify_js('var u = "http://x//y"; // strip me\nvar z = 1;')
    assert "http://x//y" in out  # // inside a string survives
    assert "strip me" not in out  # the line comment is removed


def test_prebake_data_is_deterministic() -> None:
    resume = load_resume()
    assert build.prebake_data(resume) == build.prebake_data(resume)


def test_prebake_data_decodes_to_structured_text() -> None:
    resume = load_resume()
    raw = zlib.decompress(base64.b64decode(build.prebake_data(resume))).decode("utf-8")
    lines = raw.split("\n")
    assert lines[0] == resume["basics"]["name"]  # first field is the name
    assert any(line.startswith("J\t") for line in lines)  # at least one job row


def test_full_build_is_deterministic() -> None:
    # Guards the whole pipeline (avatar mosaic + render + minify) against
    # nondeterminism; regenerates the gitignored assets/resume.html.
    build.build()
    first = build.OUTPUT_PATH.read_bytes()
    build.build()
    assert build.OUTPUT_PATH.read_bytes() == first
