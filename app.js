import { drawLine } from "./chart.js";

const OWNER = "antevy";
const REPO = "desk";
const DATA_REF = "data";
const KEY_LS = "desk.app.k";
const POLL_MS = 60_000;

export function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function decryptEnvelope(envelope, keyB64) {
  const key = await crypto.subtle.importKey("raw", b64urlToBytes(keyB64), "AES-GCM", false, ["decrypt"]);
  const iv = b64urlToBytes(envelope.iv);
  const ct = b64urlToBytes(envelope.ct);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

export function normalizeKey(raw) {
  let s = String(raw || "").trim();
  const fromUrl = s.match(/#k=([^&\s]+)/i);
  if (fromUrl) s = fromUrl[1];
  s = s.replace(/^#?k=/i, "");
  return s.replace(/\s+/g, "");
}

export function keyFromHash(hash) {
  return normalizeKey(hash || "");
}

export function saveKey(raw) {
  const key = normalizeKey(raw);
  if (!key) return "";
  try { localStorage.setItem(KEY_LS, key); } catch { /* ignore quota / private mode */ }
  return key;
}

export function loadKey() {
  const fromHash = keyFromHash(location.hash);
  if (fromHash) {
    saveKey(fromHash);
    return fromHash;
  }
  try { return localStorage.getItem(KEY_LS) || ""; } catch { return ""; }
}

export function keepHash(key) {
  if (!key) return;
  if (keyFromHash(location.hash) === key) return;
  try { history.replaceState(null, "", `#k=${key}`); } catch { /* ignore */ }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n, fallback = "—") {
  if (n == null || Number.isNaN(Number(n))) return fallback;
  const v = Number(n);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function priceText(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1) return v.toFixed(4);
  if (v <= 0) return String(v);
  return v.toPrecision(6);
}

function pnlClass(n) {
  if (n == null) return "";
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "";
}

function showLocked(message) {
  const lock = document.getElementById("lock");
  const app = document.getElementById("app");
  if (app) app.hidden = true;
  if (lock) lock.hidden = false;
  const msg = document.getElementById("lock-msg");
  if (message && msg) msg.textContent = message;
  const err = document.getElementById("unlock-error");
  if (err && message && /does not match|Could not reach/i.test(message)) {
    err.hidden = false;
    err.textContent = message;
  }
}

function bindUnlockForm() {
  const form = document.getElementById("unlock-form");
  if (!form || form.dataset.bound) return;
  form.dataset.bound = "1";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("unlock-key");
    const err = document.getElementById("unlock-error");
    const key = saveKey(input ? input.value : "");
    if (!key) {
      if (err) { err.hidden = false; err.textContent = "Paste your unlock code first."; }
      return;
    }
    keepHash(key);
    if (err) { err.hidden = true; err.textContent = ""; }
    try {
      await refresh(key);
      if (input) input.value = "";
    } catch (exc) {
      const text = String(exc && exc.message ? exc.message : exc);
      if (err) {
        err.hidden = false;
        err.textContent = /decrypt|OperationError|AES/i.test(text)
          ? "That key does not match the data."
          : "Could not reach the desk data yet. Try again in a minute.";
      }
    }
  });
}

function showApp() {
  const lock = document.getElementById("lock");
  const app = document.getElementById("app");
  if (lock) lock.hidden = true;
  if (app) app.hidden = false;
  const input = document.getElementById("unlock-key");
  if (input) input.value = "";
}

async function fetchEnvelope() {
  const t = Date.now();
  const rawUrl = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${DATA_REF}/state.json?t=${t}`;
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/state.json?ref=${DATA_REF}&t=${t}`;
  const started = Date.now();
  const errors = [];

  // Measured: api.github.com contents is fresh in about a second.
  // raw.githubusercontent.com is cached for up to 5 minutes, even with a query string.
  try {
    const r = await fetch(apiUrl, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (r.ok) {
      const payload = await r.json();
      const text = atob((payload.content || "").replace(/\s/g, ""));
      return { envelope: JSON.parse(text), source: "api_contents", ms: Date.now() - started };
    }
    errors.push(`api ${r.status}`);
  } catch (err) {
    errors.push(`api ${err}`);
  }

  const r = await fetch(rawUrl, { cache: "no-store" });
  if (!r.ok) throw new Error(`Could not load desk data (${errors.join(", ")}, raw ${r.status})`);
  return { envelope: await r.json(), source: "raw_bust", ms: Date.now() - started };
}

const BOT_ICONS = {
  scanner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M12 5a7 7 0 0 1 7 7"/><path d="M12 2a10 10 0 0 1 10 10"/><path d="M7.5 8.2A7 7 0 0 0 12 19"/><path d="M4.2 6.5A10 10 0 0 0 12 22"/></svg>',
  analyst: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>',
  social: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 16.5V7.8A2.8 2.8 0 0 1 7.8 5h8.4A2.8 2.8 0 0 1 19 7.8v5.4A2.8 2.8 0 0 1 16.2 16H9z"/><path d="M8 19l3-3"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5c-1.2-1-3.3-.9-4.4.5A3.2 3.2 0 0 0 5 8.4c0 1.1.5 2 .7 2.3C5.2 11.2 4.5 12.3 4.5 13.6c0 1.6 1.2 3 2.8 3.1 0 1.6 1.3 2.8 3 2.8.6 0 1.2-.2 1.7-.5"/><path d="M12 4.5c1.2-1 3.3-.9 4.4.5A3.2 3.2 0 0 1 19 8.4c0 1.1-.5 2-.7 2.3.5.5 1.2 1.6 1.2 2.9 0 1.6-1.2 3-2.8 3.1 0 1.6-1.3 2.8-3 2.8-.6 0-1.2-.2-1.7-.5"/><path d="M12 5.5v16"/></svg>',
  executor: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.2 2.2 4.8 13.3h5.2l-1.4 8.5 9.2-12.2h-5.3l1.7-7.4z"/></svg>',
  risk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2 5 6.2v5.2c0 4.2 2.8 7.3 7 8.6 4.2-1.3 7-4.4 7-8.6V6.2L12 3.2z"/><path d="M9.2 12.1 11 14l3.8-4.2"/></svg>',
};

function botIcon(id, status) {
  const svg = BOT_ICONS[id] || BOT_ICONS.scanner;
  const tone = status === "running" ? "running" : (status || "idle");
  return `<span class="bot-icon ${escapeHtml(tone)}">${svg}</span>`;
}

function pctText(n) {
  if (n == null || Number.isNaN(Number(n))) return "";
  const v = Number(n);
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(1)}%`;
}

function renderHome(state) {
  const badge = document.getElementById("mode-badge");
  if (badge) {
    badge.textContent = state.mode || "PAPER";
    badge.classList.toggle("live", (state.mode || "") === "LIVE");
  }
  const equityEl = document.getElementById("equity");
  if (equityEl) {
    equityEl.textContent = state.equity_text || money(state.equity);
    equityEl.className = `equity ${pnlClass(state.total_pnl)}`;
  }
  const todayEl = document.getElementById("today-pnl");
  if (todayEl) {
    const dollar = state.today_pnl_text || money(state.today_pnl);
    const pct = state.today_pnl_pct_text || pctText(state.today_pnl_pct);
    todayEl.textContent = pct ? `Today ${dollar} (${pct})` : `Today ${dollar}`;
    todayEl.className = `today ${pnlClass(state.today_pnl)}`;
  }
  const cash = document.getElementById("paper-cash");
  if (cash) cash.textContent = state.paper_cash_text || money(state.paper_cash);
  const realized = document.getElementById("realized-pnl");
  if (realized) {
    realized.textContent = state.realized_pnl_text || money(state.realized_pnl);
    realized.className = `value ${pnlClass(state.realized_pnl)}`;
  }
  const unreal = document.getElementById("unrealized-pnl");
  if (unreal) {
    unreal.textContent = state.unrealized_pnl_text || money(state.unrealized_pnl);
    unreal.className = `value ${pnlClass(state.unrealized_pnl)}`;
  }
  const values = (state.pnl_points || []).map((p) => Number(p.value));
  drawLine(document.getElementById("chart-pnl"), values, (state.total_pnl || 0) >= 0 ? "#50c878" : "#ef5b5b");

  const screenCard = document.getElementById("screen-card");
  const img = document.getElementById("screen-img");
  const cap = document.getElementById("screen-caption");
  const screen = state.screen || {};
  if (screen.included && screen.data_url && img && screenCard) {
    screenCard.hidden = false;
    img.src = screen.data_url;
    img.alt = screen.alt || "Desk Chrome still picture.";
    if (cap) cap.textContent = screen.caption || "";
  } else if (screenCard) {
    screenCard.hidden = true;
  }

  const box = document.getElementById("positions");
  const positions = state.open_positions || [];
  if (box) {
    if (!positions.length) {
      box.innerHTML = '<p class="empty">Nothing held right now.</p>';
    } else {
      box.innerHTML = positions.map((p) => `
        <div class="hold-row">
          <div class="hold-top">
            <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.symbol || p.mint)}</a>
            <span class="${pnlClass(p.pnl_usd)}">${p.pnl_usd == null ? "—" : money(p.pnl_usd)}</span>
          </div>
          <div class="hold-meta">Entry ${p.entry == null ? "—" : priceText(p.entry)} · Now ${p.now == null ? "—" : priceText(p.now)} · Size ${p.size_usd == null ? "—" : money(p.size_usd)} · ${escapeHtml(p.age_text || "")}</div>
        </div>
      `).join("");
    }
  }

  const tradesBox = document.getElementById("home-trades");
  const trades = state.recent_trades || [];
  if (tradesBox) {
    if (!trades.length) {
      tradesBox.innerHTML = '<p class="empty">No trades yet.</p>';
    } else {
      tradesBox.innerHTML = trades.map((t) => `
        <div class="hold-row">
          <div class="hold-top">
            <div><span class="side ${(t.side || "").toLowerCase()}">${escapeHtml(t.side || "")}</span> <a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.symbol || t.mint)}</a></div>
            <span class="${pnlClass(t.pnl_usd)}">${escapeHtml(t.result || (t.pnl_usd == null ? "—" : money(t.pnl_usd)))}</span>
          </div>
          <div class="hold-meta">${escapeHtml(t.ts_text || "")}${t.reason ? " · " + escapeHtml(t.reason) : ""}</div>
        </div>
      `).join("");
    }
  }

  const homeBots = document.getElementById("home-bots");
  if (homeBots) {
    const bots = state.bots || [];
    homeBots.innerHTML = bots.map((b) => `
      <div class="bot-tile">
        <div class="bot-tile-head">
          ${botIcon(b.id, b.status)}
          <span class="name">${escapeHtml(b.label || b.id)}</span>
          <span class="pill ${escapeHtml(b.status || "idle")}">${escapeHtml(b.status || "idle")}</span>
        </div>
        <p class="action">${escapeHtml(b.current_action || "—")}</p>
        <p class="beat">${escapeHtml(b.heartbeat_age_text || "no heartbeat")}</p>
      </div>
    `).join("");
  }
}

function renderBots(state) {
  const box = document.getElementById("bots");
  if (!box) return;
  const bots = state.bots || [];
  if (!bots.length) {
    box.innerHTML = '<p class="empty">No bot status yet.</p>';
    return;
  }
  box.innerHTML = bots.map((b) => {
    const actions = (b.last_actions || []).map((a) => `<li>${escapeHtml(a.text)}${a.ts_text ? ` <span class="meta">· ${escapeHtml(a.ts_text)}</span>` : ""}</li>`).join("");
    return `
      <div class="card">
        <div class="bot-head">
          <h2>${escapeHtml(b.label || b.id)}</h2>
          <span class="pill ${escapeHtml(b.status || "idle")}">${escapeHtml(b.status || "idle")}</span>
        </div>
        <p class="meta">Heartbeat ${escapeHtml(b.heartbeat_age_text || "no heartbeat")}${b.heartbeat_text ? ` · ${escapeHtml(b.heartbeat_text)}` : ""}</p>
        <p class="action">${escapeHtml(b.current_action || "—")}</p>
        ${actions ? `<ul class="actions">${actions}</ul>` : '<p class="muted">No recent actions.</p>'}
      </div>
    `;
  }).join("");
}

function renderTrades(state) {
  const box = document.getElementById("trades");
  if (!box) return;
  const orders = state.orders || [];
  if (!orders.length) {
    box.innerHTML = '<p class="empty">No trades yet. The desk hasn\'t run a night.</p>';
    return;
  }
  box.innerHTML = orders.map((o) => `
    <div class="card trade">
      <div class="top">
        <div>
          <span class="side ${(o.side || "").toLowerCase()}">${escapeHtml(o.side || "")}</span>
          <a href="${escapeHtml(o.url)}" target="_blank" rel="noopener">${escapeHtml(o.symbol || o.mint)}</a>
        </div>
        <div class="meta">${escapeHtml(o.ts_text || "")}</div>
      </div>
      <div class="kv">
        <span>Size ${o.size == null ? "—" : money(o.size)}</span>
        <span>Price ${priceText(o.price)}</span>
        <span>Fee ${o.fee == null ? escapeHtml(o.fee_text || "—") : money(o.fee)}</span>
        <span class="${pnlClass(o.pnl_usd)}">P&amp;L ${o.pnl_usd == null ? "—" : money(o.pnl_usd)}</span>
      </div>
      <p class="meta">${escapeHtml(o.reason || o.status || "")}</p>
    </div>
  `).join("");
}

function renderList(id, rows, empty, line) {
  const box = document.getElementById(id);
  if (!box) return;
  if (!rows || !rows.length) {
    box.innerHTML = `<p class="empty">${empty}</p>`;
    return;
  }
  box.innerHTML = rows.map(line).join("");
}

function renderActivity(state) {
  renderList("scans", state.scans, "No scans yet.", (s) => `
    <div class="row">
      <div>
        <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.symbol || s.mint)}</a>
        <div class="meta">${escapeHtml(s.ts_text || "")}</div>
      </div>
      <div class="right">
        <div class="${(s.verdict || "") === "pass" ? "pos" : "neg"}">${escapeHtml(s.verdict || "")}</div>
        <div class="meta">${escapeHtml(s.reason || "")}</div>
      </div>
    </div>
  `);
  renderList("audits", state.audits, "No audits yet.", (a) => `
    <div class="row">
      <div>
        <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.symbol || a.mint)}</a>
        <div class="meta">Layer ${escapeHtml(a.layer)} · ${escapeHtml(a.name || "")}</div>
      </div>
      <div class="right">
        <div class="${a.pass ? "pos" : "neg"}">${a.pass ? "pass" : "fail"}</div>
        <div class="meta">${escapeHtml(a.value_text || a.ts_text || "")}</div>
      </div>
    </div>
  `);
  renderList("scores", state.scores, "No scores yet.", (s) => `
    <div class="row">
      <div>
        <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.symbol || s.mint)}</a>
        <div class="meta">${escapeHtml(s.ts_text || "")}</div>
      </div>
      <div class="right">
        <div class="${s.pass ? "pos" : "neg"}">${s.score == null ? "—" : Number(s.score).toFixed(0)}</div>
        <div class="meta">${escapeHtml(s.reason || "")}</div>
      </div>
    </div>
  `);
}

function renderAccount(state) {
  const account = state.account || {};
  const handle = document.getElementById("account-handle");
  if (handle) {
    const name = account.handle || "antevy";
    const url = account.profile_url || "";
    handle.innerHTML = url
      ? `FOMO <a href="${escapeHtml(url)}" target="_blank" rel="noopener">@${escapeHtml(name)}</a>`
      : `FOMO @${escapeHtml(name)}`;
  }
  const note = document.getElementById("account-note");
  if (note && account.fomo_balances_note) {
    note.textContent = `Read-only. Nothing changes unless you approve it. ${account.fomo_balances_note}`;
  }
  const list = document.getElementById("settings-list");
  if (!list) return;
  const groups = state.settings_groups || [];
  if (!groups.length) {
    list.innerHTML = '<p class="empty">No settings to show.</p>';
    return;
  }
  list.innerHTML = groups.map((g) => `
    <div class="card">
      <h2>${escapeHtml(g.name || g.label || "Settings")}</h2>
      <table class="settings">
        <thead><tr><th>Setting</th><th>Now</th><th>Default</th></tr></thead>
        <tbody>
          ${(g.items || g.rows || []).map((r) => `
            <tr>
              <th>${escapeHtml(r.label || r.key)}</th>
              <td>${escapeHtml(r.value || r.display || r.current || "")}</td>
              <td>${escapeHtml(r.default || r.default_display || "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `).join("");
}

function render(state, meta) {
  showApp();
  const fresh = document.getElementById("fresh");
  if (fresh) {
    const when = state.published_at_text || state.generated_at_text || "";
    const lag = state.generated_at ? Math.max(0, Math.round((Date.now() / 1000) - Number(state.generated_at))) : null;
    const lagText = lag == null ? "" : lag < 60 ? `${lag}s old` : `${Math.round(lag / 60)}m old`;
    fresh.textContent = [when, lagText, meta && meta.source ? `via ${meta.source}` : ""].filter(Boolean).join(" · ");
  }
  renderHome(state);
  renderBots(state);
  renderTrades(state);
  renderActivity(state);
  renderAccount(state);
}

export async function refresh(key) {
  const k = key || loadKey();
  if (!k) {
    showLocked("Open your private link to view it. Without the key, nothing is shown.");
    return null;
  }
  const { envelope, source, ms } = await fetchEnvelope();
  const state = await decryptEnvelope(envelope, k);
  render(state, { source, ms });
  return state;
}

function bindNav() {
  document.querySelectorAll(".nav button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-page");
      document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b === btn));
      document.querySelectorAll("main .page").forEach((p) => p.classList.toggle("on", p.id === `page-${id}`));
    });
  });
}

async function boot() {
  bindNav();
  bindUnlockForm();
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch { /* offline / file */ }
  }
  const key = loadKey();
  if (!key) {
    showLocked("Open your private link, or paste your unlock code below. Without the key, nothing is shown.");
    return;
  }
  keepHash(key);
  try {
    await refresh(key);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/decrypt|OperationError|jwk|AES/i.test(msg)) {
      showLocked("This link's key does not match the data.");
    } else {
      showLocked("Could not reach the desk data yet. Try again in a minute.");
    }
    return;
  }
  setInterval(() => {
    refresh(loadKey()).catch(() => {});
  }, POLL_MS);
}

if (!import.meta.url.endsWith("?test")) {
  boot();
}
