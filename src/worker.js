// InvoicePilot worker: serves the static app and the JSON API.

import { handleChat, syncInvoice } from './chat.js';
import { listInvoices, getInvoice, saveInvoice, withDerivedStatus } from './store.js';
import { makePaypal, PaypalError } from './paypal.js';

const json = (data, status = 200) => Response.json(data, { status });


// Demo access gate. When DEMO_TOKEN is set, every page and API call requires it:
// visitors see an access page, and entering the token sets a cookie. This keeps
// the hosted demo private by default; judges receive the token through the
// hackathon's testing instructions, as the rules allow. When unset (local dev),
// the app is open.

const ACCESS_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InvoicePilot demo access</title>
<style>
body{background:#0e1420;color:#e8edf6;font-family:-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#161f30;border:1px solid #232f47;border-radius:14px;padding:32px;max-width:380px;text-align:center}
h1{font-size:20px;margin:0 0 6px}
p{color:#93a1b8;font-size:13.5px;margin:0 0 18px}
form{display:flex;gap:8px}
input{flex:1;background:#0e1420;border:1px solid #2a3a5c;color:#e8edf6;border-radius:10px;padding:11px 12px;font-size:14px}
button{background:#4f8cff;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:600;cursor:pointer}
.err{color:#e5685e;font-size:12.5px;margin-top:10px;display:none}
</style></head><body><div class="card">
<h1>InvoicePilot</h1>
<p>This demo is private. Enter the access token from the hackathon testing instructions to continue.</p>
<form method="POST" action="/api/access"><input name="token" type="password" placeholder="Access token" autocomplete="off" autofocus><button>Open</button></form>
<div class="err" id="e">That token did not work - check the testing instructions.</div>
</div><script>if(location.search.includes("bad=1"))document.getElementById("e").style.display="block"</script>
</body></html>`;

function demoTokenOk(request, env) {
  if (!env.DEMO_TOKEN) return true;
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)demo_token=([^;]+)/);
  return match ? match[1] === env.DEMO_TOKEN : false;
}

async function handleAccessPost(request, env) {
  const form = await request.formData().catch(() => null);
  const token = form?.get('token');
  if (env.DEMO_TOKEN && token === env.DEMO_TOKEN) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/',
        'Set-Cookie': `demo_token=${env.DEMO_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      },
    });
  }
  return new Response(null, { status: 303, headers: { Location: '/?bad=1' } });
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/access' && request.method === 'POST') {
      return handleAccessPost(request, env);
    }
    if (!demoTokenOk(request, env)) {
      if (url.pathname.startsWith('/api/')) return json({ error: 'demo access token required' }, 401);
      return new Response(ACCESS_PAGE, { headers: { 'Content-Type': 'text/html' } });
    }

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
