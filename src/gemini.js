// Gemini-powered parser that turns a chat message into a structured invoice
// intent. Falls back to a small deterministic parser when no API key is set so
// the app still responds coherently (and local development stays free).

const MODEL = 'gemini-2.0-flash';

const SYSTEM = `You are the parsing engine inside InvoicePilot, an AI invoice assistant built on PayPal.
Turn the user's message into ONE JSON object. No markdown, no prose, JSON only.

Schema:
{
  "action": "create_invoice" | "send_invoice" | "list_outstanding" | "invoice_status" | "mark_paid" | "chat",
  "recipient_name": string | null,        // who is being billed, for create_invoice
  "recipient_email": string | null,       // only if the user gave it, never invent one
  "items": [ { "name": string, "quantity": number, "unit_price": number } ] | null,
  "due_days": number | null,              // days until due; default 14 when unspecified
  "note": string | null,
  "invoice_ref": string | null,           // invoice number or recipient hint for send/status
  "reply": string                         // short friendly confirmation of what you understood
}

Rules:
- create_invoice only when a recipient and at least one priced item are clear.
- If something required is missing, use action "chat" and ask for it in "reply".
- Prices are USD unless the user says otherwise. Quantity defaults to 1.
- list_outstanding covers questions like "who owes me", "what is unpaid", "total outstanding".
- invoice_status covers asking about one specific invoice or customer.
- mark_paid covers "X paid me" / "mark the Y invoice as paid".
- Never invent recipients, amounts, or email addresses.`;

function fallbackParse(message) {
  const lower = message.toLowerCase();
  if (/who owes|outstanding|unpaid|owed/.test(lower)) {
    return { action: 'list_outstanding', reply: 'Here is what is still outstanding.' };
  }
  const paidMatch = message.match(/([A-Za-z][\w .''-]{1,40}?)\s+(?:paid|has paid)\b/i);
  if (paidMatch) return { action: 'mark_paid', invoice_ref: paidMatch[1].trim(), reply: 'Marking it paid.' };
  if (/^(send|resend)\b/.test(lower)) {
    return { action: 'send_invoice', invoice_ref: null, reply: 'Sending the latest draft.' };
  }
  if (!/(invoice|bill)\b/i.test(message)) {
    return { action: 'chat', reply: 'Tell me who to bill and for what, e.g. "Invoice Blue Bottle for 2 cakes at $45 each".' };
  }
  const recipientMatch = message.match(/(?:invoice|bill)\s+([A-Za-z][\w .''-]{0,40}?)\s+(?:for|\$)/i);
  // "2 cakes at $45" style item
  const afterFor = message.split(/\bfor\b/i)[1] || message;
  const itemMatch = afterFor.match(/(\d+(?:\.\d+)?)\s+([A-Za-z][\w .''-]{1,40}?)\s+(?:at|@|x)\s*\$?(\d+(?:\.\d{1,2})?)/i);
  const dollarMatch = message.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  if (recipientMatch && (itemMatch || dollarMatch)) {
    const item = itemMatch
      ? { name: itemMatch[2].trim(), quantity: Number(itemMatch[1] || 1), unit_price: Number(itemMatch[3]) }
      : { name: 'Services', quantity: 1, unit_price: Number(dollarMatch[1]) };
    return {
      action: 'create_invoice',
      recipient_name: recipientMatch[1].trim(),
      recipient_email: null,
      items: [item],
      due_days: 14,
      note: null,
      reply: `Draft invoice for ${recipientMatch[1].trim()} - ${item.quantity} x ${item.name} at $${item.unit_price}. Say "send it" to send.`,
    };
  }
  return { action: 'chat', reply: 'Tell me who to bill and for what, e.g. "Invoice Blue Bottle for 2 cakes at $45 each".' };
}

export async function parseMessage(env, message, contextSummary) {
  if (!env.GEMINI_API_KEY) return fallbackParse(message);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const prompt = contextSummary
    ? `Current invoice ledger summary: ${contextSummary}\n\nUser message: ${message}`
    : `User message: ${message}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Gemini error', res.status, JSON.stringify(body).slice(0, 300));
    return fallbackParse(message);
  }
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return fallbackParse(message);
  try {
    const parsed = JSON.parse(text);
    if (!parsed.action) return fallbackParse(message);
    return parsed;
  } catch {
    return fallbackParse(message);
  }
}
