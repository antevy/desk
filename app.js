import { drawLine, drawEquity, drawSpark } from "./chart.js";

const OWNER = "antevy";
const REPO = "desk";
const DATA_REF = "data";
const KEY_LS = "desk.app.k";
const ATH_LS = "desk.app.ath";
// 60s matches app_publish.PUBLISH_INTERVAL_S. The watch app reads state via
// unauthenticated api.github.com (60 req/hour), so 20s would trip the rate limit.
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

export function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function encryptEnvelope(obj, keyB64) {
  const key = await crypto.subtle.importKey("raw", b64urlToBytes(keyB64), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  return { v: 1, alg: "A256GCM", iv: bytesToB64url(iv), ct: bytesToB64url(ct), ts: Math.floor(Date.now() / 1000) };
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
  if (v >= 0.0001) return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return v.toExponential(2).replace("e+", "e").replace("e-0", "e-");
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
      headers: { Accept: "application/vnd.github+json", "Cache-Control": "no-store" },
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

const BOT_COLORS = {
  scanner: "#3b82f6",
  analyst: "#22d3ee",
  social: "#38bdf8",
  brain: "#a855f7",
  executor: "#00e87a",
  risk: "#f43f5e",
};

const CURSOR_SVG = '<svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true"><path d="M1 1l10 9.2-4.2.2 2.2 4.4-2.2 1.2-2.3-4.5-3.5 3.2z" fill="currentColor" stroke="#fff" stroke-width="0.7" stroke-linejoin="round"/></svg>';

function botIcon(id, status) {
  const svg = BOT_ICONS[id] || BOT_ICONS.scanner;
  const tone = status === "running" ? "running" : (status || "idle");
  return `<span class="bot-icon ${escapeHtml(tone)}">${svg}</span>`;
}

function botIco(id) {
  const safe = BOT_COLORS[id] ? id : "scanner";
  const cls = escapeHtml(safe);
  return `<span class="bot-ico ${cls}"><picture><source type="image/webp" srcset="./icons/bot-${cls}-96.webp 96w, ./icons/bot-${cls}-192.webp 192w" sizes="36px"><img src="./icons/bot-${cls}-192.png" srcset="./icons/bot-${cls}-96.png 96w, ./icons/bot-${cls}-192.png 192w" sizes="36px" width="36" height="36" alt=""></picture></span>`;
}

function pctText(n) {
  if (n == null || Number.isNaN(Number(n))) return "";
  const v = Number(n);
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(1)}%`;
}

function tickText(el, nextText, numeric, format) {
  if (!el) return;
  if (numeric == null || Number.isNaN(Number(numeric))) {
    el.textContent = nextText;
    el._num = null;
    return;
  }
  const target = Number(numeric);
  const prev = el._num;
  if (prev == null || prev === target) {
    el.textContent = nextText;
    el._num = target;
    return;
  }
  const startVal = prev;
  const t0 = performance.now();
  const dur = 550;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - (1 - p) ** 3;
    const cur = startVal + (target - startVal) * eased;
    el.textContent = format(cur);
    if (p < 1) requestAnimationFrame(step);
    else {
      el.textContent = nextText;
      el._num = target;
    }
  };
  requestAnimationFrame(step);
  el._num = target;
}

let homeTf = "live";
let acctTf = "24h";
let seenFeedIds = new Set();
let feedReady = false;

function showPage(id) {
  document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-page") === id));
  document.querySelectorAll("main .page").forEach((p) => p.classList.toggle("on", p.id === `page-${id}`));
  syncFlyCursors();
}

function bindNav() {
  document.querySelectorAll(".nav button").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.getAttribute("data-page")));
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.getAttribute("data-goto")));
  });
  document.getElementById("tf-pills")?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-tf]");
    if (!btn) return;
    homeTf = btn.getAttribute("data-tf");
    document.querySelectorAll("#tf-pills button").forEach((b) => b.classList.toggle("on", b === btn));
    if (window.__deskState) paintHomeChart(window.__deskState);
  });
  document.getElementById("acct-tf")?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-tf]");
    if (!btn) return;
    acctTf = btn.getAttribute("data-tf");
    document.querySelectorAll("#acct-tf button").forEach((b) => b.classList.toggle("on", b === btn));
    if (window.__deskState) paintAcctChart(window.__deskState);
  });
}

function paintHomeChart(state) {
  const curves = state.equity_curves || {};
  const key = homeTf === "live" ? "live" : homeTf;
  const points = curves[key] || curves.live || (state.pnl_points || []).map((p, i) => ({ t: i, v: p.value }));
  const first = points[0]?.v;
  const last = points[points.length - 1]?.v;
  const color = last == null || first == null || last >= first ? "#00e87a" : "#ff4d55";
  drawEquity(document.getElementById("chart-pnl"), points, {
    color,
    markers: state.chart_markers || [],
    animate: true,
    tf: key,
  });
}

function paintAcctChart(state) {
  const curves = state.equity_curves || {};
  const key = acctTf;
  const points = curves[key] || curves.all || [];
  const first = points[0]?.v;
  const last = points[points.length - 1]?.v;
  const color = last == null || first == null || last >= first ? "#00e87a" : "#ff4d55";
  drawEquity(document.getElementById("chart-acct"), points, { color, markers: state.chart_markers || [], animate: true, tf: `acct-${key}` });
}

function paintMiniScreen(state) {
  const frame = document.getElementById("screen-frame");
  const img = document.getElementById("screen-img");
  const canvas = document.getElementById("screen-mini");
  const tag = document.getElementById("acting-tag");
  const cap = document.getElementById("screen-caption");
  const screen = state.screen || {};
  const acting = state.acting || {};
  if (tag) tag.textContent = acting.tag || acting.action || "Desk · watching";

  const last = state.last_action || {};
  if (cap) {
    const text = last.text || "Watching · no trades yet · PAPER";
    cap.innerHTML = escapeHtml(text).replace("verified ✓", '<span class="ok">verified ✓</span>');
  }

  if (liveFrameFresh() && img && img.getAttribute("src")) {
    if (frame) frame.classList.add("has-shot");
    if (img) img.hidden = false;
    if (tag) tag.hidden = false;
    return;
  }
  const allowedShot = !!(screen.included && screen.data_url && (screen.page_kind == null || screen.page_kind === "coin"));
  if (tag) tag.hidden = !allowedShot;
  if (allowedShot) {
    if (frame) frame.classList.add("has-shot");
    if (img) {
      img.hidden = false;
      img.src = screen.data_url;
      img.alt = screen.alt || "Still picture of the desk on a FOMO coin page.";
    }
    return;
  }
  if (frame) frame.classList.remove("has-shot");
  if (img) {
    img.hidden = true;
    img.removeAttribute("src");
  }
  drawMini(canvas, state);
}

function drawMini(canvas, state) {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 358;
  const cssH = canvas.clientHeight || 168;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = "#07070a";
  ctx.fillRect(0, 0, w, h);

  // Left pane: real sparkline if we have prices. Never invent a path.
  const focus = state.focus || {};
  const spark = Array.isArray(focus.sparkline) ? focus.sparkline.map(Number).filter(Number.isFinite) : [];
  const paneW = Math.round(w * 0.68);
  ctx.fillStyle = "#0b0d14";
  ctx.fillRect(0, 0, paneW, h);

  // faint grid
  ctx.strokeStyle = "#181b24";
  ctx.lineWidth = dpr;
  for (let i = 1; i < 4; i += 1) {
    const y = (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(paneW, y); ctx.stroke();
  }

  if (spark.length >= 2) {
    const min = Math.min(...spark), max = Math.max(...spark);
    const span = max - min || 1;
    const up = spark[spark.length - 1] >= spark[0];
    const padX = 10 * dpr, padY = 28 * dpr;
    ctx.beginPath();
    spark.forEach((v, i) => {
      const x = padX + (i / (spark.length - 1)) * (paneW - padX * 2);
      const y = h - padY - ((v - min) / span) * (h - padY * 1.4 - 8 * dpr);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = up ? "#00e87a" : "#ff4d55";
    ctx.lineWidth = 1.8 * dpr;
    ctx.stroke();
  } else {
    ctx.fillStyle = "#636366";
    ctx.font = `500 ${11 * dpr}px -apple-system, sans-serif`;
    ctx.fillText("No price yet", 14 * dpr, h / 2);
  }

  const fs = 11 * dpr;
  ctx.font = `700 ${13 * dpr}px -apple-system, sans-serif`;
  ctx.fillStyle = "#f5f5f7";
  const sym = focus.symbol || "";
  ctx.fillText(sym, 12 * dpr, 18 * dpr);
  if (focus.last_price != null) {
    ctx.font = `600 ${11 * dpr}px -apple-system, sans-serif`;
    ctx.fillStyle = "#8e8e93";
    ctx.fillText(priceText(focus.last_price), 12 * dpr + ctx.measureText(sym + "  ").width, 18 * dpr);
  }

  // Right pane: current desk action. No fake trade tickets.
  ctx.fillStyle = "#0e1018";
  ctx.fillRect(paneW, 0, w - paneW, h);
  ctx.fillStyle = "#f5f5f7";
  ctx.font = `700 ${10 * dpr}px -apple-system, sans-serif`;
  const acting = state.acting || {};
  const lines = String(acting.tag || acting.action || "watching").split(" · ");
  let y = 22 * dpr;
  lines.forEach((ln) => {
    ctx.fillText(ln, paneW + 10 * dpr, y);
    y += 14 * dpr;
  });
  ctx.fillStyle = "#00e87a";
  ctx.font = `600 ${9 * dpr}px -apple-system, sans-serif`;
  ctx.fillText(state.mode || "PAPER", paneW + 10 * dpr, h - 12 * dpr);
}

const FLY_BOTS = [
  { id: "scanner", target: "#screen-frame" },
  { id: "analyst", target: "#home-bots" },
  { id: "social", target: "#home-feed" },
  { id: "brain", target: "#chart-pnl" },
  { id: "executor", target: "#equity" },
  { id: "risk", target: "#today-pnl" },
];

const fly = {
  raf: 0,
  phases: null,
  lastTradeSig: "",
  reduce: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
};

function homeCursorsAllowed() {
  if (fly.reduce) return false;
  if (document.visibilityState !== "visible") return false;
  const page = document.getElementById("page-home");
  if (!page || !page.classList.contains("on")) return false;
  const app = document.getElementById("app");
  if (app && app.hidden) return false;
  return true;
}

function ensureFlyLayer() {
  const layer = document.getElementById("bot-cursors");
  if (!layer) return null;
  if (!layer.querySelector(".fly-cursor")) {
    layer.innerHTML = FLY_BOTS.map((b) => {
      const color = BOT_COLORS[b.id] || "#8e8e93";
      return `<div class="fly-cursor" data-bot="${b.id}" style="color:${color}">${CURSOR_SVG}</div>`;
    }).join("");
  }
  return layer;
}

function flyTargetPoint(sel, host) {
  const el = document.querySelector(sel);
  if (!el || !host) return null;
  const a = el.getBoundingClientRect();
  const b = host.getBoundingClientRect();
  return {
    x: a.left - b.left + a.width * (0.3 + Math.random() * 0.4),
    y: a.top - b.top + a.height * (0.3 + Math.random() * 0.4),
  };
}

function flyWander(t, i, w, h) {
  const p = i * 1.17;
  const nx = 0.5 + 0.42 * Math.sin(t * (0.23 + i * 0.031) + p) * Math.cos(t * (0.11 + i * 0.017) + p * 0.7);
  const ny = 0.5 + 0.40 * Math.sin(t * (0.19 + i * 0.027) + p * 1.3) * Math.cos(t * (0.09 + i * 0.013));
  const pad = 8;
  return {
    x: pad + nx * Math.max(0, w - 22 - pad),
    y: pad + ny * Math.max(0, h - 24 - pad),
  };
}

function spawnRipple(layer, x, y, color) {
  const el = document.createElement("span");
  el.className = "cursor-ripple";
  el.style.color = color;
  el.style.setProperty("--x", `${x}px`);
  el.style.setProperty("--y", `${y}px`);
  layer.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}

function forceFlyClick(id) {
  if (!fly.phases) return;
  const i = FLY_BOTS.findIndex((b) => b.id === id);
  if (i < 0) return;
  fly.phases[i].nextClick = 0;
}

function startFlyCursors() {
  if (fly.raf || fly.reduce) return;
  const layer = ensureFlyLayer();
  const host = document.getElementById("page-home");
  if (!layer || !host) return;
  const nodes = [...layer.querySelectorAll(".fly-cursor")];
  if (!fly.phases) {
    const now = performance.now();
    fly.phases = FLY_BOTS.map((_, i) => ({
      nextClick: now + 1800 + i * 1600 + Math.random() * 1200,
      mode: "wander",
      seekUntil: 0,
      sx: 0, sy: 0, tx: 0, ty: 0,
    }));
  }
  const tick = (now) => {
    fly.raf = 0;
    if (!homeCursorsAllowed()) return;
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const t = now / 1000;
    nodes.forEach((node, i) => {
      const st = fly.phases[i];
      let x;
      let y;
      if (st.mode === "seek" && now < st.seekUntil) {
        const u = Math.min(1, 1 - (st.seekUntil - now) / 700);
        const e = 1 - (1 - u) ** 3;
        x = st.sx + (st.tx - st.sx) * e;
        y = st.sy + (st.ty - st.sy) * e;
        if (u >= 1) {
          spawnRipple(layer, st.tx, st.ty, BOT_COLORS[FLY_BOTS[i].id] || "#8e8e93");
          st.mode = "wander";
          st.nextClick = now + 8000 + Math.random() * 6000;
        }
      } else {
        const p = flyWander(t, i, w, h);
        x = p.x;
        y = p.y;
        if (now >= st.nextClick) {
          const tgt = flyTargetPoint(FLY_BOTS[i].target, host);
          if (tgt) {
            st.mode = "seek";
            st.sx = x;
            st.sy = y;
            st.tx = tgt.x;
            st.ty = tgt.y;
            st.seekUntil = now + 700;
          } else {
            st.nextClick = now + 4000;
          }
        }
      }
      node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });
    fly.raf = requestAnimationFrame(tick);
  };
  fly.raf = requestAnimationFrame(tick);
}

function stopFlyCursors() {
  if (fly.raf) cancelAnimationFrame(fly.raf);
  fly.raf = 0;
}

function syncFlyCursors() {
  if (homeCursorsAllowed()) startFlyCursors();
  else stopFlyCursors();
}

function maybeTradeClick(state) {
  const orders = state && state.orders ? state.orders : [];
  if (!orders.length) return;
  const last = orders[0];
  const sig = String(last.id || `${last.ts || ""}|${last.symbol || ""}|${last.side || ""}`);
  if (!fly.lastTradeSig) {
    fly.lastTradeSig = sig;
    return;
  }
  if (sig === fly.lastTradeSig) return;
  fly.lastTradeSig = sig;
  forceFlyClick("executor");
}

function botRow(b, { detailed = false } = {}) {
  const metric = b.metric_text || "";
  const metricClass = /blocked/i.test(metric) ? "blocked" : "";
  const actions = detailed
    ? (b.last_actions || []).slice(0, 3).map((a) => {
        const ts = (a.ts_text || "").replace(/^[A-Za-z]{3} [A-Za-z]{3} \d+, \d+, /, "").replace(/:(\d{2}) (?=[AP]M)/, " ");
        return `<li>${escapeHtml(a.text)}${ts ? ` <span class="meta">· ${escapeHtml(ts)}</span>` : ""}</li>`;
      }).join("")
    : "";
  return `
    <div class="bot-row" data-bot="${escapeHtml(b.id || "")}">
      ${botIco(b.id)}
      <div class="bot-mid">
        <span class="name">${escapeHtml(b.label || b.id)}</span>
        <p class="action">${escapeHtml(b.current_action || "—")}</p>
      </div>
      <div class="bot-right ${metricClass}">${escapeHtml(metric)}</div>
      ${actions ? `<ul class="actions">${actions}</ul>` : ""}
    </div>
  `;
}

const FEED_ICONS = {
  buy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
  reentry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
  sell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>',
  reject: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M8 12.5l2.5 2.5 5-5.5"/></svg>',
  status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 5v2M12 17v2M5 12h2M17 12h2"/></svg>',
};

function feedRow(item, { animate = false } = {}) {
  const tone = item.tone || "muted";
  const typ = item.type || "check";
  const icon = FEED_ICONS[typ] || FEED_ICONS.check;
  const title = item.title || "";
  const href = item.url || "";
  const titleHtml = href
    ? `<a class="title ${escapeHtml(tone)}" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
    : `<span class="title ${escapeHtml(tone)}">${escapeHtml(title)}</span>`;
  const amt = item.amount_text || "";
  const pnl = item.pnl_text || (item.pnl_usd != null ? money(item.pnl_usd) : "");
  const pnlClassName = pnlClass(item.pnl_usd != null ? item.pnl_usd : (item.pnl_pct != null ? item.pnl_pct : 0));
  return `
    <div class="feed-row${animate ? " in" : ""}" data-id="${escapeHtml(item.id || "")}">
      <span class="feed-ico ${escapeHtml(tone)}">${icon}</span>
      <div class="feed-mid">
        ${titleHtml}
        <p class="sub">${escapeHtml(item.subtitle || "")}</p>
      </div>
      <div class="feed-right">
        <span class="amt ${tone === "good" || typ === "buy" || typ === "reentry" ? "pos" : tone === "bad" ? "neg" : ""}">${escapeHtml(amt)}</span>
        ${pnl ? `<span class="pnl ${pnlClassName}">${escapeHtml(pnl)}</span>` : ""}
      </div>
    </div>
  `;
}

function renderFeed(id, items, { limit } = {}) {
  const box = document.getElementById(id);
  if (!box) return;
  const rows = limit ? items.slice(0, limit) : items;
  if (!rows.length) {
    box.innerHTML = '<p class="empty">No desk activity yet.</p>';
    return;
  }
  const html = rows.map((it) => feedRow(it, { animate: feedReady && !seenFeedIds.has(it.id) })).join("");
  box.innerHTML = html;
}

function renderBotsList(id, bots, opts) {
  const box = document.getElementById(id);
  if (!box) return;
  if (!bots.length) {
    box.innerHTML = '<p class="empty">No bot status yet.</p>';
    return;
  }
  box.innerHTML = bots.map((b) => botRow(b, opts)).join("");
}

function renderHome(state) {
  const badge = document.getElementById("mode-badge");
  if (badge) {
    badge.textContent = state.mode || "PAPER";
    badge.classList.toggle("live", (state.mode || "") === "LIVE");
  }
  const openEl = document.getElementById("open-count");
  if (openEl) {
    const n = state.open_count ?? (state.open_positions || []).length;
    openEl.textContent = `${n} open`;
  }
  const equityEl = document.getElementById("equity");
  tickText(equityEl, state.equity_text || money(state.equity), state.equity, (v) => money(v));

  const todayEl = document.getElementById("today-pnl");
  if (todayEl) {
    const dollar = state.today_pnl_text || money(state.today_pnl);
    const pct = state.today_pnl_pct_text || pctText(state.today_pnl_pct);
    const arrow = (state.today_pnl || 0) > 0 ? "▲ " : (state.today_pnl || 0) < 0 ? "▼ " : "";
    todayEl.textContent = pct ? `${arrow}${dollar} (${pct})` : `${arrow}${dollar}`;
    todayEl.className = `today ${pnlClass(state.today_pnl)}`;
  }
  const multEl = document.getElementById("equity-mult");
  if (multEl) {
    const m = state.equity_mult_text || "1.00x";
    multEl.textContent = m;
    multEl.classList.toggle("down", Number(state.equity_mult || 1) < 1);
  }

  paintHomeChart(state);
  paintMiniScreen(state);

  const running = state.running_count ?? (state.bots || []).filter((b) => b.status === "running").length;
  const runText = `${running} running`;
  const runA = document.getElementById("bots-running");
  const runB = document.getElementById("bots-running-page");
  if (runA) runA.textContent = runText;
  if (runB) runB.textContent = runText;

  renderBotsList("home-bots", state.bots || []);
  renderFeed("home-feed", state.feed || [], { limit: 6 });
}

function renderBots(state) {
  renderBotsList("bots", state.bots || [], { detailed: true });
}

function renderTrades(state) {
  const box = document.getElementById("trades");
  if (!box) return;
  const orders = state.orders || [];
  if (!orders.length) {
    box.innerHTML = '<p class="empty">No trades yet. The desk hasn\'t placed a paper order.</p>';
    return;
  }
  box.innerHTML = orders.map((o) => `
    <div class="trade">
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
      <p class="meta">${[o.source, o.reason || o.status || ""].filter(Boolean).map(escapeHtml).join(" · ")}</p>
    </div>
  `).join("");
}

function renderActivity(state) {
  renderFeed("feed", state.feed || []);
  renderTrades(state);
}

function holdRow(p) {
  return `
    <div class="hold-row">
      <div class="hold-top">
        <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.symbol || p.mint)}</a>
        <span class="${pnlClass(p.pnl_usd)}">${p.pnl_usd == null ? "—" : money(p.pnl_usd)}</span>
      </div>
      <div class="hold-meta">${[
        p.entry == null ? null : `Entry ${priceText(p.entry)}`,
        p.now == null ? null : `Now ${priceText(p.now)}`,
        p.size_usd == null ? null : `Size ${money(p.size_usd)}`,
        p.age_text || p.hold_text || "",
        p.exit_reason || "",
      ].filter(Boolean).map(escapeHtml).join(" · ")}</div>
    </div>
  `;
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
  if (note) {
    const extra = account.fomo_balances_note ? ` ${account.fomo_balances_note}` : "";
    note.textContent = `Read-only. Nothing changes unless you approve it.${extra}`;
  }
  const eq = document.getElementById("acct-equity");
  tickText(eq, state.equity_text || money(state.equity), state.equity, (v) => money(v));
  const todayEl = document.getElementById("acct-today");
  if (todayEl) {
    const dollar = state.today_pnl_text || money(state.today_pnl);
    const pct = state.today_pnl_pct_text || pctText(state.today_pnl_pct);
    const arrow = (state.today_pnl || 0) > 0 ? "▲ " : (state.today_pnl || 0) < 0 ? "▼ " : "";
    todayEl.textContent = pct ? `${arrow}${dollar} (${pct})` : `${arrow}${dollar}`;
    todayEl.className = `today ${pnlClass(state.today_pnl)}`;
  }
  const multEl = document.getElementById("acct-mult");
  if (multEl) {
    multEl.textContent = state.equity_mult_text || "1.00x";
    multEl.classList.toggle("down", Number(state.equity_mult || 1) < 1);
  }
  paintAcctChart(state);
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
  const tc = document.getElementById("trade-count");
  if (tc) tc.textContent = String(state.trade_count ?? 0);
  const ah = document.getElementById("avg-hold");
  if (ah) ah.textContent = state.avg_hold_text || "—";
  const cc = document.getElementById("closed-count");
  if (cc) cc.textContent = String(state.closed_count ?? 0);
  const openN = document.getElementById("acct-open-n");
  if (openN) {
    const n = state.open_count ?? (state.open_positions || []).length;
    openN.textContent = String(n);
  }

  const box = document.getElementById("positions");
  const positions = state.open_positions || [];
  if (box) {
    box.innerHTML = positions.length
      ? positions.map(holdRow).join("")
      : '<p class="empty">Nothing held right now.</p>';
  }
  const closedBox = document.getElementById("closed-positions");
  const closed = state.closed_positions || [];
  if (closedBox) {
    closedBox.innerHTML = closed.length
      ? closed.map(holdRow).join("")
      : '<p class="empty">No closed positions.</p>';
  }

  const list = document.getElementById("settings-list");
  if (list) {
    const groups = state.settings_groups || [];
    if (!groups.length) {
      list.innerHTML = '<p class="empty">No settings to show.</p>';
    } else {
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
  }
}

function maybeConfetti(state) {
  const equity = Number(state.equity || 0);
  const serverAth = Number(state.equity_ath || equity);
  let prev;
  try { prev = parseFloat(localStorage.getItem(ATH_LS) || ""); } catch { prev = NaN; }
  if (!Number.isFinite(prev)) {
    try { localStorage.setItem(ATH_LS, String(Math.max(serverAth, equity))); } catch { /* ignore */ }
    return;
  }
  const recentSell = (state.feed || state.recent_trades || []).some((t) => {
    const typ = (t.type || t.side || "").toLowerCase();
    return (typ === "sell" || typ === "stop") && (Date.now() / 1000 - Number(t.ts || 0) < 600);
  });
  if (recentSell && equity > prev + 1e-9) {
    fireConfetti();
    try { localStorage.setItem(ATH_LS, String(equity)); } catch { /* ignore */ }
  } else if (serverAth > prev) {
    try { localStorage.setItem(ATH_LS, String(serverAth)); } catch { /* ignore */ }
  }
}

function fireConfetti() {
  const c = document.getElementById("confetti");
  if (!c) return;
  c.hidden = false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.round(window.innerWidth * dpr);
  c.height = Math.round(window.innerHeight * dpr);
  const ctx = c.getContext("2d");
  const colors = ["#00e87a", "#3b82f6", "#facc15", "#a855f7", "#22d3ee", "#ff4d55"];
  const bits = Array.from({ length: 80 }, () => ({
    x: Math.random() * c.width,
    y: -Math.random() * c.height * 0.3,
    r: 3 + Math.random() * 5 * dpr,
    vx: (Math.random() - 0.5) * 3 * dpr,
    vy: 2 * dpr + Math.random() * 3 * dpr,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.2,
  }));
  const t0 = performance.now();
  const step = (now) => {
    ctx.clearRect(0, 0, c.width, c.height);
    bits.forEach((b) => {
      b.x += b.vx; b.y += b.vy; b.rot += b.vr; b.vy += 0.04 * dpr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.r, -b.r / 2, b.r * 2, b.r);
      ctx.restore();
    });
    if (now - t0 < 2200) requestAnimationFrame(step);
    else {
      ctx.clearRect(0, 0, c.width, c.height);
      c.hidden = true;
    }
  };
  requestAnimationFrame(step);
}


function snapshotAgeS(state) {
  if (!state || !state.generated_at) return null;
  return Math.max(0, Math.round((Date.now() / 1000) - Number(state.generated_at)));
}

function updateFresh(state) {
  if (!state) return;
  const lag = snapshotAgeS(state);
  const live = lag != null && lag <= 180;
  const badge = document.getElementById("live-badge");
  if (badge) badge.classList.toggle("stale", !live);
  const fresh = document.getElementById("fresh");
  if (fresh) {
    const lagText = lag == null ? "" : lag < 60 ? `${lag}s old` : `${Math.round(lag / 60)}m old`;
    fresh.textContent = lagText || state.published_at_text || "";
  }
}

function updateReplayLag(ev, state) {
  const el = document.getElementById("replay-lag");
  if (!el) return;
  if (liveMode === "live" && liveFrameFresh()) return;
  const src = ev && ev.ts != null ? Number(ev.ts) : Number((state && (state.tape && state.tape.generated_at)) || (state && state.generated_at) || 0);
  if (!src) {
    el.textContent = "";
    return;
  }
  const behind = Math.max(0, Math.round(Date.now() / 1000 - src));
  el.textContent = ev ? `replaying · ${behind}s behind` : `waiting · ${behind}s behind`;
}

let tapeTimer = null;
let typingTimer = null;
const playedTapeIds = new Set();
let replayEvent = null;

function stopTape() {
  if (tapeTimer) {
    clearInterval(tapeTimer);
    tapeTimer = null;
  }
}

function setCaption(text, { type = false } = {}) {
  const cap = document.getElementById("screen-caption");
  if (!cap) return;
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }
  const paint = (s) => escapeHtml(s).replace("verified ✓", '<span class="ok">verified ✓</span>');
  if (!type) {
    cap.innerHTML = paint(text);
    return;
  }
  let i = 0;
  cap.innerHTML = '<span class="caret"></span>';
  typingTimer = setInterval(() => {
    i += 1;
    cap.innerHTML = paint(text.slice(0, i)) + (i >= text.length ? "" : '<span class="caret"></span>');
    if (i >= text.length) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  }, 16);
}

function movePointer(ev, spark) {
  const el = document.getElementById("ls-pointer");
  const frame = document.getElementById("screen-frame");
  if (!el || !frame) return;
  el.hidden = false;
  if (!el.innerHTML) el.innerHTML = CURSOR_SVG;
  const w = frame.clientWidth || 358;
  const h = frame.clientHeight || 168;
  const vals = Array.isArray(spark && spark.sparkline)
    ? spark.sparkline.map(Number).filter(Number.isFinite)
    : [];
  // Sit on the last real price when we have one; otherwise mid-chart.
  let yFrac = 0.5;
  if (vals.length >= 2) {
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const last = vals[vals.length - 1];
    yFrac = max === min ? 0.5 : 0.78 - ((last - min) / (max - min)) * 0.55;
  }
  const x = vals.length >= 2 ? Math.round(w * 0.60) : Math.round(w * 0.36);
  el.style.left = `${x}px`;
  el.style.top = `${Math.round(h * yFrac)}px`;
}

function tapeFeedBase(state) {
  const tapeIds = new Set(((state.tape || {}).events || []).map((e) => e.id).filter(Boolean));
  return (state.feed || []).filter((it) => !it.id || !tapeIds.has(it.id) || playedTapeIds.has(it.id));
}

function insertFeedEvent(ev) {
  if (!ev || !ev.id) return;
  const row = feedRow(ev, { animate: true });
  for (const id of ["home-feed", "feed"]) {
    const box = document.getElementById(id);
    if (!box) continue;
    const empty = box.querySelector(".empty");
    if (empty) empty.remove();
    if (box.querySelector(`[data-id="${CSS.escape(ev.id)}"]`)) continue;
    box.insertAdjacentHTML("afterbegin", row);
    if (id === "home-feed") {
      const rows = box.querySelectorAll(".feed-row");
      if (rows.length > 6) {
        for (let i = 6; i < rows.length; i += 1) rows[i].remove();
      }
    }
  }
}

function updateBotAction(ev) {
  if (!ev || !ev.bot) return;
  const text = ev.action || ev.title || "";
  document.querySelectorAll(`.bot-row[data-bot="${CSS.escape(ev.bot)}"] .action`).forEach((p) => {
    p.textContent = text;
  });
}

function applyTapeEvent(state, ev) {
  const sparks = (state.tape && state.tape.sparks) || {};
  const spark = ev.mint && sparks[ev.mint] ? sparks[ev.mint] : {};
  const label = ev.bot ? (ev.bot.charAt(0).toUpperCase() + ev.bot.slice(1)) : "Desk";
  const action = ev.action || ev.title || "watching";
  const view = {
    ...state,
    focus: {
      mint: ev.mint || "",
      symbol: ev.symbol || spark.symbol || "",
      sparkline: spark.sparkline || [],
      last_price: spark.last_price != null ? spark.last_price : null,
      url: ev.url || "",
      action,
    },
    acting: {
      id: ev.bot || "scanner",
      label,
      action,
      tag: `${label} · ${action}`,
    },
    last_action: {
      text: [ev.title, ev.reason, ev.ts_clock || ev.ts_text, state.mode || "PAPER"].filter(Boolean).join(" · "),
      verified: ev.type === "buy" || ev.type === "sell" || ev.type === "reentry",
    },
  };
  replayEvent = ev;
  // Replay uses the moving mini-screen, not a frozen still.
  const screen = view.screen || {};
  view.screen = { ...screen, included: false, data_url: null };
  const tag = document.getElementById("acting-tag");
  if (tag) {
    tag.hidden = false;
    tag.textContent = view.acting.tag;
  }
  paintMiniScreen(view);
  setCaption(view.last_action.text, { type: true });
  movePointer(ev, spark);
  insertFeedEvent(ev);
  updateBotAction(ev);
  updateReplayLag(ev, state);
  playedTapeIds.add(ev.id);
}

function startTape(state) {
  stopTape();
  const events = (((state.tape || {}).events) || []).slice().sort((a, b) => {
    const dt = Number(a.ts || 0) - Number(b.ts || 0);
    if (dt !== 0) return dt;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  const pending = events.filter((e) => e && e.id && !playedTapeIds.has(e.id));
  const base = tapeFeedBase(state);
  renderFeed("home-feed", base, { limit: 6 });
  renderFeed("feed", base);
  if (!pending.length) {
    let replayEvent = null;
    const ptr = document.getElementById("ls-pointer");
    if (ptr && !(state.tape && (state.tape.events || []).length)) ptr.hidden = true;
    updateReplayLag(null, state);
    return;
  }
  const budget = Math.max(28_000, POLL_MS - 10_000);
  const gap = Math.min(4000, Math.max(2000, Math.floor(budget / pending.length)));
  let i = 0;
  const step = () => {
    if (i >= pending.length) {
      stopTape();
      replayEvent = pending[pending.length - 1] || null;
      updateReplayLag(null, state);
      const lag = document.getElementById("replay-lag");
      if (lag) {
        const last = pending[pending.length - 1];
        const behind = last && last.ts != null
          ? Math.max(0, Math.round(Date.now() / 1000 - Number(last.ts)))
          : snapshotAgeS(state);
        lag.textContent = `waiting · ${behind ?? "?"}s behind`;
      }
      return;
    }
    applyTapeEvent(state, pending[i]);
    i += 1;
  };
  step();
  if (pending.length > 1) tapeTimer = setInterval(step, gap);
}

function bindLifecycle() {
  if (bindLifecycle.bound) return;
  bindLifecycle.bound = true;
  document.addEventListener("visibilitychange", () => {
    syncFlyCursors();
    if (document.visibilityState !== "visible" || !window.__deskBooted) return;
    updateFresh(window.__deskState);
    refresh(loadKey()).catch(() => {});
    const cfg = streamConfig(window.__deskState);
    const key = loadKey();
    if (cfg && key) postHeartbeat(cfg, key);
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !window.__deskBooted) return;
    refresh(loadKey()).catch(() => {});
  });
  setInterval(() => {
    if (!window.__deskState) return;
    updateFresh(window.__deskState);
    updateReplayLag(replayEvent, window.__deskState);
  }, 1000);
}


let liveEs = null;
let liveHbTimer = null;
let liveLastFrameAt = 0;
let liveMode = "replay";
let liveTopicsKey = "";
let liveStaleTimer = null;

export function liveFrameFresh() {
  return !!(liveLastFrameAt && (Date.now() / 1000 - liveLastFrameAt) < 15);
}

function streamConfig(state) {
  const ls = state && state.live_stream;
  if (!ls || !ls.enabled || !ls.frame_topic || !ls.heartbeat_topic) return null;
  const host = String(ls.host || "https://ntfy.sh").replace(/\/$/, "");
  if (!/^https:\/\/ntfy\.sh$/i.test(host)) return null;
  return { host, frame: ls.frame_topic, heartbeat: ls.heartbeat_topic, heartbeatS: Number(ls.heartbeat_s) || 20 };
}

function setLiveMode(mode) {
  liveMode = mode;
  const el = document.getElementById("ls-mode");
  if (el) {
    el.textContent = mode === "live" ? "LIVE" : "REPLAY";
    el.classList.toggle("is-live", mode === "live");
  }
}

function stopLiveStream() {
  if (liveEs) {
    try { liveEs.close(); } catch { /* ignore */ }
    liveEs = null;
  }
  if (liveHbTimer) {
    clearInterval(liveHbTimer);
    liveHbTimer = null;
  }
  if (liveStaleTimer) {
    clearInterval(liveStaleTimer);
    liveStaleTimer = null;
  }
  liveTopicsKey = "";
  liveLastFrameAt = 0;
  setLiveMode("replay");
}

async function postHeartbeat(cfg, key) {
  if (document.visibilityState !== "visible") return;
  try {
    const env = await encryptEnvelope({ kind: "viewer", ts: Date.now() / 1000 }, key);
    await fetch(`${cfg.host}/${encodeURIComponent(cfg.heartbeat)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Priority": "min", "Cache": "no" },
      body: JSON.stringify(env),
      cache: "no-store",
    });
  } catch { /* offline / rate limit */ }
}

async function applyLivePayload(obj, key) {
  if (!obj || obj.kind !== "frame" || !obj.jpeg_b64) return;
  const img = document.getElementById("screen-img");
  const frame = document.getElementById("screen-frame");
  const ptr = document.getElementById("ls-pointer");
  if (!img || !frame) return;
  liveLastFrameAt = Date.now() / 1000;
  setLiveMode("live");
  frame.classList.add("has-shot");
  img.hidden = false;
  img.src = `data:image/jpeg;base64,${obj.jpeg_b64}`;
  img.alt = "Live picture of the desk on a FOMO coin page.";
  if (ptr) ptr.hidden = true;
  const lag = document.getElementById("replay-lag");
  if (lag) {
    const behind = obj.captured_at
      ? Math.max(0, Math.round(Date.now() / 1000 - Number(obj.captured_at)))
      : 0;
    lag.textContent = `live · ${behind}s behind`;
  }
}

async function onNtfyEvent(ev, key) {
  if (!ev || !ev.data) return;
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.event && msg.event !== "message") return;
  let envelope = null;
  try {
    if (msg.attachment && msg.attachment.url) {
      const resp = await fetch(msg.attachment.url, { cache: "no-store" });
      envelope = JSON.parse(await resp.text());
    } else if (msg.message) {
      envelope = JSON.parse(msg.message);
    }
  } catch { return; }
  if (!envelope || !envelope.ct) return;
  try {
    const obj = await decryptEnvelope(envelope, key);
    await applyLivePayload(obj, key);
  } catch { /* wrong key or truncated */ }
}

function startLiveStream(state) {
  const key = loadKey();
  const cfg = streamConfig(state);
  if (!cfg || !key) {
    if (liveEs) stopLiveStream();
    else setLiveMode("replay");
    return;
  }
  const sig = `${cfg.host}/${cfg.frame}/${cfg.heartbeat}`;
  if (liveEs && liveTopicsKey === sig) return;
  stopLiveStream();
  liveTopicsKey = sig;
  setLiveMode("replay");
  const es = new EventSource(`${cfg.host}/${encodeURIComponent(cfg.frame)}/sse`);
  liveEs = es;
  es.onmessage = (ev) => { onNtfyEvent(ev, key); };
  es.addEventListener("message", (ev) => { onNtfyEvent(ev, key); });
  postHeartbeat(cfg, key);
  liveHbTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    postHeartbeat(cfg, key);
  }, cfg.heartbeatS * 1000);
  liveStaleTimer = setInterval(() => {
    if (liveMode === "live" && !liveFrameFresh()) {
      setLiveMode("replay");
      if (window.__deskState) {
        paintMiniScreen(window.__deskState);
        updateReplayLag(replayEvent, window.__deskState);
      }
    }
  }, 1000);
}

function render(state, meta) {
  showApp();
  window.__deskState = state;
  updateFresh(state);
  renderHome(state);
  renderBots(state);
  renderTrades(state);
  renderAccount(state);
  maybeConfetti(state);
  startTape(state);
  startLiveStream(state);
  maybeTradeClick(state);
  syncFlyCursors();
  feedReady = true;
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
  bindLifecycle();
  try {
    await refresh(key);
    window.__deskBooted = true;
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
    if (document.visibilityState === "hidden") return;
    refresh(loadKey()).catch(() => {});
  }, POLL_MS);
}

if (!import.meta.url.endsWith("?test")) {
  boot();
}
