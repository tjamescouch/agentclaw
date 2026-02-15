/**
 * Agentclaw Configuration Adapter
 * Resolves OpenClaw config into AgentChat account settings
 */

import type { AgentClawAccount, AgentClawConfig } from './types.js';

const DEFAULT_ACCOUNT: AgentClawAccount = {
  accountId: 'default',
  enabled: true,
  wsUrl: 'wss://agentchat-server.fly.dev',
  channels: ['#general'],
  autoJoin: true,
};

export function listAccountIds(cfg: AgentClawConfig): string[] {
  return Object.keys(cfg.channels?.agentchat?.accounts ?? {});
}

export function resolveAccount(
  cfg: AgentClawConfig,
  accountId?: string
): AgentClawAccount {
  const id = accountId ?? 'default';
  const raw = cfg.channels?.agentchat?.accounts?.[id] ?? {};

  return {
    ...DEFAULT_ACCOUNT,
    accountId: id,
    ...raw,
  };
}
