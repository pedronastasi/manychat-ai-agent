import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import { ContactReads } from '../../src/agent/contact.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { Plugins } from '../../src/plugins/plugins.ts';
import { PluginReads } from '../../src/plugins/reads.ts';
import type { PluginReadTool, PluginTool } from '../../src/plugins/api.ts';

/**
 * Every tool a turn can be offered: the built-ins `test/fixtures/config`
 * configures, `get_contact`, and one invented plugin write tool and read tool
 * covering each parameter type (specs/053 § Verification, Tool and reply
 * schema bytes). Every name and value here is invented (C1).
 */

const writeTool: PluginTool = {
  name: 'book_callback',
  description: 'Ask the invented front desk to call the contact back.',
  parameters: {
    slot: { type: 'enum', values: ['morning', 'evening'], description: 'When to call.' },
    attempts: { type: 'number', integer: true, min: 1, max: 3, optional: true },
    urgent: { type: 'boolean', optional: true },
    note: { type: 'note', maxLength: 200, description: 'What to tell the caller.' },
  },
  perform: () => undefined,
};

const readTool: PluginReadTool = {
  name: 'class_availability',
  description: 'Look up an invented course’s seats.',
  parameters: {
    course: { type: 'enum', values: ['foundation', 'advanced'] },
    query: { type: 'query', maxLength: 80, optional: true },
  },
  result: { seatsLeft: { type: 'number', integer: true, min: 0 } },
  read: () => ({ seatsLeft: 3 }),
};

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function fullToolSet() {
  const tenant = loadTenantConfig('test/fixtures/config');
  const reads = new ContactReads({
    reader: { readContact: () => Promise.reject(new Error('not read in this test')) },
    subscriberId: '5550000000053',
    logger: silent,
  });
  const tools = buildTools(tenant.tools!, new ActionStage(), undefined, reads, {
    plugins: new Plugins(
      [
        { plugin: 'example-callbacks', tool: writeTool },
        { plugin: 'example-schedule', tool: readTool },
      ],
      ['example-callbacks', 'example-schedule'],
    ),
    pluginReads: new PluginReads({ subscriberId: '5550000000053', logger: silent }),
  });
  if (!tools) throw new Error('the fixture tenant configures tools');
  return tools;
}

/** A tool input the fixture's `set_field` refuses: the field id is not configured. */
export const INVALID_SET_FIELD_INPUT = { field: 'not_a_field', value: 'x' } as const;
