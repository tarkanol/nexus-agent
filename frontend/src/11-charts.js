/* ============================================================
   CHARTS
   ============================================================ */
function initChart() {
  var c = document.getElementById('chart'); if (c) chartCtx = c.getContext('2d');
  var e = document.getElementById('equityChart'); if (e) eqCtx = e.getContext('2d');
}

function drawChart() {
  if (!chartCtx) return;
  if (document.getElementById('pg-signal').className.indexOf('active') === -1) return;
  if (chartRAF) cancelAnimationFrame(chartRAF);
  chartRAF = requestAnimationFrame(function() {
    var pd = pData[currentPair]; if (!pd) return;
    var tfMap = {'1m': 'kl1m', '5m': 'kl5m', '15m': 'kl15m', '1h': 'kl1h'};
    var kl = pd[tfMap[currentTF] || 'kl5m'] || []; if (kl.length < 5) return;
    var cv = chartCtx.canvas, W = cv.offsetWidth || 300, H = 120;
    if (W !== lastCW) { cv.width = W; cv.height = H; lastCW = W; }
    var ctx = chartCtx;
    ctx.clearRect(0, 0, W, H);
    var n = Math.min(60, kl.length), k = kl.slice(-n), closes = [], i;
    for (i = 0; i < k.length; i++) closes.push(k[i].c);
    var mn = Infinity, mx = -Infinity;
    for (i = 0; i < k.length; i++) { if (k[i].l < mn) mn = k[i].l; if (k[i].h > mx) mx = k[i].h; }
    var an = pd.an && pd.an.signal !== 'WAIT' ? pd.an : null;
    if (an) { if (an.sl) { mn = Math.min(mn, an.sl * .999); mx = Math.max(mx, an.sl * 1.001); } if (an.tp) { mn = Math.min(mn, an.tp * .999); mx = Math.max(mx, an.tp * 1.001); } }
    for (i = 0; i < positions.length; i++) {
      if (positions[i].pair === currentPair) {
        if (positions[i].sl) { mn = Math.min(mn, positions[i].sl * .999); mx = Math.max(mx, positions[i].sl * 1.001); }
        if (positions[i].tp) { mn = Math.min(mn, positions[i].tp * .999); mx = Math.max(mx, positions[i].tp * 1.001); }
      }
    }
    var rng = mx - mn; if (rng <= 0) return;
    var cw = W / n;
    function toY(v) { return H - 4 - ((v - mn) / rng) * (H - 8); }
    ctx.strokeStyle = '#081820'; ctx.lineWidth = 1;
    for (var gi = 0; gi < 3; gi++) { var gy = 4 + (H - 8) * gi / 2; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
    ctx.fillStyle = '#1a3a55'; ctx.font = '5px monospace';
    for (gi = 0; gi < 3; gi++) ctx.fillText('$' + fp(mx - rng * gi / 2), 2, 4 + (H - 8) * gi / 2 - 1);
    var e9 = calcEMA(closes, 9), e21 = calcEMA(closes, 21), st = false, x;
    ctx.beginPath(); ctx.strokeStyle = '#00b8d9'; ctx.lineWidth = 1;
    for (i = 0; i < e9.length; i++) { if (!e9[i]) continue; x = (i + .5) * cw; if (!st) { ctx.moveTo(x, toY(e9[i])); st = true; } else ctx.lineTo(x, toY(e9[i])); }
    ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = '#ff9900'; ctx.lineWidth = 1; st = false;
    for (i = 0; i < e21.length; i++) { if (!e21[i]) continue; x = (i + .5) * cw; if (!st) { ctx.moveTo(x, toY(e21[i])); st = true; } else ctx.lineTo(x, toY(e21[i])); }
    ctx.stroke();
    for (i = 0; i < positions.length; i++) {
      if (positions[i].pair === currentPair) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255,51,85,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, toY(positions[i].sl)); ctx.lineTo(W, toY(positions[i].sl)); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,255,136,0.5)';
        ctx.beginPath(); ctx.moveTo(0, toY(positions[i].tp)); ctx.lineTo(W, toY(positions[i].tp)); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    for (i = 0; i < k.length; i++) {
      var bar = k[i]; x = (i + .5) * cw; var bw = Math.max(cw * .6, 1);
      var col = bar.c >= bar.o ? 'rgba(0,255,136,.6)' : 'rgba(255,51,85,.6)';
      ctx.beginPath(); ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.moveTo(x, toY(bar.h)); ctx.lineTo(x, toY(bar.l)); ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(x - bw / 2, Math.min(toY(bar.o), toY(bar.c)), bw, Math.max(1, Math.abs(toY(bar.o) - toY(bar.c))));
    }
    var lp = closes[closes.length - 1];
    ctx.setLineDash([2, 4]); ctx.strokeStyle = 'rgba(255,204,68,.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, toY(lp)); ctx.lineTo(W, toY(lp)); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,204,68,.6)'; ctx.font = '5px monospace';
    ctx.fillText('$' + fp(lp), W - 48, toY(lp) - 2);
  });
}

function drawEquity() {
  if (!eqCtx || equityHistory.length < 2) return;
  var cv = eqCtx.canvas, W = cv.offsetWidth || 300, H = 40;
  cv.width = W; cv.height = H;
  var ctx = eqCtx, data = equityHistory, n = data.length;
  var mn = Math.min.apply(null, data), mx = Math.max.apply(null, data);
  var rng = mx - mn; if (rng < 0.01) rng = 1;
  function toX(i) { return (i / (n - 1)) * W; }
  function toY(v) { return H - 2 - ((v - mn) / rng) * (H - 4); }
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0]));
  for (var i = 1; i < n; i++) ctx.lineTo(toX(i), toY(data[i]));
  ctx.strokeStyle = data[n - 1] >= data[0] ? '#00ff88' : '#ff3355';
  ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = 'rgba(255,204,68,0.6)'; ctx.font = '6px monospace';
  ctx.fillText('$' + data[n - 1].toFixed(2), W - 42, 8);
}
