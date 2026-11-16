/* Tiny chart helper for the equity line. Not a full Chart.js. */
const animState = new WeakMap();

function sizeCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || canvas.width || 358;
  const cssH = canvas.clientHeight || canvas.height || 110;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr, cssW, cssH };
}

export function drawLine(canvas, values, color = "#00e87a") {
  if (!canvas) return;
  const points = (values || []).map((v, i) => ({ t: i, v: Number(v) }));
  drawEquity(canvas, points, { color, animate: false });
}

export function drawEquity(canvas, points, opts = {}) {
  if (!canvas) return;
  const { w, h } = sizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const raw = (points || []).filter((p) => p && Number.isFinite(Number(p.v)));
  if (raw.length < 2) {
    ctx.fillStyle = "#636366";
    ctx.font = `${Math.round(11 * (w / (canvas.clientWidth || w)))}px -apple-system, sans-serif`;
    ctx.fillText("No data yet", 16, h / 2);
    return;
  }
  const first = Number(raw[0].v);
  const last = Number(raw[raw.length - 1].v);
  const up = last >= first;
  const color = opts.color || (up ? "#00e87a" : "#ff4d55");
  const markers = opts.markers || [];
  const animate = opts.animate !== false;

  const padX = 8 * (w / (canvas.clientWidth || w));
  const padY = 14 * (w / (canvas.clientWidth || w));
  const minT = Math.min(...raw.map((p) => Number(p.t)));
  const maxT = Math.max(...raw.map((p) => Number(p.t)));
  const minV = Math.min(...raw.map((p) => Number(p.v)));
  const maxV = Math.max(...raw.map((p) => Number(p.v)));
  const spanT = maxT - minT || 1;
  const flat = maxV - minV === 0;
  const spanV = flat ? 1 : (maxV - minV);

  const xy = (p) => {
    const x = padX + ((Number(p.t) - minT) / spanT) * (w - padX * 2);
    const y = flat
      ? h / 2
      : h - padY - ((Number(p.v) - minV) / spanV) * (h - padY * 2);
    return [x, y];
  };

  const coords = raw.map(xy);

  const paint = (until) => {
    ctx.clearRect(0, 0, w, h);
    const n = Math.max(2, Math.min(coords.length, until));
    const shown = coords.slice(0, n);
    ctx.beginPath();
    shown.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    const lastPt = shown[shown.length - 1];
    ctx.lineTo(lastPt[0], h);
    ctx.lineTo(shown[0][0], h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? "rgba(0,232,122,0.28)" : "rgba(255,77,85,0.28)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    shown.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, w / 180);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    if (n >= coords.length) {
      for (const m of markers) {
        const t = Number(m.t);
        if (!Number.isFinite(t) || t < minT || t > maxT) continue;
        // Place the marker on the equity line at that time.
        let [x] = xy({ t, v: last });
        // Interpolate y from nearby equity points.
        let y = lastPt[1];
        for (let i = 1; i < raw.length; i += 1) {
          if (Number(raw[i].t) >= t) {
            const a = raw[i - 1], b = raw[i];
            const p = (t - Number(a.t)) / (Number(b.t) - Number(a.t) || 1);
            const v = Number(a.v) + p * (Number(b.v) - Number(a.v));
            [x, y] = xy({ t, v });
            break;
          }
        }
        ctx.beginPath();
        ctx.fillStyle = "#3b82f6";
        ctx.arc(x, y, Math.max(3.5, w / 90), 0, Math.PI * 2);
        ctx.fill();
        if (m.label) {
          ctx.font = `600 ${Math.max(9, w / 42)}px -apple-system, sans-serif`;
          ctx.fillStyle = "#9ca3af";
          ctx.fillText(String(m.label), x + 6, y - 8);
        }
      }
    }
  };

  const key = `${raw.length}:${first}:${last}:${(opts.tf || "")}`;
  const prev = animState.get(canvas);
  if (!animate || (prev && prev.key === key)) {
    paint(coords.length);
    return;
  }
  const start = performance.now();
  const dur = 700;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - (1 - p) ** 3;
    paint(Math.round(1 + eased * (coords.length - 1)));
    if (p < 1) requestAnimationFrame(step);
    else animState.set(canvas, { key });
  };
  requestAnimationFrame(step);
  animState.set(canvas, { key });
}

export function drawSpark(canvas, values, color = "#00e87a") {
  if (!canvas) return;
  const { w, h } = sizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#07070a";
  ctx.fillRect(0, 0, w, h);
  const vals = (values || []).map(Number).filter(Number.isFinite);
  if (vals.length < 2) return;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pad = 8;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, w / 200);
  ctx.stroke();
}
