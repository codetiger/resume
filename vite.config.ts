import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSONPath } from 'jsonpath-plus';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RESUME_PATH = resolve(ROOT, 'resume.json');
const LEVELS_PATH = resolve(ROOT, 'src/game/levels.json');

// Resolve any string value that is a JSONPath reference ("$…") against
// resume.json, so the résumé prose lives in exactly one place. Inside an array, a
// ref that resolves to an array is flattened in (e.g. a single `highlights` ref
// becomes the bullet list).
function deepResolve(value: unknown, resume: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    // wrap:true always yields an array of matches; take the first. (Filter
    // expressions like `[?(...)]` stay wrapped even with wrap:false, so this is
    // the only form that unwraps scalars and arrays consistently.)
    const matches = JSONPath({ path: value, json: resume as object, wrap: true });
    if (!Array.isArray(matches) || matches.length === 0) {
      throw new Error(`resume-refs: no match for "${value}" in resume.json`);
    }
    return matches[0];
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const el of value) {
      const resolved = deepResolve(el, resume);
      if (typeof el === 'string' && el.startsWith('$') && Array.isArray(resolved)) {
        out.push(...resolved);
      } else {
        out.push(resolved);
      }
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepResolve(v, resume);
    }
    return out;
  }
  return value;
}

// Expose `virtual:levels` — levels.json with all JSONPath refs into resume.json
// resolved at build time. resume.json stays the single source of truth, and
// neither it (contact details included) nor jsonpath-plus ship in the client bundle.
function resumeRefs(): Plugin {
  const LEVELS_ID = 'virtual:levels';
  const LEVELS_RESOLVED = '\0' + LEVELS_ID;
  // Only the obfuscated phone is exposed to the client (the "play to unlock"
  // reward) — never the email or the rest of resume.json's contact block.
  const CONTACT_ID = 'virtual:contact';
  const CONTACT_RESOLVED = '\0' + CONTACT_ID;
  return {
    name: 'resume-refs',
    resolveId(id) {
      if (id === LEVELS_ID) return LEVELS_RESOLVED;
      if (id === CONTACT_ID) return CONTACT_RESOLVED;
    },
    load(id) {
      if (id === LEVELS_RESOLVED) {
        const resume = JSON.parse(readFileSync(RESUME_PATH, 'utf-8'));
        const levels = JSON.parse(readFileSync(LEVELS_PATH, 'utf-8'));
        return `export default ${JSON.stringify(deepResolve(levels, resume))};`;
      }
      if (id === CONTACT_RESOLVED) {
        const resume = JSON.parse(readFileSync(RESUME_PATH, 'utf-8'));
        // Ship the obfuscated value as-is; the game decodes it at runtime so the
        // raw number is never in the repo or the built bundle as plain text.
        return `export default ${JSON.stringify({ phone: resume.basics?.phone ?? '' })};`;
      }
    },
    // Pick up edits to either source file in dev with a full reload.
    handleHotUpdate({ file, server }) {
      if (file === RESUME_PATH || file === LEVELS_PATH) {
        for (const resolved of [LEVELS_RESOLVED, CONTACT_RESOLVED]) {
          const mod = server.moduleGraph.getModuleById(resolved);
          if (mod) server.moduleGraph.invalidateModule(mod);
        }
        server.ws.send({ type: 'full-reload' });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  root: '.',
  // Dev serves at root; the production build targets the GitHub Pages project path.
  base: command === 'serve' ? '/' : '/resume/',
  plugins: [resumeRefs()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    open: true,
  },
}));
