import { parseLayout, type LevelLayout } from './grid';
// `virtual:levels` is levels.json with all JSONPath refs into resume.json resolved
// at build time by the `resume-refs` Vite plugin (see vite.config.ts).
import rawLevels from 'virtual:levels';

// The résumé-as-game level catalogue. Content lives in `levels.json` (so the story
// is editable as data); this module loads it and turns each compact layout into a
// parsed grid. Each level is a real puzzle: the cube starts on the base tile ('b'),
// and you clear every green tile ('n') and return to base to win. Content levels
// carry one gold "info" tile ('i') on the route — landing on it reveals that level's
// story in the on-screen card; pure-puzzle "bonus" levels have no 'i'.
//
// The current catalogue is produced by the `level-gen` tool (see level-gen/): a
// solver-verified, difficulty-curated 32-level ladder. The first levels introduce
// one tile type at a time and stay easy, then difficulty ramps up. Layouts may use
// the full mechanic set — arrows ('>' '<' '^' 'v'), teleport pairs (digits '1'–'9'),
// line sweeps ('r' 'c') and explosives ('x') — all parsed by parseLayout in grid.ts.
// To regenerate: `cd level-gen && cargo run --release -- gen --batch 1500 --profile
// spread` then `... curate --profile initial32`, and wire the result with
// `level-gen/wire_ladder.py`.

/** A single award/recognition entry, mirroring the résumé's `awards`. */
export interface LevelAward {
  title: string;
  /** Who gave it, if applicable. */
  awarder?: string;
  /** Year, if applicable. */
  date?: string;
  summary: string;
}

export interface LevelContent {
  heading: string;
  /** e.g. "2019 — 2023". */
  period?: string;
  /** Role / one-line context under the heading. */
  subheading?: string;
  /** Lead paragraph (work levels): the role summary from the résumé. */
  summary?: string;
  /** External link for the entry, e.g. the company website. */
  url?: string;
  /** Overrides the auto-derived host text on the info-card link (for `url`). */
  linkLabel?: string;
  /** Contact email (Contact level) — rendered as a mailto link. */
  email?: string;
  /** Free-text location line (Contact level). */
  location?: string;
  /** Labelled external links (Contact level), rendered as a link row. */
  links?: { label: string; url: string }[];
  bullets: string[];
  /** Structured award entries (the Awards level), rendered below the bullets. */
  awards?: LevelAward[];
  /** Short tech / domain chips shown under the body (design-system tags). */
  tags?: string[];
  /** 'resume' = career content (cyan); 'meta' = behind-the-scenes (mint). */
  tag: 'resume' | 'meta';
}

export interface LevelDef {
  /** 0…999, shown on the home platform as a 3-digit odometer. */
  number: number;
  /** Shown as the platform's label on the home screen and the level HUD. */
  name: string;
  /** Compact char grid → parseLayout. Content levels carry one 'i'; bonus levels have none. */
  layout: LevelLayout;
  content: LevelContent;
}

// Shape of a level entry as stored in levels.json: layout is a compact char-row
// array (parsed via parseLayout) and `tag` is a plain string until narrowed to
// LevelContent['tag'] below.
interface RawLevel {
  number: number;
  name: string;
  layout: string[];
  content: {
    heading: string;
    period?: string;
    subheading?: string;
    summary?: string;
    url?: string;
    linkLabel?: string;
    email?: string;
    location?: string;
    links?: { label: string; url: string }[];
    bullets: string[];
    awards?: LevelAward[];
    tags?: string[];
    tag: string;
  };
}

export const LEVELS: LevelDef[] = (rawLevels.levels as RawLevel[]).map((l) => ({
  number: l.number,
  name: l.name,
  layout: parseLayout(l.layout),
  content: { ...l.content, tag: l.content.tag as LevelContent['tag'] },
}));
