// Chat orchestration: Gemini-parsed intent -> PayPal action + ledger update ->
// natural language reply. Every invoice mutation flows through here so the chat
// and the dashboard never disagree about state.

import { parseMessage } from './gemini.js';
import { makePaypal, PaypalError } from './paypal.js';
import { nextInvoiceNumber, saveInvoice, listInvoices, getInvoice, withDerivedStatus, outstandingSummary } from './store.js';

const money = (n) => `$${Number(n).toFixed(2)}`;

function invoiceTotal(items) {
  return Math.round(items.reduce((acc, i) => acc + Number(i.quantity) * Number(i.unit_price), 0) * 100) / 100;
}

function describeInvoice(inv) {
  return `${inv.number} to ${inv.recipient_name} for ${money(inv.total)} (${withDerivedStatus(inv).derived_status})`;
}

async function findInvoice(kv, ref) {
  const invoices = await listInvoices(kv);
  if (!ref) {
    return invoices.find((i) => i.status === 'DRAFT') || invoices[0] || null;
  }
  const needle = String(ref).toLowerCase();
  return (
    invoices.find((i) => i.number.toLowerCase() === needle) ||
    invoices.find((i) => i.recipient_name.toLowerCase().includes(needle)) ||
    null
  );
}

export async function handleChat(request, env) {
  let message;
  try {
    const body = await request.json();
    message = String(body.message || '').slice(0, 2000);
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!message.trim()) return Response.json({ error: 'message is required' }, { status: 400 });

  const kv = env.INVOICES;
  const paypal = makePaypal(env);
  const invoices = await listInvoices(kv);
  const summary = JSON.stringify({
    invoices: invoices.map((i) => ({ number: i.number, to: i.recipient_name, total: i.total, status: i.status, due: i.due_date })),
    outstanding: outstandingSummary(invoices),
  });

  const intent = await parseMessage(env, message, summary);

  try {
    switch (intent.action) {
      case 'create_invoice': {
        if (!intent.recipient_name || !intent.items?.length) {
          return Response.json({ reply: intent.reply || 'Who should I bill, and for what?' });
        }
        const items = intent.items.map((i) => ({
          name: String(i.name).slice(0, 120),
          quantity: Number(i.quantity) || 1,
          unit_price: Number(i.unit_price) || 0,
        }));
        if (items.some((i) => i.unit_price <= 0)) {
          return Response.json({ reply: 'I need a price for each item before I can draft that invoice.' });
        }
        const dueDays = Number(intent.due_days) > 0 ? Number(intent.due_days) : 14;
        const invoice = {
          id: crypto.randomUUID(),
          number: await nextInvoiceNumber(kv),
          recipient_name: String(intent.recipient_name).slice(0, 120),
          recipient_email: intent.recipient_email || null,
          items,
          total: invoiceTotal(items),
          currency: 'USD',
          note: intent.note || null,
          due_date: new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10),
          status: 'DRAFT',
          seller_given_name: env.SELLER_GIVEN_NAME || 'Edan',
          seller_surname: env.SELLER_SURNAME || 'Harr',
          seller_email: env.SELLER_EMAIL || null,
          created_at: new Date().toISOString(),
        };
        const result = await paypal.createInvoice(invoice);
        invoice.paypal_id = result.paypal_id;
        invoice.status = result.status;
        invoice.payer_view_url = result.payer_view_url;
        await saveInvoice(kv, invoice);
        return Response.json({
          reply: `${intent.reply || 'Draft created.'} Saved as ${invoice.number} for ${money(invoice.total)}, due ${invoice.due_date}.`,
          invoice,
        });
      }

      case 'send_invoice': {
        const invoice = await findInvoice(kv, intent.invoice_ref);
        if (!invoice) return Response.json({ reply: 'I could not find that invoice. Which one should I send?' });
        if (invoice.status !== 'DRAFT') {
          return Response.json({ reply: `${invoice.number} is already ${invoice.status.toLowerCase()}.` });
        }
        await paypal.sendInvoice(invoice.paypal_id);
        invoice.status = 'SENT';
        invoice.sent_at = new Date().toISOString();
        await saveInvoice(kv, invoice);
        return Response.json({
          reply: `${invoice.number} to ${invoice.recipient_name} for ${money(invoice.total)} is sent.${invoice.recipient_email ? '' : ' No recipient email on file, so share the payer link from the dashboard.'}`,
          invoice,
        });
      }

      case 'list_outstanding': {
        const open = invoices.filter((i) => ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(i.status));
        if (!open.length) return Response.json({ reply: 'Nothing outstanding right now - every sent invoice is paid.' });
        const s = outstandingSummary(invoices);
        const lines = open.map((i) => describeInvoice(i)).join('; ');
        return Response.json({
          reply: `${s.open_count} open invoice${s.open_count === 1 ? '' : 's'} totalling ${money(s.open_total)}${s.overdue_count ? `, of which ${s.overdue_count} ${s.overdue_count === 1 ? 'is' : 'are'} overdue (${money(s.overdue_total)})` : ''}: ${lines}.`,
        });
      }

      case 'mark_paid': {
        const invoice = await findInvoice(kv, intent.invoice_ref);
        if (!invoice) return Response.json({ reply: 'Which invoice was paid? Give me the number or the customer name.' });
        invoice.status = 'PAID';
        invoice.paid_at = new Date().toISOString();
        await saveInvoice(kv, invoice);
        return Response.json({ reply: `Marked ${describeInvoice({ ...invoice, status: 'PAID' })} - that is ${money(invoice.total)} collected.`, invoice });
      }

      case 'invoice_status': {
        const invoice = await findInvoice(kv, intent.invoice_ref);
        if (!invoice) return Response.json({ reply: 'I could not find that invoice - try the invoice number or the customer name.' });
        if (invoice.paypal_id && invoice.status !== 'DRAFT') {
          const live = await paypal.getInvoiceStatus(invoice.paypal_id);
          if (live.status !== invoice.status) {
            invoice.status = live.status;
            await saveInvoice(kv, invoice);
          }
        }
        return Response.json({ reply: `${describeInvoice(invoice)}, due ${invoice.due_date}.`, invoice });
      }

      default:
        return Response.json({ reply: intent.reply || 'I can draft invoices, send them, and tell you who owes what. Try "Invoice Blue Bottle for 2 cakes at $45 each".' });
    }
  } catch (err) {
    const detail = err instanceof PaypalError ? err.message : 'Unexpected error';
    console.error('chat action failed', err);
    return Response.json({ reply: `That hit a problem: ${detail}. The ledger is unchanged - try again in a moment.` }, { status: 502 });
  }
}

export async function syncInvoice(env, id) {
  const kv = env.INVOICES;
  const invoice = await getInvoice(kv, id);
  if (!invoice) return null;
  if (!invoice.paypal_id || invoice.status === 'DRAFT') return invoice;
  const paypal = makePaypal(env);
  const live = await paypal.getInvoiceStatus(invoice.paypal_id);
  invoice.status = live.status;
  if (live.payer_view_url) invoice.payer_view_url = live.payer_view_url;
  await saveInvoice(kv, invoice);
  return invoice;
}
