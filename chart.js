/* Tiny chart helper for the Live / Night / Week tabs. Not a full Chart.js. */
export function drawLine(canvas, values, color = "#50c878") {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!values || values.length < 2) {
    ctx.fillStyle = "#6b7280";
    ctx.fillText("No data yet", 12, h / 2);
    return;
  }
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * (w - 8) + 4;
    const y = h - 4 - ((v - min) / span) * (h - 8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
