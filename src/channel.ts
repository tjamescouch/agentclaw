/**
 * Agentclaw Channel Plugin
 * Bridges OpenClaw agents into AgentChat via WebSocket
 *
 * Outbound: OpenClaw -> AgentChat (send messages to channels/agents)
 * Inbound:  AgentChat -> OpenClaw (dispatch incoming messages to gateway)
 *
 * Features:
 * - Automatic reconnection with exponential backoff + jitter
 * - Periodic keepalive pings to detect silent disconnects
 * - Inbound message dispatch with error isolation
 * - Graceful cleanup on abort signal
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

/** Reconnection state per account */
interface ReconnectState {
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

const reconnectStates = new Map<string, ReconnectState>();

/** Reconnection constants */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 20;
const KEEPALIVE_INTERVAL_MS = 30_000;
const KEEPALIVE_TIMEOUT_MS = 10_000;

/**
 * Calculate backoff delay with exponential increase + jitter
 */
export function backoffDelay(attempt: number): number {
  const exponential = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, attempt),
    RECONNECT_MAX_MS
  );
  // Add up to 25% jitter to prevent thundering herd
  const jitter = Math.random() * exponential * 0.25;
  return Math.floor(exponential + jitter);
}

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
 * Get an active AgentChatClient for an account
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
 * Wire up inbound message dispatch from AgentChat to OpenClaw gateway.
 * Errors in dispatch are caught and logged — a single bad message
 * should never kill the connection.
 */
function attachMessageHandler(
  client: AgentChatClient,
  accountId: string,
  ctx: GatewayContext
): void {
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

    try {
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
    } catch (err) {
      console.error(
        `[agentclaw] Dispatch error for msg from ${msg.from_name ?? msg.from}:`,
        (err as Error).message
      );
    }
  });
}

/**
 * Start a keepalive ping loop. Sends PING every interval and
 * disconnects if no PONG arrives within the timeout.
 * Returns a cleanup function to stop the loop.
 */
function startKeepalive(
  client: AgentChatClient,
  statusSink: (update: StatusUpdate) => void
): () => void {
  let pongReceived = true;

  const onPong = () => {
    pongReceived = true;
  };
  client.on('pong', onPong);

  const interval = setInterval(() => {
    if (!client.connected) {
      clearInterval(interval);
      return;
    }
    if (!pongReceived) {
      // Missed a pong — consider the connection dead
      console.warn('[agentclaw] Keepalive timeout — forcing disconnect');
      statusSink({ status: 'error', message: 'Keepalive timeout' });
      client.disconnect();
      clearInterval(interval);
      return;
    }
    pongReceived = false;
    try {
      client.ping();
    } catch {
      // ping() may throw if ws is already closing
      clearInterval(interval);
    }
  }, KEEPALIVE_INTERVAL_MS);

  return () => {
    clearInterval(interval);
    client.removeListener('pong', onPong);
  };
}

/**
 * Connect a single client, join channels, wire up handlers.
 * Used for both initial connection and reconnection.
 */
async function connectClient(options: {
  account: AgentClawAccount;
  accountId: string;
  ctx: GatewayContext;
  statusSink: (update: StatusUpdate) => void;
}): Promise<{ client: AgentChatClient; stopKeepalive: () => void }> {
  const { account, accountId, ctx, statusSink } = options;

  const client = new AgentChatClient({
    server: account.wsUrl,
    name: account.name,
    identity: account.identityPath ?? null,
  });

  await client.connect();
  clients.set(accountId, client);
  statusSink({ status: 'connected' });

  // Enable automatic identity verification responses
  client.enableAutoVerification(true);

  // Join configured channels (in parallel, non-fatal)
  if (account.autoJoin && account.channels.length > 0) {
    const joinResults = await Promise.allSettled(
      account.channels.map((ch) => client.join(ch))
    );
    for (let i = 0; i < joinResults.length; i++) {
      const result = joinResults[i];
      if (result.status === 'rejected') {
        console.warn(
          `[agentclaw] Failed to join ${account.channels[i]}: ${result.reason}`
        );
      }
    }
  }

  // Wire up inbound message dispatch
  attachMessageHandler(client, accountId, ctx);

  // Start keepalive pings
  const stopKeepalive = startKeepalive(client, statusSink);

  return { client, stopKeepalive };
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 */
function scheduleReconnect(options: {
  account: AgentClawAccount;
  accountId: string;
  ctx: GatewayContext;
  statusSink: (update: StatusUpdate) => void;
}): void {
  const { accountId, statusSink } = options;
  let state = reconnectStates.get(accountId);
  if (!state) {
    state = { attempt: 0, timer: null, stopped: false };
    reconnectStates.set(accountId, state);
  }

  if (state.stopped) return;

  if (state.attempt >= RECONNECT_MAX_ATTEMPTS) {
    statusSink({
      status: 'error',
      message: `Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts — giving up`,
    });
    reconnectStates.delete(accountId);
    return;
  }

  const delay = backoffDelay(state.attempt);
  statusSink({
    status: 'connecting',
    message: `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${state.attempt + 1}/${RECONNECT_MAX_ATTEMPTS})`,
  });

  state.timer = setTimeout(async () => {
    const currentState = reconnectStates.get(accountId);
    if (!currentState || currentState.stopped) return;

    try {
      const { client, stopKeepalive } = await connectClient(options);
      // Reset attempt counter on success
      currentState.attempt = 0;

      // Re-attach disconnect handler for future disconnects
      attachLifecycleHandlers(client, stopKeepalive, options);
    } catch (err) {
      console.warn(
        `[agentclaw] Reconnect attempt ${currentState.attempt + 1} failed:`,
        (err as Error).message
      );
      currentState.attempt++;
      scheduleReconnect(options);
    }
  }, delay);
}

/**
 * Attach disconnect/error handlers that trigger reconnection.
 */
function attachLifecycleHandlers(
  client: AgentChatClient,
  stopKeepalive: () => void,
  options: {
    account: AgentClawAccount;
    accountId: string;
    ctx: GatewayContext;
    statusSink: (update: StatusUpdate) => void;
  }
): void {
  const { accountId, statusSink } = options;

  client.on('disconnect', () => {
    stopKeepalive();
    clients.delete(accountId);
    statusSink({ status: 'disconnected', message: 'Connection lost' });

    // Only reconnect if we haven't been explicitly stopped
    const state = reconnectStates.get(accountId);
    if (!state?.stopped) {
      scheduleReconnect(options);
    }
  });

  client.on('error', (err: { message?: string }) => {
    statusSink({ status: 'error', message: err.message ?? 'Unknown error' });
  });
}

/**
 * Start an account connection — connects to AgentChat, joins channels,
 * and dispatches inbound messages to the OpenClaw gateway runtime.
 *
 * Includes automatic reconnection with exponential backoff and
 * periodic keepalive pings to detect silent disconnects.
 *
 * Returns a cleanup function that disconnects the client and
 * cancels any pending reconnection.
 */
export async function startAccount(options: {
  account: AgentClawAccount;
  accountId: string;
  ctx: GatewayContext;
  statusSink: (update: StatusUpdate) => void;
}): Promise<() => void> {
  const { account, accountId, ctx, statusSink } = options;

  statusSink({ status: 'connecting', message: `Connecting to ${account.wsUrl}` });

  // Initialize reconnect state
  reconnectStates.set(accountId, { attempt: 0, timer: null, stopped: false });

  // Handle abort signal
  const onAbort = () => cleanup();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  const { client, stopKeepalive } = await connectClient(options);

  // Attach lifecycle handlers for reconnection
  attachLifecycleHandlers(client, stopKeepalive, options);

  // Cleanup function — stops everything cleanly
  function cleanup(): void {
    ctx.abortSignal.removeEventListener('abort', onAbort);

    // Mark stopped so reconnect loop exits
    const state = reconnectStates.get(accountId);
    if (state) {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
    }
    reconnectStates.delete(accountId);

    // Stop keepalive and disconnect
    stopKeepalive();
    const currentClient = clients.get(accountId);
    if (currentClient) {
      currentClient.disconnect();
      clients.delete(accountId);
    }
  }

  return cleanup;
}

/** Exported for testing */
export { clients, reconnectStates, RECONNECT_MAX_ATTEMPTS };
