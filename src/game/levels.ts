import { parseLayout, type LevelLayout } from './grid';

// The résumé-as-game level catalogue. Each level is a real puzzle: the cube
// starts on the base tile ('b'), and you clear every green tile ('n') and return
// to base to win. One gold "info" tile ('i') sits on the route — landing on it
// reveals that level's story in the on-screen card.
//
// LAYOUT RULE — solvability. The cube moves one whole tile per press and a green
// tile crumbles the instant the cube steps off it, so a level is solvable iff its
// tiles form a single closed loop (you trace it once and arrive back at base).
// On the grid graph a returning loop must have an even number of cells, so every
// layout below is an even-length ring of `base + greens + one info`. To add
// levels, draw another even ring (rectangular rings are always even) and drop a
// single 'i' anywhere on it. Specials (a/t/r/c/x) can be layered in later, but
// keep the core traversal a closed loop.

export interface LevelContent {
  heading: string;
  /** e.g. "2019 — 2023". */
  period?: string;
  /** Role / one-line context under the heading. */
  subheading?: string;
  bullets: string[];
  /** 'resume' = career content (cyan); 'meta' = behind-the-scenes (mint). */
  tag: 'resume' | 'meta';
}

export interface LevelDef {
  /** 0…999, shown on the home platform as a 3-digit odometer. */
  number: number;
  /** Shown as the platform's label on the home screen and the level HUD. */
  name: string;
  /** Compact char grid → parseLayout. Exactly one 'i'. A closed even loop. */
  layout: LevelLayout;
  content: LevelContent;
}

export const LEVELS: LevelDef[] = [
  {
    number: 0,
    name: 'Who am I',
    layout: parseLayout([
      'bi',
      'nn',
    ]),
    content: {
      heading: 'Harishankar Narayanan',
      period: '20+ years',
      subheading: 'Senior Director · Product Engineering · Chennai',
      tag: 'resume',
      bullets: [
        "This is a game. It's also my résumé.",
        'Engineering leader — real-time payments and scalable distributed systems.',
        'From C++ rendering & ML engines to leading 300+ developers.',
        'Roll the cube onto the gold tile in each level to read the story.',
      ],
    },
  },
  {
    number: 1,
    name: 'Real Image · 2005',
    layout: parseLayout([
      'bnn',
      'n.i',
      'nnn',
    ]),
    content: {
      heading: 'Real Image Media',
      period: '2005 — 2006',
      subheading: 'Software Developer · Qube Cinema',
      tag: 'resume',
      bullets: [
        "Joined the Qube Cinema server team's digital-cinema content security (HASP).",
        '150+ cinema deployments across Tamil Nadu.',
        'First job out of college — shipping cinema tech at real scale.',
      ],
    },
  },
  {
    number: 2,
    name: 'Smackall · 2006',
    layout: parseLayout([
      'bnnn',
      'n..n',
      'nnin',
    ]),
    content: {
      heading: 'Smackall Games',
      period: '2006 — 2016',
      subheading: 'Founder & Technology Head',
      tag: 'resume',
      bullets: [
        'Grew a 2-person studio to 20 developers; 120+ apps shipped.',
        '3 apps topped the iTunes Global Charts — 5M+ downloads.',
        'Built Iyan 3D, mobile 3D animation, 2M+ downloads.',
        'Wrote an ML gesture-recognition engine in C++.',
      ],
    },
  },
  {
    number: 3,
    name: 'Amtex · 2014',
    layout: parseLayout([
      'bnnn',
      'i..n',
      'n..n',
      'nnnn',
    ]),
    content: {
      heading: 'Amtex Inc',
      period: '2014 — 2016',
      subheading: 'Technical Architect & Consultant',
      tag: 'resume',
      bullets: [
        'Architected 5 products; built a 45-developer mobile division.',
        'Designed e-commerce, audio-streaming and emergency-response platforms.',
        'Including a real-time system for the Chennai City Police.',
      ],
    },
  },
  {
    number: 4,
    name: 'Altimetrik · 2016',
    layout: parseLayout([
      'bnnnn',
      'n...n',
      'nnnin',
    ]),
    content: {
      heading: 'Altimetrik',
      period: '2016 — 2017',
      subheading: 'Architect — AnyDevice Capability Centre',
      tag: 'resume',
      bullets: [
        'Led mobile & web front-end engineering with 100+ developers.',
        'Architected RMAD — a cloud IDE — and an mBaaS platform.',
      ],
    },
  },
  {
    number: 5,
    name: 'CaratLane · 2017',
    layout: parseLayout([
      'bnnnn',
      'n...n',
      'n...i',
      'nnnnn',
    ]),
    content: {
      heading: 'CaratLane — A Tanishq Partnership',
      period: '2017 — 2019',
      subheading: 'Engineering Manager',
      tag: 'resume',
      bullets: [
        'Led e-commerce platform engineering.',
        'Migrated a monolith to microservices.',
        "Built the company's first ML team for recommendations.",
      ],
    },
  },
  {
    number: 6,
    name: 'Volante · 2019',
    layout: parseLayout([
      'bnnnnn',
      'n....n',
      'i....n',
      'nnnnnn',
    ]),
    content: {
      heading: 'Volante Technologies',
      period: '2019 — 2023',
      subheading: 'Senior Director — Product Development',
      tag: 'resume',
      bullets: [
        'Led the VolPay payment engine for BNY, Citi and Wells Fargo.',
        'Improved throughput 6x — from 30 TPS to 200+ TPS.',
        'Transformed an on-prem monolith into a cloud-native SaaS offering.',
      ],
    },
  },
  {
    number: 7,
    name: 'Global Payments · 2023',
    layout: parseLayout([
      'bnnnnn',
      'n....n',
      'n....n',
      'n....i',
      'nnnnnn',
    ]),
    content: {
      heading: 'Global Payments Inc',
      period: '2023 — present',
      subheading: 'Senior Director — Product Engineering',
      tag: 'resume',
      bullets: [
        'Lead 300+ engineers building enterprise payment platforms.',
        'Serving Netflix, eBay, Amazon, Booking.com and Airbnb.',
        'Designed merchant onboarding; navigated major corporate transitions.',
      ],
    },
  },
  {
    number: 8,
    name: 'Awards',
    layout: parseLayout([
      'bnnnn',
      'n...n',
      'n...n',
      'n...n',
      'nnnin',
    ]),
    content: {
      heading: 'Awards & Recognition',
      tag: 'resume',
      bullets: [
        'Reverse-engineered robot-vacuum firmware; shipped an open-source Rust replacement.',
        'Ranked #1 in India — Google AI Programming Challenge, 2011.',
        "A'Design Award — Best Product Design, 2013 (GPS terrain mapping).",
      ],
    },
  },
  {
    number: 9,
    name: 'Education',
    layout: parseLayout([
      'bnn',
      'i.n',
      'n.n',
      'nnn',
    ]),
    content: {
      heading: 'Education',
      period: '2000 — 2004',
      subheading: 'P.S.N.A College of Engineering & Technology',
      tag: 'resume',
      bullets: [
        'Bachelor of Engineering — Mechanical Engineering.',
        'Turned a mechanical degree into a 20-year software career.',
      ],
    },
  },
  {
    number: 10,
    name: 'The Toolkit',
    layout: parseLayout([
      'bnnnnn',
      'n....n',
      'n....n',
      'n....i',
      'nnnnnn',
    ]),
    content: {
      heading: 'The Toolkit',
      subheading: 'What I bring to the table',
      tag: 'resume',
      bullets: [
        'Leadership: team building & scaling, strategy, cross-functional delivery.',
        'Domain: banking & payments, e-commerce, video codecs & 3D graphics.',
        'Architecture: high-throughput, event-driven, microservices, cloud-native.',
      ],
    },
  },
  {
    number: 11,
    name: 'How this was built',
    layout: parseLayout([
      'bnnnnnn',
      'n.....n',
      'i.....n',
      'nnnnnnn',
    ]),
    content: {
      heading: 'How this page was built',
      subheading: 'Behind the scenes',
      tag: 'meta',
      bullets: [
        'Three.js + TypeScript + Vite — no game engine.',
        'The cube rolls by pivoting 90° about its leading edge, twice per tile.',
        'Every tile decoration is an animated 8×8 grid of tiny cubes.',
        'Platforms and the player are OBJ/MTL meshes upgraded to PBR materials.',
      ],
    },
  },
  {
    number: 12,
    name: 'Easter eggs',
    layout: parseLayout([
      'bnnn',
      'n..n',
      'n..n',
      'n..i',
      'n..n',
      'nnnn',
    ]),
    content: {
      heading: 'Easter eggs & extras',
      subheading: 'For the curious',
      tag: 'meta',
      bullets: [
        'A no-JS visitor gets a static résumé built from resume.json by Python.',
        'The avatar there is a hand-rolled hex-mosaic of the source photo.',
        'The level counter rolls all the way to 999 — there is room to grow.',
        'Thanks for playing. Now clear the board and head home.',
      ],
    },
  },
];

// ── TEST FILLER ──────────────────────────────────────────────────────────────
// Pad the catalogue past 99 so the 2- and 3-digit odometer (centred, no leading
// zeros) can be exercised on the home grid. Each filler reuses the last real
// level's layout + content. Remove this block when done testing.
{
  const template = LEVELS[LEVELS.length - 1];
  for (let n = template.number + 1; n <= 104; n++) {
    LEVELS.push({
      number: n,
      name: `Test ${n}`,
      layout: template.layout,
      content: { ...template.content, heading: `Test Level ${n}` },
    });
  }
}
