import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * specs/021-contributor-surface.md § Verification.
 *
 * Every public text box this repository offers must carry the C1 reminder at
 * the moment of writing. Each property below is undone by a one-file diff that
 * looks like tidying: re-enabling blank issues, dropping `required: true`, or
 * adding a friendlier Markdown template beside the forms.
 */

const ISSUE_DIR = '.github/ISSUE_TEMPLATE';
const DISCUSSION_FORM = '.github/DISCUSSION_TEMPLATE/q-a.yml';

interface FormField {
  type: string;
  id?: string;
  attributes: {
    label?: string;
    description?: string;
    options?: { label: string; required?: boolean }[];
  };
}

interface Form {
  labels?: string[];
  body: FormField[];
}

const readYaml = <Shape>(path: string): Shape => parse(readFileSync(path, 'utf8')) as Shape;
const collapse = (text: string): string => text.replace(/\s+/g, ' ');

/** The list the pull request template asks authors to leave out (specs/006). */
const LEAVE_OUT = 'real transcripts, prices, names, phone numbers, screenshots or `.env` values';

const forms: [string, Form][] = [
  ['bug_report.yml', readYaml<Form>(`${ISSUE_DIR}/bug_report.yml`)],
  ['feature_request.yml', readYaml<Form>(`${ISSUE_DIR}/feature_request.yml`)],
  ['q-a.yml', readYaml<Form>(DISCUSSION_FORM)],
];

const requiredAcknowledgements = (form: Form): string[] =>
  form.body
    .filter(field => field.type === 'checkboxes')
    .flatMap(field => field.attributes.options ?? [])
    .filter(option => option.required === true)
    .map(option => collapse(option.label));

describe('issue intake (specs/021 § Blank issues are disabled)', () => {
  it('holds exactly the two forms and their config, and no Markdown template', () => {
    expect(readdirSync(ISSUE_DIR).sort()).toEqual([
      'bug_report.yml',
      'config.yml',
      'feature_request.yml',
    ]);
  });

  it.each(['.github/ISSUE_TEMPLATE.md', '.github/issue_template.md', 'ISSUE_TEMPLATE.md'])(
    'has no single-file template at %s, which GitHub would offer beside the forms',
    path => {
      expect(existsSync(path)).toBe(false);
    },
  );

  const config = readYaml<{
    blank_issues_enabled: boolean;
    contact_links: { name: string; url: string }[];
  }>(`${ISSUE_DIR}/config.yml`);

  it('disables blank issues, so the reminder cannot be scrolled past', () => {
    expect(config.blank_issues_enabled).toBe(false);
  });

  it('sends questions to Discussions and vulnerabilities to private reporting', () => {
    // specs/021 § Questions go to Discussions, vulnerabilities to SECURITY.md.
    const urls = config.contact_links.map(link => link.url);
    expect(urls.some(url => url.includes('/discussions/categories/q-a'))).toBe(true);
    expect(urls.some(url => url.includes('/security/advisories/new'))).toBe(true);
  });
});

describe('every form requires the no-tenant-data acknowledgement (specs/021 § Issue forms)', () => {
  it('names what to leave out in the same terms as the pull request template', () => {
    // One rule, not two phrasings of it.
    const template = collapse(readFileSync('.github/pull_request_template.md', 'utf8'));
    expect(template).toContain(LEAVE_OUT);
  });

  it.each(forms)(
    '%s has a required checkbox naming transcripts, prices and phone numbers',
    (_name, form) => {
      const acknowledgements = requiredAcknowledgements(form);
      expect(acknowledgements).toHaveLength(1);
      expect(acknowledgements[0]).toContain(LEAVE_OUT);
    },
  );

  it.each([
    ['bug_report.yml', 'bug'],
    ['feature_request.yml', 'enhancement'],
  ])('%s is labelled %s', (file, label) => {
    expect(readYaml<Form>(`${ISSUE_DIR}/${file}`).labels).toEqual([label]);
  });

  it.each(forms)('%s is written in English (C9)', name => {
    const path = name === 'q-a.yml' ? DISCUSSION_FORM : `${ISSUE_DIR}/${name}`;
    expect(readFileSync(path, 'utf8')).not.toMatch(/[À-ɏ]/);
  });
});

describe('the bug form (specs/021 § A bug report asks for a reproduction against the fixture tenant)', () => {
  it('asks for pnpm simulate against the fixture tenant and the mock model', () => {
    const bug = forms[0]![1];
    const reproduction = bug.body.find(field => field.id === 'reproduction');
    const description = reproduction?.attributes.description ?? '';
    expect(description).toContain('pnpm simulate');
    expect(description).toContain('CONFIG_DIR=test/fixtures/config');
    expect(description).toContain('AGENT_MODEL=mock:demo');
  });
});

describe("the README's first screen (specs/021 § The README's first screen)", () => {
  const readme = readFileSync('README.md', 'utf8');
  const firstScreen = readme.slice(0, readme.search(/^## /m));
  const images = [...firstScreen.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match =>
    decodeURIComponent(match[1]!),
  );

  it.each([
    ['CI for ci.yml', /\/actions\/workflows\/ci\.yml\/badge\.svg$/],
    ['the license', /img\.shields\.io\/github\/license\//],
    ['the latest release', /img\.shields\.io\/github\/v\/release\//],
    ['the Node version from engines.node', /img\.shields\.io\/.*\$\.engines\.node/],
  ])('shows a badge for %s', (_badge, pattern) => {
    expect(images.some(url => pattern.test(url))).toBe(true);
  });

  it('shows no coverage badge, since a passing CI badge already says coverage held', () => {
    expect(images.filter(url => /coverage|codecov|coveralls/i.test(url))).toEqual([]);
  });

  it('embeds a committed recording under docs/assets/, not an external host', () => {
    const recordings = images.filter(url => url.startsWith('docs/assets/'));
    expect(recordings.length).toBeGreaterThan(0);
    for (const path of recordings) expect(existsSync(path)).toBe(true);
  });

  it('is recorded against the fixture tenant and the mock model only', () => {
    // Nothing can read the image itself; this pins what the recorder is allowed
    // to point at, so it cannot publish a real tenant's copy as a picture (C1).
    const recorder = readFileSync('scripts/record-demo.ts', 'utf8');
    expect(recorder).toContain("CONFIG_DIR: 'test/fixtures/config'");
    expect(recorder).toContain("AGENT_MODEL: 'mock:demo'");
  });
});

describe('CONTRIBUTING (specs/021 § CONTRIBUTING opens with the PR that needs no spec)', () => {
  const contributing = readFileSync('CONTRIBUTING.md', 'utf8');
  const firstSection = contributing.search(/^## /m);
  const heading = contributing.slice(firstSection).split('\n')[0]!;

  it('opens with the changes that need no spec and no ADR', () => {
    expect(heading).toMatch(/no spec/i);
    expect(heading).toMatch(/no ADR/);
  });

  it('reaches that section before any mention of the Constitution', () => {
    expect(contributing.search(/constitution/i)).toBeGreaterThan(firstSection);
  });
});

describe('the Code of Conduct (specs/021 § Conduct reports go to a private form, not an address)', () => {
  const conduct = readFileSync('CODE_OF_CONDUCT.md', 'utf8');

  it('is the Contributor Covenant 2.1', () => {
    expect(conduct).toContain('Contributor Covenant');
    expect(conduct).toContain('version 2.1');
  });

  it('names a form as its enforcement contact, not the placeholder', () => {
    expect(conduct).not.toContain('[INSERT CONTACT METHOD]');
    const form = /responsible for enforcement at \[[^\]]+\]\((https:\/\/[^)\s]+)\)\./.exec(conduct);
    expect(form?.[1]).toBeDefined();
    expect(form?.[1]).not.toMatch(/example\./);
  });

  it('publishes no email address, which would be harvested', () => {
    expect(conduct).not.toMatch(/[\w.%+-]+@[\w-]+\.[\w.-]+/);
  });
});
