// Local dev server: serves public/ and the /api routes with an in-memory KV
// shim, so development needs no Cloudflare account. Run: npm run dev
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const root = fileURLToPath(new URL('../public', import.meta.url));
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function memoryKV() {
  const map = new Map();
  return {
    async get(key, opts) {
      if (!map.has(key)) return null;
      const raw = map.get(key);
      return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { map.set(key, value); },
  };
}

const env = {
  INVOICES: memoryKV(),
  PAYPAL_MODE: process.env.PAYPAL_MODE || 'mock',
  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  SELLER_EMAIL: process.env.SELLER_EMAIL,
  DEMO_TOKEN: process.env.DEMO_TOKEN,
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      try {
        const body = await readFile(join(root, path));
        return new Response(body, { headers: { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  },
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:8787${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(8787, () => console.log('InvoicePilot dev server on http://localhost:8787 (paypal:', env.PAYPAL_MODE + ')'));
