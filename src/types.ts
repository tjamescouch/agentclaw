/**
 * Agentclaw Types
 * Configuration and interface types for the OpenClaw <-> AgentChat bridge
 */

export interface AgentClawAccount {
  accountId: string;
  enabled: boolean;
  wsUrl: string;
  identityPath?: string;
  name?: string;
  channels: string[];
  autoJoin: boolean;
}

export interface AgentClawConfig {
  channels?: {
    agentchat?: {
      accounts?: Record<string, Partial<AgentClawAccount>>;
    };
  };
}

/**
 * OpenClaw ChannelPlugin interface (subset we implement)
 */
export interface ChannelMeta {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  aliases: string[];
}

export interface ChannelCapabilities {
  chatTypes: ('direct' | 'group')[];
  supportsMedia: boolean;
  supportsThreading: boolean;
  supportsStreaming: boolean;
  streamingDefaults?: {
    textChunkLimit: number;
    idleTimeout: number;
  };
}

export interface MessagingTarget {
  id: string;
  type: 'channel' | 'agent';
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface StatusUpdate {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  message?: string;
}

export interface GatewayRuntime {
  dispatch(event: InboundEvent): Promise<void>;
}

export interface InboundEvent {
  channel: string;
  accountId: string;
  peer: MessagingTarget;
  text: string;
  media?: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayContext {
  runtime: GatewayRuntime;
  abortSignal: AbortSignal;
}
