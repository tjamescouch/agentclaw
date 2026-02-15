/**
 * Agentclaw Channel Plugin
 * Bridges OpenClaw agents into AgentChat via WebSocket
 *
 * Outbound: OpenClaw -> AgentChat (send messages to channels/agents)
 * Inbound:  AgentChat -> OpenClaw (dispatch incoming messages to gateway)
 */

import { AgentChatClient } from '@tjamescouch/agentchat';
import type {
  AgentClawAccount,
  MessagingTarget,
  SendResult,
  StatusUpdate,
  GatewayContext,
} from './types.js';

/** Active client connections keyed by accountId */
const clients = new Map<string, AgentChatClient>();

/**
 * Parse an AgentChat address into a MessagingTarget
 * #channel -> { id: '#channel', type: 'channel' }
 * @agentid -> { id: '@agentid', type: 'agent' }
 */
export function parseTarget(address: string): MessagingTarget {
  if (address.startsWith('#')) {
    return { id: address, type: 'channel' };
  }
  const id = address.startsWith('@') ? address : `@${address}`;
  return { id, type: 'agent' };
}

/**
 * Format a MessagingTarget back to an AgentChat address
 */
export function formatTarget(target: MessagingTarget): string {
  return target.id;
}

/**
 * Get or create an AgentChatClient for an account
 */
function getClient(accountId: string): AgentChatClient | undefined {
  return clients.get(accountId);
}

/**
 * Send a text message to a channel or agent via AgentChat
 */
export async function sendText(options: {
  text: string;
  to: MessagingTarget;
  replyToId?: string;
  accountId: string;
}): Promise<SendResult> {
  const client = getClient(options.accountId);
  if (!client || !client.connected) {
    return { ok: false, error: 'Not connected' };
  }

  try {
    const target = formatTarget(options.to);
    await client.send(target, options.text, {
      in_reply_to: options.replyToId,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Start an account connection — connects to AgentChat, joins channels,
 * and dispatches inbound messages to the OpenClaw gateway runtime.
 *
 * Returns a cleanup function that disconnects the client.
 */
export async function startAccount(options: {
  account: AgentClawAccount;
  accountId: string;
  ctx: GatewayContext;
  statusSink: (update: StatusUpdate) => void;
}): Promise<() => void> {
  const { account, accountId, ctx, statusSink } = options;

  statusSink({ status: 'connecting', message: `Connecting to ${account.wsUrl}` });

  const client = new AgentChatClient({
    server: account.wsUrl,
    name: account.name,
    identity: account.identityPath ?? null,
  });

  // Handle abort signal
  const onAbort = () => {
    client.disconnect();
    clients.delete(accountId);
  };
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  try {
    await client.connect();
    clients.set(accountId, client);
    statusSink({ status: 'connected' });

    // Enable automatic identity verification responses
    client.enableAutoVerification(true);

    // Join configured channels
    if (account.autoJoin && account.channels.length > 0) {
      for (const ch of account.channels) {
        try {
          await client.join(ch);
        } catch (err) {
          // Channel might not exist — non-fatal
          console.warn(`[agentclaw] Failed to join ${ch}: ${(err as Error).message}`);
        }
      }
    }

    // Dispatch inbound messages to OpenClaw gateway
    client.on('message', async (msg: {
      from?: string;
      from_name?: string;
      to?: string;
      content?: string;
      ts?: number;
      msg_id?: string;
    }) => {
      if (!msg.from || !msg.content) return;

      // Skip our own messages
      if (msg.from === client.agentId) return;

      const peer = parseTarget(msg.from);

      await ctx.runtime.dispatch({
        channel: 'agentchat',
        accountId,
        peer,
        text: msg.content,
        metadata: {
          timestamp: msg.ts,
          originalMessageId: msg.msg_id,
          fromName: msg.from_name,
          sentTo: msg.to,
        },
      });
    });

    // Handle disconnection
    client.on('disconnect', () => {
      statusSink({ status: 'disconnected', message: 'Connection lost' });
      clients.delete(accountId);
    });

    client.on('error', (err: { message?: string }) => {
      statusSink({ status: 'error', message: err.message ?? 'Unknown error' });
    });

  } catch (err) {
    statusSink({ status: 'error', message: (err as Error).message });
    throw err;
  }

  // Return cleanup function
  return () => {
    ctx.abortSignal.removeEventListener('abort', onAbort);
    client.disconnect();
    clients.delete(accountId);
  };
}
