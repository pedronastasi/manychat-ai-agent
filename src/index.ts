/**
 * The bare `manychat-ai-agent` entry point: the plugin API (specs/036, with
 * read tools from specs/039 and provisional channels from specs/038). The agent itself is run through its CLI or
 * image, never imported.
 */
export {
  CHANNEL_API_VERSION,
  defineChannel,
  definePlugin,
  defineReadTool,
  defineTool,
  PLUGIN_API_VERSION,
  SUPPORTED_CHANNEL_API_VERSIONS,
  SUPPORTED_PLUGIN_API_VERSIONS,
} from './plugins/api.ts';
export type {
  ChannelMessage,
  ChannelPush,
  ChannelReply,
  InboundSchema,
  ParamsOf,
  Plugin,
  PluginCall,
  PluginChannel,
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
