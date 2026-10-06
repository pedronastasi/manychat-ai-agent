/**
 * The bare `manychat-ai-agent` entry point: the plugin API (specs/036). The
 * agent itself is run through its CLI or image, never imported.
 */
export { definePlugin, defineTool, PLUGIN_API_VERSION } from './plugins/api.ts';
export type {
  ParamsOf,
  Plugin,
  PluginCall,
  PluginLogger,
  PluginParameter,
  PluginParameters,
  PluginTool,
} from './plugins/api.ts';
