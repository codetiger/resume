import { defineConfig, type Plugin } from 'vite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { JSONPath } from 'jsonpath-plus';
import { renderResume } from './src/resume/render';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RESUME_PATH = resolve(ROOT, 'assets/resume.json');
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

// DEV ONLY: serve the shared design system at /design-system/ during `npm run dev`, so
// the <link href="/design-system/tokens.css"> in index.html resolves locally. In
// production the aggregator publishes it at that path (build/preview are untouched).
// Streams straight from the design-system folder — no copy, never stale. Override the
// location with DESIGN_SYSTEM_DIR.
function designSystemDev(): Plugin {
  const MIME: Record<string, string> = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.svg': 'image/svg+xml',
  };
  const dir = [
    process.env.DESIGN_SYSTEM_DIR,
    resolve(ROOT, '../../design-system'), // website-cicd/projects/resume
    resolve(ROOT, '../website-cicd/design-system'), // standalone clone beside website-cicd
  ].find((d): d is string => !!d && existsSync(resolve(d, 'design-system.css')));
  return {
    name: 'design-system-dev',
    apply: 'serve',
    configureServer(server) {
      if (!dir) {
        server.config.logger.warn(
          '[design-system] not found — set DESIGN_SYSTEM_DIR; /design-system/ will 404 locally',
        );
        return;
      }
      server.config.logger.info(`[design-system] serving /design-system/ from ${dir}`);
      server.middlewares.use('/design-system', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]);
        const file = resolve(dir, '.' + (rel === '/' ? '/index.html' : rel));
        if (!file.startsWith(dir)) return next(); // traversal guard
        try {
          const data = readFileSync(file);
          res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
          res.end(data);
        } catch {
          next();
        }
      });
    },
  };
}

// Render the static résumé (resume.html) from assets/resume.json at build time, so it
// ships as plain HTML — no client framework, no Python. Runs for both dev and build;
// resumeRefs()'s watcher already full-reloads on resume.json edits, re-running this.
function staticResume(): Plugin {
  let base = '/';
  return {
    name: 'static-resume',
    configResolved(c) {
      base = c.base;
    },
    transformIndexHtml(html, ctx) {
      if (!(ctx.filename ?? ctx.path ?? '').endsWith('resume.html')) return html;
      const resume = JSON.parse(readFileSync(RESUME_PATH, 'utf-8'));
      return html.replace('%RESUME%', renderResume(resume, base));
    },
  };
}

export default defineConfig(({ command }) => ({
  root: '.',
  // Dev serves at root; the production build targets the /resume/ subpath.
  base: command === 'serve' ? '/' : '/resume/',
  // Single source of truth for static assets (models, avatar, resume.json). Vite serves
  // these in dev and copies them into dist/ on build, so the deploy needs no copy step.
  publicDir: 'assets',
  plugins: [resumeRefs(), designSystemDev(), staticResume()],
  optimizeDeps: {
    // Pre-bundle three.js + the game's addons at startup so Vite doesn't discover them
    // lazily and re-optimize mid-session — the cause of the 504 "Outdated Optimize Dep".
    include: [
      'three',
      'three/examples/jsm/environments/RoomEnvironment.js',
      'three/examples/jsm/loaders/MTLLoader.js',
      'three/examples/jsm/loaders/OBJLoader.js',
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // Two pages from one build: the game (index.html) and the static résumé.
      input: {
        main: resolve(ROOT, 'index.html'),
        resume: resolve(ROOT, 'resume.html'),
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
}));
