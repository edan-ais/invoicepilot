# InvoicePilot

Chat your way to paid - an AI invoice assistant built on the PayPal developer platform.

InvoicePilot turns plain language into real invoices. Describe a sale in chat
("Invoice Blue Bottle for 2 cakes at $45 each"), and InvoicePilot drafts the
invoice through the PayPal Invoicing API, sends it to the customer, tracks its
payment status, and answers questions like "who owes me money?" with live
totals. A dashboard next to the chat shows every invoice with its status,
payer link, and one-click send / status-check / mark-paid actions.

Built for the PayPal AI Hackathon.

## How it works

- **PayPal is the money rail.** Invoices are created, sent, and status-checked
  through the [PayPal Invoicing API v2](https://developer.paypal.com/docs/api/invoicing/v2/)
  against the free sandbox environment. No payment data ever lives in the app;
  PayPal is the system of record for every invoice lifecycle event.
- **Gemini is the AI layer.** Chat messages are parsed by
  `gemini-3.5-flash-lite` (Google AI Studio) into structured invoice intents
  (create, send, list outstanding, check status) with a strict JSON schema.
  Streaming responses and a 60-second timeout bound the AI request. A
  deterministic fallback parser handles supported requests when the model is
  unavailable; fallback replies are visibly labeled as offline mode.
- **Cloudflare Workers host it.** The API and static app run as one Worker;
  invoices are cached in Workers KV so the dashboard is instant while PayPal
  stays the source of truth (status is re-synced from PayPal on demand).

## Architecture

```
public/            chat UI + invoice dashboard (vanilla JS, no build step)
src/worker.js      routes: /api/chat, /api/invoices, /api/invoices/:id/(send|sync|mark-paid)
src/chat.js        intent orchestration: Gemini parse -> PayPal action -> ledger update
src/gemini.js      Gemini structured-output parser + deterministic fallback
src/paypal.js      PayPal Invoicing v2 adapter (sandbox + mock modes)
src/store.js       Workers KV invoice ledger
test/              local dev server (no Cloudflare needed) + tests
```

## Running it yourself

Prereqs: Node 20+, a free [PayPal Developer](https://developer.paypal.com/)
account, a free [Google AI Studio](https://aistudio.google.com/) API key, and a
free Cloudflare account.

1. **PayPal sandbox app.** In the PayPal Developer Dashboard, create a sandbox
   app (Business account) and copy its client ID and secret. The dashboard also
   gives you sandbox buyer/seller accounts for end-to-end testing.
2. **Install and configure.**
   ```bash
   npm install
   npx wrangler kv namespace create INVOICES   # paste the ids into wrangler.toml
   npx wrangler secret put PAYPAL_CLIENT_ID
   npx wrangler secret put PAYPAL_CLIENT_SECRET
   npx wrangler secret put GEMINI_API_KEY
   ```
3. **Develop locally** (no Cloudflare needed, mock PayPal mode):
   ```bash
   npm run dev    # http://localhost:8787
   ```
4. **Deploy.**
   ```bash
   npx wrangler deploy
   ```

`PAYPAL_MODE` in `wrangler.toml` selects `sandbox` (real PayPal sandbox API) or
`mock` (offline development). The hosted demo runs in `sandbox` mode.

## Demo access

The hosted demo is private by default. When the `DEMO_TOKEN` secret is set,
every page and API route requires it; visitors see an access page and entering
the token sets a cookie. Hackathon judges receive the token through the
submission's testing instructions (per the rules' private-site provision).
Local development leaves `DEMO_TOKEN` unset, which keeps the app open.

## Judging notes

- The verified hosted demonstration covers chat -> Gemini parse -> PayPal
  sandbox draft creation, including the requested amount and due date.
- Send, status-sync, and mark-paid controls are implemented. Invoice delivery,
  payment, status-sync correctness, and mark-paid are not demonstrated in the
  current review video. No real payment is made by this demo.
- AI availability can vary. A successful AI parse is distinct from the visibly
  labeled offline fallback; neither should be treated as a completed payment.
- Judges can use the hosted demo with the access token supplied privately in
  the testing instructions, or configure their own sandbox and AI credentials
  using the setup steps above. Do not commit credentials to the repository.

## License

MIT (c) 2026 Edan Harr. See [LICENSE](./LICENSE).
