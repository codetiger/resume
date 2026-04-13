# Resume

Static HTML resume built from structured JSON data using Python and Jinja2 templating.

Demo — [Harishankar Narayanan](https://codetiger.github.io/resume/public/)

## Setup

```bash
pip3 install -r requirements.txt
```

## Build

Edit `resume.json` with your content (follows the [JSON Resume](https://jsonresume.org/schema/) schema), then run:

```bash
python3 build.py
```

This renders `resume.json` + `template.html` into `public/index.html`, which is served via GitHub Pages.

## Customise

- **Content:** Edit `resume.json`
- **Design/layout:** Edit `template.html` (Jinja2 template with all CSS inlined)
- **Profile photo:** Update the `pictures` array in `resume.json` with your image paths
