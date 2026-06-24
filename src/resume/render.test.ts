import { describe, it, expect } from 'vitest';
import { renderResume, type Resume } from './render';

const SAMPLE: Resume = {
  basics: {
    name: 'Ada Lovelace',
    label: 'Analytical Engineer',
    picture: 'ada.jpeg',
    email: 'ada@example.com',
    summary: 'Builds engines & ideas.',
    location: { city: 'London', region: 'England' },
    profiles: [{ network: 'GitHub', url: 'https://github.com/ada' }],
  },
  work: [
    {
      position: 'Lead',
      company: 'Engine Co',
      startDate: '2020-03-01',
      summary: 'Led things.',
      highlights: ['Shipped <the> first program'],
    },
  ],
  skills: [{ name: 'Math', keywords: ['Algebra', 'Calculus'] }],
  volunteer: [{ organization: 'OSS', summary: 'Maintained a library.' }],
  awards: [
    { title: 'Pioneer', awarder: 'History', date: '1843-01-01', summary: 'First programmer.' },
  ],
  education: [
    {
      studyType: 'Self-taught',
      area: 'Mathematics',
      startDate: '1830-01-01',
      endDate: '1840-01-01',
      institution: 'Home',
    },
  ],
};

describe('renderResume', () => {
  const html = renderResume(SAMPLE, '/resume/');

  it('renders every section heading', () => {
    for (const h of ['Summary', 'Experience', 'Skills', 'Open Source', 'Awards', 'Education']) {
      expect(html).toContain(h);
    }
  });

  it('renders the avatar with the base-prefixed src', () => {
    expect(html).toContain('src="/resume/ada.jpeg"');
    expect(html).toContain('class="av"');
  });

  it('formats dates as "Mon YYYY" / years, with open-ended → Present', () => {
    expect(html).toContain('Mar 2020 — Present'); // no endDate
    expect(html).toContain('1830 — 1840'); // education years
  });

  it('makes profile links protocol-relative and shows the network name', () => {
    expect(html).toContain('<a href="//github.com/ada">GitHub</a>');
  });

  it('escapes HTML in résumé content', () => {
    expect(html).toContain('Shipped &lt;the&gt; first program');
    expect(html).not.toContain('Shipped <the>');
  });

  it('always links to the game and the unlock prompt', () => {
    expect(html).toContain('Play the game for my number');
    expect(html).toContain('Play the résumé game');
  });

  it('omits the projects section when there is no volunteer data', () => {
    const noProjects = renderResume({ ...SAMPLE, volunteer: [] });
    expect(noProjects).not.toContain('Open Source');
  });
});
