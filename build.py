#!/usr/bin/env python3
"""Build public/index.html from resume.json + template.html using Jinja2."""

import base64
import json
import re
import zlib
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

ROOT = Path(__file__).resolve().parent
RESUME_PATH = ROOT / "resume.json"
TEMPLATE_NAME = "template.html"
OUTPUT_PATH = ROOT / "public" / "index.html"
AVATAR_SIZE = 144
HEX_RADIUS = 1.5     # fine grid radius (data resolution)
INDEX_BITS = 6       # bits per cell; palette = 2^INDEX_BITS - 1 colors + transparent at index 0


def format_date(value):
    """'2023-11-02' → 'Nov 2023', None/empty → 'Present'."""
    if not value:
        return "Present"
    try:
        dt = datetime.strptime(value[:10], "%Y-%m-%d")
        return dt.strftime("%b %Y")
    except (ValueError, TypeError):
        return value


def format_year(value):
    """'2000-05-04' → '2000', None/empty → 'Present'."""
    if not value:
        return "Present"
    try:
        return str(datetime.strptime(value[:10], "%Y-%m-%d").year)
    except (ValueError, TypeError):
        return value


def strip_url(url):
    """Strip protocol prefix from URL. Renderer prepends https:// on the client."""
    if not url:
        return url
    for prefix in ('https://www.', 'http://www.', 'https://', 'http://'):
        if url.startswith(prefix):
            return url[len(prefix):]
    return url


def prebake_data(resume):
    """Pack resume data into a compact text blob, compress, and base64 encode.

    Format: tab-separated fields, newline-separated rows, blank lines between sections.
    All dates pre-formatted. Sections: basics, work, skills, projects, awards, education.
    """
    lines = []
    b = resume.get("basics", {})
    loc = b.get("location", {})

    # Section 0: basics — name, label, summary, pre-baked contact HTML, pre-baked profile HTML
    lines.append(b.get("name", ""))
    lines.append(b.get("label", ""))
    lines.append(b.get("summary", ""))

    # Pre-bake contact info HTML
    ct_parts = []
    city = loc.get("city", "")
    region = loc.get("region", loc.get("countryCode", ""))
    if city:
        ct_parts.append(f'<span>{city}, {region}</span><span class="d">&middot;</span>')
    email = b.get("email", "")
    if email:
        ct_parts.append(f'<span><a href="mailto:{email}">{email}</a></span>')
    phone = b.get("phone", "")
    if phone:
        ct_parts.append(f'<span class="d">&middot;</span><span><a href="tel:{phone}">{phone}</a></span>')
    lines.append("".join(ct_parts))

    # Pre-bake profile links HTML
    pl_parts = []
    for p in b.get("profiles", []):
        pl_parts.append(f'<a href="{strip_url(p.get("url", ""))}">{p["network"]}</a>')
    lines.append("".join(pl_parts))
    lines.append("")  # section break

    # Section 1: work — J prefix for job header, bare lines for highlights, -- between entries
    work = resume.get("work", [])
    for i, job in enumerate(work):
        date_range = f"{format_date(job.get('startDate', ''))} \u2014 {format_date(job.get('endDate', ''))}"
        lines.append(f"J\t{job['position']}\t{date_range}\t{job['company']}\t{job.get('summary', '')}")
        for h in job.get("highlights", []):
            lines.append(h)
        if i < len(work) - 1:
            lines.append("--")
    lines.append("")  # section break

    # Section 2: skills — tab-separated name + keywords per line
    for s in resume.get("skills", []):
        lines.append(s["name"] + "\t" + "\t".join(s.get("keywords", [])))
    lines.append("")

    # Section 3: projects — P prefix, then summary or highlights
    volunteer = resume.get("volunteer", [])
    if volunteer:
        for i, v in enumerate(volunteer):
            lines.append(f"P\t{v['organization']}\t{v.get('summary', '')}")
            for h in v.get("highlights", []):
                lines.append(h)
            if i < len(volunteer) - 1:
                lines.append("--")
    else:
        lines.append(" ")
    lines.append("")

    # Section 4: awards — all fields tab-separated, date+awarder pre-formatted
    for a in resume.get("awards", []):
        date_str = format_date(a.get("date", ""))
        awarder = a.get("awarder", "")
        parts = [p for p in [awarder, date_str] if p and p != "Present"]
        meta = " \u00b7 ".join(parts)
        lines.append(f"{a['title']}\t{meta}\t{a.get('summary', '')}")
    lines.append("")

    # Section 5: education — pre-formatted degree line, year range, institution
    for e in resume.get("education", []):
        degree = e.get("studyType", "")
        area = e.get("area", "")
        title = f"{degree} \u2014 {area}" if area else degree
        years = f"{format_year(e.get('startDate', ''))} \u2014 {format_year(e.get('endDate', ''))}"
        lines.append(f"{title}\t{years}\t{e.get('institution', '')}")

    raw = "\n".join(lines).encode("utf-8")
    compressed = zlib.compress(raw, 9)
    b64 = base64.b64encode(compressed).decode("ascii")
    print(f"Resume data: {len(raw):,} → zlib: {len(compressed):,} → base64: {len(b64):,} bytes")
    return b64


def build_avatar_mesh(image_path):
    """Generate compressed hex mosaic data from single avatar image."""
    if not image_path or not image_path.exists():
        print("No avatar image found, skipping mesh generation")
        return None
    from triangulate import export_hex_mosaic
    return export_hex_mosaic(str(image_path), HEX_RADIUS, AVATAR_SIZE, INDEX_BITS)


def inline_css_vars(css):
    """Inline CSS custom properties, removing the :root block.

    Keeps variables where inlining would increase size (value longer than
    var() reference AND used more than once).
    """
    root_m = re.search(r':root\{([^}]+)\}', css)
    if not root_m:
        return css
    var_values = {}
    for m in re.finditer(r'(--[\w-]+):([^;]+)', root_m.group(1)):
        var_values[m.group(1)] = m.group(2).strip()
    rest = css[root_m.end():]
    keep = {}
    for var, val in var_values.items():
        ref = f'var({var})'
        uses = rest.count(ref)
        if len(val) > len(ref) and uses > 1:
            keep[var] = val
        else:
            css = css.replace(ref, val)
    if keep:
        new_root = ':root{' + ';'.join(f'{v}:{keep[v]}' for v in keep) + '}'
        css = css[:root_m.start()] + new_root + css[root_m.end():]
    else:
        css = css[:root_m.start()] + css[root_m.end():]
    return css


def minify_css(css):
    """Strip comments, collapse whitespace, remove redundant chars from CSS."""
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.DOTALL)  # block comments
    css = re.sub(r'\s+', ' ', css)                         # collapse whitespace
    css = re.sub(r'\s*([{}:;,>~+])\s*', r'\1', css)       # spaces around punctuation
    css = re.sub(r';}', '}', css)                          # trailing semicolons
    css = inline_css_vars(css)
    css = re.sub(r'(?<![0-9])0(\.\d+)', r'\1', css)  # 0.5rem → .5rem
    return css.strip()


def minify_js(js):
    """Strip comments, collapse whitespace in JS. Preserves string literals."""
    # Extract string literals to protect them from mangling
    strings = []
    def _save_string(m):
        strings.append(m.group(0))
        return f'\x00STR{len(strings) - 1}\x00'
    js = re.sub(r'"[^"\\]*(?:\\.[^"\\]*)*"|\'[^\'\\]*(?:\\.[^\'\\]*)*\'', _save_string, js)

    js = re.sub(r'//.*?$', '', js, flags=re.MULTILINE)    # line comments
    js = re.sub(r'/\*.*?\*/', '', js, flags=re.DOTALL)    # block comments
    js = re.sub(r'\s+', ' ', js)                           # collapse whitespace
    js = re.sub(r'\s*([{}();,=<>+\-*/?:|&!])\s*', r'\1', js)

    # Restore string literals
    def _restore_string(m):
        return strings[int(m.group(1))]
    js = re.sub(r'\x00STR(\d+)\x00', _restore_string, js)
    return js.strip()


def minify_html(html):
    """Minify the final HTML by processing CSS, JS, and HTML separately."""
    # Minify inline <style> blocks
    def _min_style(m):
        return '<style>' + minify_css(m.group(1)) + '</style>'
    html = re.sub(r'<style>(.*?)</style>', _min_style, html, flags=re.DOTALL)

    # Minify inline <script> blocks (but preserve string literals like base64)
    def _min_script(m):
        return '<script>' + minify_js(m.group(1)) + '</script>'
    html = re.sub(r'<script>(.*?)</script>', _min_script, html, flags=re.DOTALL)

    # HTML: collapse inter-tag whitespace, runs of spaces
    html = re.sub(r'>\s+<', '><', html)
    html = re.sub(r'\s{2,}', ' ', html)
    return html.strip()


def build():
    resume = json.loads(RESUME_PATH.read_text(encoding="utf-8"))
    picture = resume.get("basics", {}).get("picture", "")
    avatar_path = ROOT / picture if picture else None
    avatar_mesh_b64 = build_avatar_mesh(avatar_path)

    env = Environment(
        loader=FileSystemLoader(ROOT),
        autoescape=False,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["format_date"] = format_date
    env.filters["format_year"] = format_year

    resume_data_b64 = prebake_data(resume)

    template = env.get_template(TEMPLATE_NAME)
    html = template.render(
        avatar_mesh_b64=avatar_mesh_b64,
        resume_data_b64=resume_data_b64,
    )

    raw_size = len(html.encode('utf-8'))
    html = minify_html(html)
    min_size = len(html.encode('utf-8'))

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(html, encoding="utf-8")
    print(f"Built {OUTPUT_PATH.relative_to(ROOT)}")
    print(f"Size: {raw_size:,} → {min_size:,} bytes (minified {raw_size - min_size:,})")


if __name__ == "__main__":
    build()
