const log = document.getElementById('chat-log');
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const list = document.getElementById('invoice-list');
const outstanding = document.getElementById('outstanding');
const modePill = document.getElementById('mode-pill');

function addMsg(text, who) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

const fmt = (n) => `$${Number(n).toFixed(2)}`;

function statusPill(status) {
  return `<span class="status ${status}">${status.replace('_', ' ')}</span>`;
}

async function refreshBoard() {
  const res = await fetch('/api/invoices');
  const { invoices } = await res.json();
  const open = invoices.filter((i) => ['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(i.derived_status));
  const openTotal = open.reduce((a, i) => a + Number(i.total), 0);
  outstanding.textContent = open.length
    ? `${open.length} open - ${fmt(openTotal)} outstanding`
    : 'Nothing outstanding';
  if (!invoices.length) {
    list.innerHTML = '<div class="empty">No invoices yet. Draft one from the chat.</div>';
    return;
  }
  list.innerHTML = invoices.map((inv) => {
    const items = inv.items.map((i) => `${i.quantity} x ${i.name}`).join(', ');
    const actions = [];
    if (inv.derived_status === 'DRAFT') {
      actions.push(`<button class="primary" data-act="send" data-id="${inv.id}">Send invoice</button>`);
    }
    if (['SENT', 'OVERDUE', 'PARTIALLY_PAID'].includes(inv.derived_status)) {
      actions.push(`<button data-act="sync" data-id="${inv.id}">Check status</button>`);
      actions.push(`<button data-act="mark-paid" data-id="${inv.id}">Mark paid</button>`);
    }
    if (inv.payer_view_url) {
      actions.push(`<a href="${inv.payer_view_url}" target="_blank" rel="noopener">Payer link</a>`);
    }
    return `<div class="card">
      <div class="num">${inv.number} ${statusPill(inv.derived_status)}</div>
      <div class="amount">${fmt(inv.total)}</div>
      <div class="to">${inv.recipient_name}</div>
      <div></div>
      <div class="meta">${items} &middot; due ${inv.due_date}${inv.recipient_email ? ' &middot; ' + inv.recipient_email : ''}</div>
      <div class="actions">${actions.join('')}</div>
    </div>`;
  }).join('');
}

async function sendChat(message) {
  addMsg(message, 'user');
  const thinking = document.createElement('div');
  thinking.className = 'msg bot';
  thinking.textContent = '...';
  log.appendChild(thinking);
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    thinking.textContent = data.reply || data.error || 'Something went wrong.';
  } catch {
    thinking.textContent = 'Network error - please try again.';
  }
  refreshBoard();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  sendChat(message);
});

document.querySelectorAll('.chip').forEach((chip) =>
  chip.addEventListener('click', () => sendChat(chip.dataset.msg))
);

list.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await fetch(`/api/invoices/${btn.dataset.id}/${btn.dataset.act}`, { method: 'POST' });
  } finally {
    btn.disabled = false;
    refreshBoard();
  }
});

(async () => {
  const health = await fetch('/api/health').then((r) => r.json()).catch(() => null);
  modePill.textContent = health ? `paypal ${health.paypal_mode}` : 'offline';
  if (health?.paypal_mode === 'sandbox') modePill.classList.add('sandbox');
  addMsg('Hi! Tell me who to bill and for what - I will draft the invoice on PayPal, send it, and keep track of who has paid.', 'bot');
  refreshBoard();
})();
