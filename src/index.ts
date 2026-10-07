/**
 * The bare `manychat-ai-agent` entry point: the plugin API (specs/036, with
 * read tools from specs/039). The agent itself is run through its CLI or
 * image, never imported.
 */
export {
  definePlugin,
  defineReadTool,
  defineTool,
  PLUGIN_API_VERSION,
  SUPPORTED_PLUGIN_API_VERSIONS,
} from './plugins/api.ts';
export type {
  ParamsOf,
  Plugin,
  PluginCall,
  PluginLogger,
  PluginParameter,
  PluginParameters,
  PluginReadTool,
  PluginTool,
  ReadParameter,
  ReadParameters,
  ResultField,
  ResultFields,
  ResultOf,
} from './plugins/api.ts';
