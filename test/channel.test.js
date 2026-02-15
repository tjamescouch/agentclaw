import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTarget,
  formatTarget,
  backoffDelay,
  sendText,
  clients,
  reconnectStates,
  RECONNECT_MAX_ATTEMPTS,
} from '../dist/channel.js';

describe('parseTarget', () => {
  it('parses channel targets', () => {
    const result = parseTarget('#general');
    assert.deepStrictEqual(result, { id: '#general', type: 'channel' });
  });

  it('parses agent targets with @', () => {
    const result = parseTarget('@abc123');
    assert.deepStrictEqual(result, { id: '@abc123', type: 'agent' });
  });

  it('adds @ prefix to bare agent ids', () => {
    const result = parseTarget('abc123');
    assert.deepStrictEqual(result, { id: '@abc123', type: 'agent' });
  });

  it('handles channel with subpath', () => {
    const result = parseTarget('#project-alpha');
    assert.deepStrictEqual(result, { id: '#project-alpha', type: 'channel' });
  });
});

describe('formatTarget', () => {
  it('formats channel target', () => {
    assert.equal(formatTarget({ id: '#general', type: 'channel' }), '#general');
  });

  it('formats agent target', () => {
    assert.equal(formatTarget({ id: '@abc123', type: 'agent' }), '@abc123');
  });
});

describe('backoffDelay', () => {
  it('returns ~1s for first attempt', () => {
    const delay = backoffDelay(0);
    // 1000 base + up to 250 jitter
    assert.ok(delay >= 1000, `delay ${delay} should be >= 1000`);
    assert.ok(delay <= 1250, `delay ${delay} should be <= 1250`);
  });

  it('doubles with each attempt', () => {
    // attempt 1 = 2000 base, attempt 2 = 4000 base, etc.
    const d1 = backoffDelay(1);
    assert.ok(d1 >= 2000 && d1 <= 2500, `attempt 1 delay ${d1} out of range`);

    const d3 = backoffDelay(3);
    assert.ok(d3 >= 8000 && d3 <= 10000, `attempt 3 delay ${d3} out of range`);
  });

  it('caps at 60s', () => {
    const delay = backoffDelay(100);
    // 60000 + up to 15000 jitter
    assert.ok(delay <= 75000, `delay ${delay} should be <= 75000`);
    assert.ok(delay >= 60000, `delay ${delay} should be >= 60000`);
  });
});

describe('sendText', () => {
  afterEach(() => {
    clients.clear();
  });

  it('returns error when not connected', async () => {
    const result = await sendText({
      text: 'hello',
      to: { id: '#general', type: 'channel' },
      accountId: 'missing',
    });
    assert.deepStrictEqual(result, { ok: false, error: 'Not connected' });
  });

  it('returns error when client exists but disconnected', async () => {
    const fakeClient = { connected: false, send: async () => {} };
    clients.set('test', fakeClient);
    const result = await sendText({
      text: 'hello',
      to: { id: '#general', type: 'channel' },
      accountId: 'test',
    });
    assert.deepStrictEqual(result, { ok: false, error: 'Not connected' });
  });

  it('sends message when connected', async () => {
    let sentTo = '';
    let sentContent = '';
    const fakeClient = {
      connected: true,
      send: async (to, content, opts) => {
        sentTo = to;
        sentContent = content;
      },
    };
    clients.set('test', fakeClient);
    const result = await sendText({
      text: 'hello world',
      to: { id: '#general', type: 'channel' },
      accountId: 'test',
    });
    assert.deepStrictEqual(result, { ok: true });
    assert.equal(sentTo, '#general');
    assert.equal(sentContent, 'hello world');
  });

  it('handles send errors gracefully', async () => {
    const fakeClient = {
      connected: true,
      send: async () => { throw new Error('ws closed'); },
    };
    clients.set('test', fakeClient);
    const result = await sendText({
      text: 'hello',
      to: { id: '@agent', type: 'agent' },
      accountId: 'test',
    });
    assert.deepStrictEqual(result, { ok: false, error: 'ws closed' });
  });
});

describe('RECONNECT_MAX_ATTEMPTS', () => {
  it('is a reasonable number', () => {
    assert.ok(RECONNECT_MAX_ATTEMPTS >= 5, 'should allow at least 5 retries');
    assert.ok(RECONNECT_MAX_ATTEMPTS <= 50, 'should not retry forever');
  });
});
