/**
 * The bare `manychat-ai-agent` entry point: the plugin API (specs/036) and its
 * provisional channel half (specs/038). The agent itself is run through its
 * CLI or image, never imported.
 */
export {
  CHANNEL_API_VERSION,
  defineChannel,
  definePlugin,
  defineTool,
  PLUGIN_API_VERSION,
} from './plugins/api.ts';
export type {
  ChannelInbound,
  ChannelReply,
  InboundSchema,
  ParamsOf,
  Plugin,
  PluginCall,
  PluginChannel,
  PluginLogger,
  PluginParameter,
  PluginParameters,
  PluginTool,
} from './plugins/api.ts';
