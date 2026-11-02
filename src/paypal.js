// PayPal adapter. Two modes:
//   sandbox - real PayPal sandbox REST API (Invoicing v2) using client credentials
//   mock    - deterministic in-memory behaviour for local development and tests
// Mode is selected with env.PAYPAL_MODE. Secrets come from env, never from code.

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

export class PaypalError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

async function sandboxToken(env) {
  const basic = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const res = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PaypalError(`PayPal auth failed (${res.status})`, body);
  return body.access_token;
}

async function sandboxRequest(env, path, options = {}) {
  const token = await sandboxToken(env);
  const res = await fetch(`${SANDBOX_BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new PaypalError(`PayPal ${options.method || 'GET'} ${path} failed (${res.status})`, body);
  return body;
}

function toPaypalInvoice(invoice) {
  return {
    detail: {
      invoice_number: invoice.number,
      currency_code: invoice.currency || 'USD',
      note: invoice.note || '',
      payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: invoice.due_date },
    },
    invoicer: {
      name: { given_name: invoice.seller_given_name || 'Edan', surname: invoice.seller_surname || 'Harr' },
      ...(invoice.seller_email ? { email_address: invoice.seller_email } : {}),
    },
    primary_recipients: [
      {
        billing_info: {
          name: { full_name: invoice.recipient_name },
          ...(invoice.recipient_email ? { email_address: invoice.recipient_email } : {}),
        },
      },
    ],
    items: invoice.items.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      unit_amount: { currency_code: invoice.currency || 'USD', value: Number(item.unit_price).toFixed(2) },
    })),
  };
}

function fromPaypalStatus(status) {
  const map = { DRAFT: 'DRAFT', SENT: 'SENT', PAID: 'PAID', MARKED_AS_PAID: 'PAID', PARTIALLY_PAID: 'PARTIALLY_PAID', CANCELLED: 'CANCELLED', REFUNDED: 'REFUNDED' };
  return map[status] || status || 'DRAFT';
}

// --- mock mode -------------------------------------------------------------
const mockState = { seq: 0 };

function mockCreate(invoice) {
  mockState.seq += 1;
  return {
    paypal_id: `MOCK-${Date.now()}-${mockState.seq}`,
    status: 'DRAFT',
    payer_view_url: `https://www.sandbox.paypal.com/invoice/p/#MOCK${mockState.seq}`,
  };
}

function mockSend() {
  return { status: 'SENT' };
}

function mockGet(current) {
  return { status: current.status || 'SENT' };
}

// --- public adapter ----------------------------------------------------------
export function makePaypal(env) {
  const mode = (env.PAYPAL_MODE || 'mock').toLowerCase();
  const sandbox = mode === 'sandbox';

  return {
    mode,
    async createInvoice(invoice) {
      if (!sandbox) return mockCreate(invoice);
      const created = await sandboxRequest(env, '/v2/invoicing/invoices', { method: 'POST', body: toPaypalInvoice(invoice) });
      const id = created.id || (created.href || '').split('/').pop();
      return {
        paypal_id: id,
        status: fromPaypalStatus(created.status || 'DRAFT'),
        payer_view_url: (created.links || []).find((l) => l.rel === 'payer-view')?.href || null,
      };
    },
    async sendInvoice(paypalId) {
      if (!sandbox) return mockSend();
      await sandboxRequest(env, `/v2/invoicing/invoices/${paypalId}/send`, {
        method: 'POST',
        body: { send_to_recipient: true },
      });
      return { status: 'SENT' };
    },
    async getInvoiceStatus(paypalId) {
      if (!sandbox) return mockGet({ status: 'SENT' });
      const inv = await sandboxRequest(env, `/v2/invoicing/invoices/${paypalId}`);
      return {
        status: fromPaypalStatus(inv.status),
        payer_view_url: (inv.links || []).find((l) => l.rel === 'payer-view')?.href || null,
      };
    },
  };
}
