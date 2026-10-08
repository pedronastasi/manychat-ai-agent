import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError, loadTenantConfig } from '../../src/config/loader.ts';
import type { TenantConfig } from '../../src/config/loader.ts';
import {
  buildSystemPrompt,
  funnelNotice,
  intentNotice,
  offeringNotice,
  openingNotice,
} from '../../src/agent/prompt.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { loadCases } from '../../src/evals/cases.ts';

/**
 * specs/042-the-sales-layer-sells-offerings-not-courses.md § Verification
 * items 1 to 4 and 7: the scaffolding names no vertical, the demo tenant's
 * prompt says OFFERINGS, a config in the old shape is refused by name,
 * `agent upgrade` moves a project's config and eval suites, and CI runs the
 * repair suite. Against the fictional tenants in test/fixtures.
 */

const REPAIR = 'test/fixtures/config-repair';
const DEMO = 'test/fixtures/config';
const VERTICAL = /course|enrol|student|academy/i;

/** Every word the framework writes to the model for this tenant, its own copy removed. */
function scaffolding(tenant: TenantConfig): string {
  const tools = {
    ...tenant.tools!,
    // So the follow-up section is read too.
    nudge: { delays: [{ id: 'later_today', minutes: 120 }] },
  };
  const { staticPrefix } = buildSystemPrompt(tenant.persona, tenant.catalog, tenant.rules, tools, {
    pluginTools: true,
    pluginReadTools: true,
  });
  const contact: ContactActions = { sentFlows: new Set(), intent: 'prospect' };
  const unplaced = buildTools(tools, new ActionStage(), contact)!;
  const placed = buildTools(tools, new ActionStage(), { ...contact, offering: 'diagnostic' })!;
  return [
    staticPrefix.replace(tenant.persona.trim(), ''),
    ...Object.values(unplaced).map(tool => tool.description ?? ''),
    ...Object.values(placed).map(tool => tool.description ?? ''),
    intentNotice(undefined, 'diagnostic'),
    intentNotice('not_prospect'),
    intentNotice('prospect'),
    offeringNotice(undefined),
    offeringNotice('repair', 'diagnostic'),
    funnelNotice('offered'),
    openingNotice({ id: 'welcome', description: 'An invented welcome.' }),
  ].join('\n');
}

describe('the scaffolding names no vertical (specs/042 V1)', () => {
  const tenant = loadTenantConfig(REPAIR);

  it('loads a tenant that is not a school, with every sales field', () => {
    const fields = tenant.tools!.fields;
    expect(fields.some(field => field.offering)).toBe(true);
    expect(fields.some(field => field.funnel)).toBe(true);
    expect(fields.some(field => field.intent)).toBe(true);
    expect(tenant.tools!.flows.some(flow => flow.role === 'payment_link')).toBe(true);
    expect(tenant.tools!.flows.some(flow => flow.offering !== undefined)).toBe(true);
    expect(`${tenant.persona}${JSON.stringify(tenant.catalog)}`).not.toMatch(VERTICAL);
  });

  it('writes none of course, enrol, student or academy around the tenant’s own text', () => {
    const text = scaffolding(tenant);
    // Every section is present, so their silence is not their absence.
    for (const heading of ['INTENT', 'SALES', 'OFFERINGS', 'FOLLOW-UPS', 'ACTIONS']) {
      expect(text.split('\n')).toContain(heading);
    }
    expect(text.match(new RegExp(VERTICAL.source, 'gi')) ?? []).toEqual([]);
  });

  it('renders an offering without the keys a product does not have', () => {
    const { catalogBlock } = buildSystemPrompt(tenant.persona, tenant.catalog, tenant.rules);
    const repair = catalogBlock.slice(catalogBlock.indexOf('- id: repair'));
    const entry = repair.slice(0, repair.indexOf('\n- id:'));
    expect(entry).not.toMatch(/duration_hours|schedule|url/);
    expect(catalogBlock).toContain('url: https://example.com/plans/maintenance');
  });
});

describe('the demo tenant reads OFFERINGS (specs/042 V2)', () => {
  const tenant = loadTenantConfig(DEMO);
  const { staticPrefix } = buildSystemPrompt(
    tenant.persona,
    tenant.catalog,
    tenant.rules,
    tenant.tools,
  );
  const lines = staticPrefix.split('\n');

  it('has an OFFERINGS section and no COURSES one', () => {
    expect(lines).toContain('OFFERINGS');
    expect(lines).not.toContain('COURSES');
  });

  it('notes the offering as OFFERING:, never COURSE:', () => {
    for (const notice of [
      offeringNotice(undefined),
      offeringNotice('advanced'),
      offeringNotice('advanced', 'foundation'),
    ]) {
      expect(notice).toMatch(/^OFFERING: /);
      expect(notice).not.toContain('COURSE');
    }
  });

  it('keeps the rules of specs/028', () => {
    const section = staticPrefix.slice(staticPrefix.indexOf('\nOFFERINGS\n'));
    expect(section).toContain('one of: foundation, advanced, weekend-intensive.');
    expect(section).toMatch(/accepted only once that is the contact’s offering/);
    expect(section).toMatch(/From offered on it is locked/);
    expect(section).toContain('"explicit_request"');
    expect(section).toMatch(/came back through another\s+offering’s advert/);
  });
});

/** The demo tenant in a scratch directory, with one file rewritten. */
function loadEdited(file: string, edit: (raw: Record<string, unknown>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-config-'));
  cpSync(DEMO, dir, { recursive: true });
  const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
  edit(raw);
  writeFileSync(join(dir, file), JSON.stringify(raw));
  try {
    loadTenantConfig(dir);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Entry = Record<string, unknown>;

describe('a config in the old shape fails at load, naming the key (specs/042 V3)', () => {
  it.each([
    [
      'catalog.json',
      'courses',
      (raw: Record<string, unknown>) => {
        raw.courses = raw.offerings;
        delete raw.offerings;
      },
    ],
    [
      'catalog.json',
      'enrollmentUrl',
      (raw: Record<string, unknown>) => {
        const [first] = raw.offerings as Entry[];
        first!.enrollmentUrl = first!.url;
        delete first!.url;
      },
    ],
    [
      'tools.json',
      'fields[course].course',
      (raw: Record<string, unknown>) => {
        const field = (raw.fields as Entry[]).find(entry => entry.offering)!;
        field.course = true;
        delete field.offering;
      },
    ],
    [
      'tools.json',
      'flows[foundation_brochure].course',
      (raw: Record<string, unknown>) => {
        const [flow] = raw.flows as Entry[];
        flow!.course = flow!.offering;
        delete flow!.offering;
      },
    ],
    [
      'rules.json',
      'learning.enrolledTag',
      (raw: Record<string, unknown>) => {
        raw.learning = { language: 'English', enrolledTag: 'paid', maxRunCostUsd: 1 };
      },
    ],
  ])('refuses %s carrying %s', (file, key, edit) => {
    const error = loadEdited(file, edit);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(file);
    expect((error as Error).message).toContain(key);
    expect((error as Error).message).toContain('agent upgrade');
  });

  it('refuses an eval case still carrying contact.course', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-cases-'));
    try {
      writeFileSync(
        join(dir, 'cases.jsonl'),
        '{"id": "a", "text": "hi", "contact": {"course": "foundation"}, "expect": {"escalate": false}}\n',
      );
      expect(() => loadCases(dir)).toThrow(/course/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* agent upgrade                                                               */
/* -------------------------------------------------------------------------- */

const CLI = resolve('src/cli.ts');
const ciEnv = {
  AGENT_MODEL: 'mock:demo',
  PUBLIC_BASE_URL: 'https://ci.example.com',
  MANYCHAT_SHARED_SECRET: 'ci-secret-ci-secret-ci-secret-xx',
  DATABASE_URL: 'pglite',
};

/** A tenant project as specs/035 scaffolds it, in the shape before specs/042. */
function oldProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'old-project-'));
  const config = join(root, 'config');
  cpSync(DEMO, config, { recursive: true });
  const edit = (file: string, change: (raw: Record<string, unknown>) => void) => {
    const raw = JSON.parse(readFileSync(join(config, file), 'utf8')) as Record<string, unknown>;
    change(raw);
    writeFileSync(join(config, file), JSON.stringify(raw, null, 2) + '\n');
  };
  edit('catalog.json', raw => {
    raw.courses = (raw.offerings as Entry[]).map(({ url, ...rest }) => ({
      ...rest,
      enrollmentUrl: url,
    }));
    delete raw.offerings;
  });
  edit('tools.json', raw => {
    raw.flows = (raw.flows as Entry[]).map(({ offering, ...rest }) =>
      offering === undefined ? rest : { ...rest, course: offering },
    );
    raw.fields = (raw.fields as Entry[]).map(({ offering, ...rest }) =>
      offering === undefined ? rest : { ...rest, course: offering },
    );
  });
  edit('rules.json', raw => {
    raw.learning = { language: 'English', enrolledTag: 'paid', maxRunCostUsd: 1 };
  });
  mkdirSync(join(root, 'evals', 'mine'), { recursive: true });
  writeFileSync(
    join(root, 'evals', 'mine', 'cases.jsonl'),
    [
      '{"id": "plain", "text": "hi", "expect": {"escalate": false}}',
      '{"id": "placed", "contact": {"funnel_stage": "offered", "course": "advanced", "intent": "prospect"}, "text": "how much?", "expect": {"escalate": false}}',
      '{"id": "advert", "contact": {"advert_course": "foundation"}, "text": "hello", "expect": {"escalate": false}}',
      '',
    ].join('\n'),
  );
  return root;
}

function upgrade(root: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...ciEnv, CONFIG_DIR: 'config' };
  delete env.EVAL_DIR;
  return spawnSync(
    'node',
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, 'upgrade'],
    { cwd: root, encoding: 'utf8', env },
  );
}

const files = (root: string) =>
  ['prompt.md', 'catalog.json', 'tools.json', 'rules.json']
    .map(file => readFileSync(join(root, 'config', file), 'utf8'))
    .concat(readFileSync(join(root, 'evals', 'mine', 'cases.jsonl'), 'utf8'));

describe('agent upgrade moves config/ and the eval suites (specs/042 V4)', () => {
  it('rewrites both with EVAL_DIR unset, then changes nothing on a second run', () => {
    const root = oldProject();
    try {
      const prompt = readFileSync(join(root, 'config', 'prompt.md'), 'utf8');
      const first = upgrade(root);
      expect(first.stderr).toBe('');
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('applied migrations');

      const tenant = loadTenantConfig(join(root, 'config'));
      expect(tenant.catalog.offerings.map(offering => offering.url)).toEqual([
        'https://example.com/enrol/foundation',
        'https://example.com/enrol/advanced',
        'https://example.com/enrol/weekend-intensive',
      ]);
      expect(tenant.tools!.fields.find(field => field.offering)?.id).toBe('course');
      expect(tenant.tools!.flows.find(flow => flow.id === 'advanced_brochure')?.offering).toBe(
        'advanced',
      );
      expect(tenant.rules.learning?.convertedTag).toBe('paid');

      const cases = loadCases(join(root, 'evals', 'mine'));
      expect(cases.map(entry => entry.contact)).toEqual([
        undefined,
        { funnel_stage: 'offered', offering: 'advanced', intent: 'prospect' },
        { advert_offering: 'foundation' },
      ]);
      // A case with nothing to rename keeps every byte.
      expect(readFileSync(join(root, 'evals', 'mine', 'cases.jsonl'), 'utf8')).toMatch(
        /^\{"id": "plain", "text": "hi", "expect": \{"escalate": false\}\}\n/,
      );
      expect(readFileSync(join(root, 'config', 'prompt.md'), 'utf8')).toBe(prompt);

      const migrated = files(root);
      const second = upgrade(root);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('config is up to date');
      expect(files(root)).toEqual(migrated);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CI runs the repair suite beside the golden set (specs/042 V7)', () => {
  it('has an eval:mock step for evals/repair against the repair fixture', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const step = ci.slice(ci.indexOf('- name: Eval (mock, repair tenant)'));
    expect(step).toMatch(/^- name: Eval \(mock, repair tenant\)\n\s+run: pnpm eval:mock\n/);
    expect(step).toMatch(/CONFIG_DIR: test\/fixtures\/config-repair\n\s+EVAL_DIR: evals\/repair/);
  });

  it('asks a price, a booking time, for the link, and as an existing customer, never of a course', () => {
    const cases = loadCases('evals/repair');
    expect(cases.map(entry => entry.id)).toEqual([
      'repair-price',
      'repair-booking-time',
      'repair-payment-link',
      'repair-existing-customer',
    ]);
    expect(JSON.stringify(cases)).not.toMatch(VERTICAL);
  });
});
