// Lightweight tests: run with `npm test` (no external services needed).
import assert from 'node:assert/strict';
import { parseMessage } from '../src/gemini.js';
import { makePaypal } from '../src/paypal.js';
import { outstandingSummary, withDerivedStatus } from '../src/store.js';

const noKey = {};

// fallback parser
assert.equal((await parseMessage(noKey, 'who owes me money?')).action, 'list_outstanding');
const created = await parseMessage(noKey, 'Invoice Blue Bottle for 2 cakes at $45 each');
assert.equal(created.action, 'create_invoice');
assert.equal(created.recipient_name, 'Blue Bottle');
assert.deepEqual(created.items, [{ name: 'cakes', quantity: 2, unit_price: 45 }]);
assert.equal((await parseMessage(noKey, 'send it')).action, 'send_invoice');

// paypal mock adapter
const paypal = makePaypal({ PAYPAL_MODE: 'mock' });
const inv = await paypal.createInvoice({ number: 'INV-1', items: [{ name: 'x', quantity: 1, unit_price: 10 }] });
assert.equal(inv.status, 'DRAFT');
assert.ok(inv.paypal_id.startsWith('MOCK-'));
assert.equal((await paypal.sendInvoice(inv.paypal_id)).status, 'SENT');

// store helpers
const overdue = withDerivedStatus({ status: 'SENT', due_date: '2020-01-01' });
assert.equal(overdue.derived_status, 'OVERDUE');
assert.equal(withDerivedStatus({ status: 'SENT', due_date: '2999-01-01' }).derived_status, 'SENT');
const s = outstandingSummary([
  { status: 'SENT', total: 100, due_date: '2999-01-01' },
  { status: 'SENT', total: 50, due_date: '2020-01-01' },
  { status: 'PAID', total: 999 },
]);
assert.deepEqual(s, { open_count: 2, open_total: 150, overdue_count: 1, overdue_total: 50 });

console.log('all tests passed');
