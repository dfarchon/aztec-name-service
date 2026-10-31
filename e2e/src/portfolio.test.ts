import assert from 'node:assert/strict';
import test from 'node:test';
import { expiryCalendar } from '../../web/src/portfolio.js';
test('expiry calendar uses UTC, stable UID, escaped scope and a thirty-day reminder', () => {
  const items=[{name:'team.alice',expiresAt:1791650000n}];
  const a=expiryCalendar(items,'31337:0x123',1790000000n), b=expiryCalendar([{...items[0],expiresAt:1792650000n}],'31337:0x123',1790000000n);
  assert.match(a,/BEGIN:VCALENDAR\r\n/); assert.match(a,/TRIGGER:-P30D/); assert.match(a,/DTSTART:20261010T/);
  assert.equal(a.match(/UID:[^\r]+/)?.[0],b.match(/UID:[^\r]+/)?.[0]);
  assert.ok(a.split('\r\n').every(l=>Buffer.byteLength(l)<=75));
  assert.throws(()=>expiryCalendar([{name:'alice\r\nATTENDEE:bad',expiresAt:1n}],'scope'));
});
