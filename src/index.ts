/**
 * Agentclaw — OpenClaw channel extension for AgentChat
 *
 * Registers AgentChat as a channel plugin in OpenClaw's gateway system.
 * OpenClaw agents can send/receive messages through AgentChat's WebSocket
 * protocol, including channels, DMs, proposals, and identity verification.
 */

import { listAccountIds, resolveAccount } from './config.js';
import { sendText, startAccount, parseTarget } from './channel.js';
import type { ChannelMeta, ChannelCapabilities, AgentClawConfig } from './types.js';

const meta: ChannelMeta = {
  id: 'agentchat',
  label: 'AgentChat',
  selectionLabel: 'AgentChat (WebSocket)',
  docsPath: '/channels/agentchat',
  blurb: 'Connect to AgentChat agents via WebSocket protocol',
  aliases: ['ws', 'agentchat-ws'],
};

const capabilities: ChannelCapabilities = {
  chatTypes: ['direct', 'group'],
  supportsMedia: false,
  supportsThreading: true,
  supportsStreaming: false,
};

/**
 * The AgentChat channel plugin for OpenClaw
 */
export const agentchatPlugin = {
  id: 'agentchat',
  meta,
  capabilities,

  config: {
    listAccountIds: (cfg: AgentClawConfig) => listAccountIds(cfg),
    resolveAccount: (cfg: AgentClawConfig, accountId?: string) =>
      resolveAccount(cfg, accountId),
  },

  outbound: {
    deliveryMode: 'direct' as const,
    textChunkLimit: 4000,

    sendText,

    // AgentChat doesn't support media natively yet
    sendMedia: async () => ({
      ok: false,
      error: 'AgentChat does not support media attachments',
    }),
  },

  gateway: {
    startAccount,
  },
};

/**
 * Plugin registration entry point
 * Called by OpenClaw's plugin loader
 */
export default function register(api: {
  registerChannel: (opts: { plugin: typeof agentchatPlugin }) => void;
}): void {
  api.registerChannel({ plugin: agentchatPlugin });
}

// Re-export utilities for standalone use
export { parseTarget, sendText, startAccount } from './channel.js';
export { listAccountIds, resolveAccount } from './config.js';
export type * from './types.js';
