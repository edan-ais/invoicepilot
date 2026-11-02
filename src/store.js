// Invoice storage. Works against a Cloudflare KV namespace (env.INVOICES) or any
// KV-like shim exposing get/put with { type: 'json' } support, which keeps local
// development and tests free of Cloudflare.

const SEQ_KEY = 'seq:invoice-number';
const INDEX_KEY = 'index:invoice-ids';

async function kvGet(kv, key) {
  if (!kv) return null;
  return kv.get(key, { type: 'json' });
}

export async function nextInvoiceNumber(kv) {
  const current = (await kvGet(kv, SEQ_KEY)) || 1000;
  const next = current + 1;
  await kv.put(SEQ_KEY, JSON.stringify(next));
  return `INV-${next}`;
}

export async function saveInvoice(kv, invoice) {
  invoice.updated_at = new Date().toISOString();
  await kv.put(`inv:${invoice.id}`, JSON.stringify(invoice));
  const index = (await kvGet(kv, INDEX_KEY)) || [];
  if (!index.includes(invoice.id)) {
    index.unshift(invoice.id);
    await kv.put(INDEX_KEY, JSON.stringify(index));
  }
  return invoice;
}

export async function getInvoice(kv, id) {
  return kvGet(kv, `inv:${id}`);
}

export async function listInvoices(kv) {
  const index = (await kvGet(kv, INDEX_KEY)) || [];
  const invoices = [];
  for (const id of index) {
    const inv = await kvGet(kv, `inv:${id}`);
    if (inv) invoices.push(inv);
  }
  return invoices;
}

export function withDerivedStatus(invoice) {
  const out = { ...invoice };
  if (out.status === 'SENT' && out.due_date && new Date(out.due_date) < new Date()) {
    out.derived_status = 'OVERDUE';
  } else {
    out.derived_status = out.status;
  }
  return out;
}

export function outstandingSummary(invoices) {
  const open = invoices.filter((i) => ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(i.status));
  const overdue = open.filter((i) => withDerivedStatus(i).derived_status === 'OVERDUE');
  const sum = (list) => list.reduce((acc, i) => acc + Number(i.total || 0), 0);
  return {
    open_count: open.length,
    open_total: Math.round(sum(open) * 100) / 100,
    overdue_count: overdue.length,
    overdue_total: Math.round(sum(overdue) * 100) / 100,
  };
}
