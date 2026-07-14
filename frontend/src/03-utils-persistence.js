/* ============================================================
   UTILS
   ============================================================ */
function clampNum(n, a, b) { return Math.max(a, Math.min(b, n)); }
function num(v, d) { var n = Number(v); return Number.isFinite(n) ? n : (d || 0); }
function uid(prefix) { return (prefix || 'apx') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function orderId(action, sym) {
  return ('t-apx-' + action.charAt(0) + '-' + String(sym || '').replace('_USDT', '').toLowerCase() + '-' + Date.now().toString(36)).slice(0, 28);
}

function validSymbol(s) {
  s = String(s || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}_USDT$/.test(s)) throw new Error('Invalid symbol');
  return s;
}
function sameDay(ts) { return new Date(ts).toISOString().slice(0, 10) === CFG.dayKey; }
function intervalMs(tf) {
  return ({'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000})[tf] || 60000;
}
function closedCandles(arr, tf, now) {
  if (!Array.isArray(arr)) return [];
  var ms = intervalMs(tf), cutoff = Math.floor((now || Date.now()) / ms) * ms;
  return arr.filter(function(k) { return Number(k.t) < cutoff; });
}
function fp(p) {
  if (!p || isNaN(p)) return '--';
  if (p >= 10000) return Math.round(p).toLocaleString();
  if (p >= 1000) return p.toFixed(2);
  if (p >= 10) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toFixed(6);
}

/* ============================================================
   PERSISTENCE
   ============================================================ */
var Store = {
  load: function() {
    try {
      var raw = window.__apexStorage.getItem(CFG.persistKey);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s.dayKey === CFG.dayKey) {
        balance = num(s.balance, START_BAL);
        dailyPnL = num(s.dailyPnL, 0);
        trades = Array.isArray(s.trades) ? s.trades : [];
        equityHistory = Array.isArray(s.equityHistory) && s.equityHistory.length ? s.equityHistory : [balance];
        winStreak = num(s.winStreak, 0);
        loseStreak = num(s.loseStreak, 0);
        peakBal = Math.max(num(s.peakBal, balance), balance);
        autonomousTrades = num(s.autonomousTrades, 0);
      }
      if (s.risk) Object.assign(CFG, s.risk);
    } catch(e) {}
  },
  save: function() {
    try {
      window.__apexStorage.setItem(CFG.persistKey, JSON.stringify({
        dayKey: CFG.dayKey, balance: balance, dailyPnL: dailyPnL,
        trades: trades.slice(-500), equityHistory: equityHistory.slice(-500),
        winStreak: winStreak, loseStreak: loseStreak, peakBal: peakBal,
        autonomousTrades: autonomousTrades,
        risk: {
          maxDailyLoss: CFG.maxDailyLoss, maxDrawdownPct: CFG.maxDrawdownPct,
          maxTradesPerDay: CFG.maxTradesPerDay, staleDataMs: CFG.staleDataMs,
          slippageBps: CFG.slippageBps, spreadBps: CFG.spreadBps, killSwitch: CFG.killSwitch,
          deadHourEnabled: CFG.deadHourEnabled, deadHourStart: CFG.deadHourStart, deadHourEnd: CFG.deadHourEnd
        }
      }));
    } catch(e) {}
  }
};
