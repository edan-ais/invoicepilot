// Gemini-powered parser that turns a chat message into a structured invoice
// intent. Falls back to a small deterministic parser when no API key is set so
// the app still responds coherently (and local development stays free).

const MODEL = 'gemini-3.5-flash-lite';

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
  const dueMatch = lower.match(/due\s+in\s+(\d+)\s+days?/);
  const dueDays = dueMatch ? Math.min(Math.max(Number(dueMatch[1]), 1), 365) : 14;
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
      due_days: dueDays,
      note: null,
      reply: `Draft invoice for ${recipientMatch[1].trim()} - ${item.quantity} x ${item.name} at $${item.unit_price}. Say "send it" to send.`,
    };
  }
  return { action: 'chat', reply: 'Tell me who to bill and for what, e.g. "Invoice Blue Bottle for 2 cakes at $45 each".' };
}

// Marks a fallback reply so users can tell the deterministic offline
// parser answered instead of Gemini.
function offlineFallback(message) {
  const parsed = fallbackParse(message);
  parsed.reply = `[Offline mode - AI parser unavailable] ${parsed.reply}`;
  return parsed;
}

// Reads a Gemini SSE stream and concatenates the text chunks.
async function readStreamedText(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload);
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const p of parts) if (p.text) text += p.text;
      } catch {
        // incomplete JSON line; ignored
      }
    }
  }
  return text;
}

export async function parseMessage(env, message, contextSummary) {
  if (!env.GEMINI_API_KEY) return offlineFallback(message);
  // Streaming (SSE): a non-streaming call is byte-silent while the model
  // generates, and an edge proxy read timeout can cut a silent connection
  // before the response arrives. Chunks keep the connection alive. The
  // overall timeout keeps a stalled connection from hanging the chat.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;
  const prompt = contextSummary
    ? `Current invoice ledger summary: ${contextSummary}\n\nUser message: ${message}`
    : `User message: ${message}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => '');
      console.error('Gemini error', res.status, errBody.slice(0, 300));
      return offlineFallback(message);
    }
    const text = await readStreamedText(res.body);
    if (!text) return offlineFallback(message);
    try {
      const parsed = JSON.parse(text);
      if (!parsed.action) return offlineFallback(message);
      return parsed;
    } catch {
      return offlineFallback(message);
    }
  } catch (err) {
    console.error('Gemini fetch failed', String(err).slice(0, 200));
    return offlineFallback(message);
  } finally {
    clearTimeout(timer);
  }
}
