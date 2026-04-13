# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A JSON Resume builder that renders a static HTML resume from structured JSON data. Uses a Python build script with Jinja2 templating. The output is hosted via GitHub Pages at `public/index.html`.

## Commands

- **Render resume:** `python3 build.py` — renders `resume.json` + `template.html` into `public/index.html`
- **Install dependencies:** `pip3 install -r requirements.txt`

## Architecture

Rendering pipeline: `resume.json` + `template.html` → `build.py` (Jinja2) → `public/index.html`

- `resume.json` — single source of truth for all resume content, following the [JSON Resume](https://jsonresume.org/schema/) schema. All content changes go here.
- `template.html` — Jinja2 HTML template with all CSS inlined. Edit this to change design/layout.
- `build.py` — Python build script that reads `resume.json`, renders via Jinja2, and writes `public/index.html`. Provides custom filters: `format_date` (YYYY-MM-DD → "Mon YYYY") and `format_year` (YYYY-MM-DD → "YYYY").
- `public/index.html` — generated output, served via GitHub Pages. **Do not edit by hand**; regenerate with `python3 build.py`.

After editing `resume.json` or `template.html`, always run `python3 build.py` to regenerate the HTML.
