// InvoicePilot worker: serves the static app and the JSON API.

import { handleChat, syncInvoice } from './chat.js';
import { listInvoices, getInvoice, saveInvoice, withDerivedStatus } from './store.js';
import { makePaypal, PaypalError } from './paypal.js';

const json = (data, status = 200) => Response.json(data, { status });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    if (url.pathname === '/api/invoices' && request.method === 'GET') {
      const invoices = await listInvoices(env.INVOICES);
      return json({ invoices: invoices.map(withDerivedStatus) });
    }

    const actionMatch = url.pathname.match(/^\/api\/invoices\/([\w-]+)\/(send|sync|mark-paid)$/);
    if (actionMatch && request.method === 'POST') {
      const [, id, action] = actionMatch;
      const kv = env.INVOICES;
      const paypal = makePaypal(env);
      const invoice = await getInvoice(kv, id);
      if (!invoice) return json({ error: 'invoice not found' }, 404);
      try {
        if (action === 'send') {
          if (invoice.status !== 'DRAFT') return json({ error: `already ${invoice.status.toLowerCase()}` }, 409);
          await paypal.sendInvoice(invoice.paypal_id);
          invoice.status = 'SENT';
          invoice.sent_at = new Date().toISOString();
        } else if (action === 'sync') {
          return json({ invoice: withDerivedStatus(await syncInvoice(env, id)) });
        } else if (action === 'mark-paid') {
          invoice.status = 'PAID';
          invoice.paid_at = new Date().toISOString();
        }
        await saveInvoice(kv, invoice);
        return json({ invoice: withDerivedStatus(invoice) });
      } catch (err) {
        console.error('invoice action failed', err);
        const msg = err instanceof PaypalError ? err.message : 'unexpected error';
        return json({ error: msg }, 502);
      }
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, paypal_mode: (env.PAYPAL_MODE || 'mock').toLowerCase() });
    }

    return env.ASSETS.fetch(request);
  },
};
