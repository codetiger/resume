// Renders the static résumé page body from assets/resume.json. This is the single
// build-time source for the no-JS / no-WebGL fallback (the game's companion page):
// vite.config.ts's `static-resume` plugin calls renderResume() and injects the result
// into resume.html, so the content ships as plain HTML — no client JS, no Python.
//
// Kept framework-free and pure (data in → HTML string out) so it unit-tests headlessly
// and can run inside the Vite config. Classes mirror resume.html's stylesheet.

export interface Resume {
  basics: {
    name: string;
    label?: string;
    picture?: string;
    email?: string;
    summary?: string;
    location?: { city?: string; region?: string; countryCode?: string };
    profiles?: { network: string; url?: string }[];
  };
  work?: {
    position: string;
    company: string;
    startDate?: string;
    endDate?: string;
    summary?: string;
    highlights?: string[];
  }[];
  skills?: { name: string; keywords?: string[] }[];
  volunteer?: { organization: string; summary?: string; highlights?: string[] }[];
  awards?: { title: string; awarder?: string; date?: string; summary?: string }[];
  education?: {
    studyType?: string;
    area?: string;
    startDate?: string;
    endDate?: string;
    institution: string;
  }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2023-11-02' → 'Nov 2023'; empty → 'Present'. */
function fmtDate(value?: string): string {
  if (!value) return 'Present';
  const m = /^(\d{4})-(\d{2})/.exec(value);
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : value;
}

/** '2000-05-04' → '2000'; empty → 'Present'. */
function fmtYear(value?: string): string {
  if (!value) return 'Present';
  const m = /^(\d{4})/.exec(value);
  return m ? m[1] : value;
}

/** Strip the protocol (and www.) so links render bare; the href re-adds `//`. */
function stripUrl(url?: string): string {
  return (url ?? '').replace(/^https?:\/\/(www\.)?/, '');
}

/** Escape text taken from résumé content so it can't break the surrounding HTML. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function section(title: string, inner: string): string {
  return `<section class="sc"><h2 class="st">${title}</h2>${inner}</section>`;
}

function highlights(items?: string[]): string {
  if (!items?.length) return '';
  return `<ul class="eh">${items.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`;
}

/**
 * Render the résumé `<main class="pg">` inner HTML.
 * @param base deploy base path (`/` in dev, `/resume/` in the build) for the avatar src.
 */
export function renderResume(resume: Resume, base = '/'): string {
  const b = resume.basics;
  const out: string[] = [];

  // ── Header: avatar + name/role + contact + profile links ──────────────────
  // Strip any leading "./" or "/" so `${base}${picture}` yields a clean path.
  const picture = (b.picture || 'harishankar.jpeg').replace(/^\.?\//, '');
  const avatar = `<img class="av" src="${base}${esc(picture)}" alt="${esc(b.name)}" width="144" height="144" />`;

  const contact: string[] = [];
  const loc = b.location ?? {};
  const region = loc.region || loc.countryCode || '';
  if (loc.city) {
    contact.push(
      `<span>${esc(loc.city)}${region ? `, ${esc(region)}` : ''}</span><span class="d">&middot;</span>`,
    );
  }
  if (b.email) {
    contact.push(`<span><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></span>`);
  }
  // The phone is deliberately not shown here — it's unlocked by playing the game.
  contact.push(
    '<span class="d">&middot;</span><span><a href="./">Play the game for my number &#8594;</a></span>',
  );

  const profiles = (b.profiles ?? [])
    .map((p) => `<a href="//${esc(stripUrl(p.url))}">${esc(p.network)}</a>`)
    .join('');

  out.push(
    '<header class="hd">',
    avatar,
    '<div>',
    `<h1>${esc(b.name)}</h1>`,
    b.label ? `<div class="rl">${esc(b.label)}</div>` : '',
    `<div class="ct">${contact.join('')}</div>`,
    profiles ? `<div class="pl">${profiles}</div>` : '',
    '</div>',
    '</header>',
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  if (b.summary) out.push(section('Summary', `<p class="sm">${esc(b.summary)}</p>`));

  // ── Experience ────────────────────────────────────────────────────────────
  if (resume.work?.length) {
    const entries = resume.work
      .map((w) => {
        const range = `${fmtDate(w.startDate)} — ${fmtDate(w.endDate)}`;
        return [
          '<div class="en">',
          `<div class="et"><span class="er">${esc(w.position)}</span><span class="ed">${esc(range)}</span></div>`,
          `<div class="eo">${esc(w.company)}</div>`,
          w.summary ? `<p class="es">${esc(w.summary)}</p>` : '',
          highlights(w.highlights),
          '</div>',
        ].join('');
      })
      .join('');
    out.push(section('Experience', entries));
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  if (resume.skills?.length) {
    const cards = resume.skills
      .map((s) => {
        const tags = (s.keywords ?? []).map((k) => `<span>${esc(k)}</span>`).join('');
        return `<div class="sk"><div class="sn">${esc(s.name)}</div><div class="stg">${tags}</div></div>`;
      })
      .join('');
    out.push(section('Skills', `<div class="sg">${cards}</div>`));
  }

  // ── Open Source & Projects (volunteer) — skipped when empty ───────────────
  if (resume.volunteer?.length) {
    const entries = resume.volunteer
      .map((v) =>
        [
          '<div class="pj">',
          `<div class="pn">${esc(v.organization)}</div>`,
          v.summary ? `<p class="es">${esc(v.summary)}</p>` : '',
          highlights(v.highlights),
          '</div>',
        ].join(''),
      )
      .join('');
    out.push(section('Open Source &amp; Projects', entries));
  }

  // ── Awards & Recognition ──────────────────────────────────────────────────
  if (resume.awards?.length) {
    const entries = resume.awards
      .map((a) => {
        const meta = [a.awarder, fmtDate(a.date)].filter((p) => p && p !== 'Present').join(' · ');
        return [
          '<div class="aw">',
          `<div class="at">${esc(a.title)}</div>`,
          meta ? `<div class="am">${esc(meta)}</div>` : '',
          a.summary ? `<p class="as">${esc(a.summary)}</p>` : '',
          '</div>',
        ].join('');
      })
      .join('');
    out.push(section('Awards &amp; Recognition', entries));
  }

  // ── Education ─────────────────────────────────────────────────────────────
  if (resume.education?.length) {
    const entries = resume.education
      .map((e) => {
        const degree = e.area ? `${e.studyType ?? ''} — ${e.area}` : (e.studyType ?? '');
        const years = `${fmtYear(e.startDate)} — ${fmtYear(e.endDate)}`;
        return [
          '<div class="en">',
          `<div class="et"><span class="edd">${esc(degree)}</span><span class="edy">${esc(years)}</span></div>`,
          `<div class="edi">${esc(e.institution)}</div>`,
          '</div>',
        ].join('');
      })
      .join('');
    out.push(section('Education', entries));
  }

  out.push(
    '<footer class="ft">Prefer the interactive version? <a href="./">Play the résumé game →</a></footer>',
  );

  return out.filter(Boolean).join('\n');
}
