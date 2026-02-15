import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listAccountIds, resolveAccount } from '../dist/config.js';

describe('listAccountIds', () => {
  it('returns empty array for empty config', () => {
    assert.deepStrictEqual(listAccountIds({}), []);
  });

  it('returns empty array for missing agentchat section', () => {
    assert.deepStrictEqual(listAccountIds({ channels: {} }), []);
  });

  it('returns account ids', () => {
    const cfg = {
      channels: {
        agentchat: {
          accounts: {
            primary: { wsUrl: 'wss://example.com' },
            secondary: { wsUrl: 'wss://other.com' },
          },
        },
      },
    };
    const ids = listAccountIds(cfg);
    assert.deepStrictEqual(ids.sort(), ['primary', 'secondary']);
  });
});

describe('resolveAccount', () => {
  it('returns defaults for empty config', () => {
    const account = resolveAccount({});
    assert.equal(account.accountId, 'default');
    assert.equal(account.enabled, true);
    assert.equal(account.wsUrl, 'wss://agentchat-server.fly.dev');
    assert.deepStrictEqual(account.channels, ['#general']);
    assert.equal(account.autoJoin, true);
  });

  it('merges config over defaults', () => {
    const cfg = {
      channels: {
        agentchat: {
          accounts: {
            myaccount: {
              wsUrl: 'wss://custom.server',
              channels: ['#dev', '#ops'],
              name: 'TestBot',
            },
          },
        },
      },
    };
    const account = resolveAccount(cfg, 'myaccount');
    assert.equal(account.accountId, 'myaccount');
    assert.equal(account.wsUrl, 'wss://custom.server');
    assert.deepStrictEqual(account.channels, ['#dev', '#ops']);
    assert.equal(account.name, 'TestBot');
    // Defaults still apply for unset fields
    assert.equal(account.enabled, true);
    assert.equal(account.autoJoin, true);
  });

  it('falls back to default account id', () => {
    const account = resolveAccount({}, undefined);
    assert.equal(account.accountId, 'default');
  });
});
