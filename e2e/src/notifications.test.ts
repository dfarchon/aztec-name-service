import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationsEnabled, enableNotifications, disableNotifications, notifyIncidents } from '../../web/src/monitor-notifications.js';

test('monitor notifications require opt-in, ignore history and deduplicate failure/recovery events', async () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const notification = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  const values = new Map<string, string>();
  const delivered: string[] = [];
  class FixtureNotification {
    static permission = 'granted';
    static async requestPermission() { return this.permission; }
    constructor(title: string) { delivered.push(title); }
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FixtureNotification });
  try {
    assert.equal(notificationsEnabled(), false);
    notifyIncidents([{ name: 'rpc', kind: 'alert', at: Date.now() + 1 }], { rpc: 'RPC' });
    assert.equal(delivered.length, 0);
    assert.equal(await enableNotifications(), true);
    const at = Date.now() + 100;
    const events = [{ name: 'rpc', kind: 'alert', at }, { name: 'rpc', kind: 'recovered', at: at + 1 }];
    notifyIncidents([{ name: 'website', kind: 'alert', at: 1 }, ...events], { rpc: 'RPC' });
    assert.deepEqual(delivered, ['ANS · RPC ongoing issue', 'ANS · RPC recovered']);
    notifyIncidents(events, { rpc: 'RPC' }); assert.equal(delivered.length, 2);
    disableNotifications(); notifyIncidents([{ name: 'rpc', kind: 'alert', at: at + 2 }], {});
    assert.equal(delivered.length, 2);
    FixtureNotification.permission = 'denied'; assert.equal(await enableNotifications(), false);
  } finally {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete (globalThis as any).localStorage;
    if (notification) Object.defineProperty(globalThis, 'Notification', notification); else delete (globalThis as any).Notification;
  }
});
