/* ============================================================
   SETTINGS / UI HELPERS
   ============================================================ */
function readSettings() {
  targetMult = parseFloat(document.getElementById('selTargetMult').value);
  riskMult = parseFloat(document.getElementById('selRiskMult').value);
  scanSec = parseInt(document.getElementById('selInt').value);
  maxPosSize = parseFloat(document.getElementById('autoMaxSize').value) || 0;
  maxLeverage = parseFloat(document.getElementById('autoMaxLeverage').value) || 0;
  minScore = parseFloat(document.getElementById('autoMinScore').value) || 50;
  updateBalUI();
}

function toggleAutoTrade() {
  autoTrade = !autoTrade;
  document.getElementById('togAutoTrade').className = 'tog ' + (autoTrade ? 'on' : 'off');
  document.getElementById('togAutoTradeD').textContent = autoTrade ? 'On' : 'Off';
}

function toggleTrail() {
  trailOn = !trailOn;
  document.getElementById('togTrail').className = 'tog ' + (trailOn ? 'on' : 'off');
  document.getElementById('togTrailD').textContent = trailOn ? 'On' : 'Off';
}

function swPage(name) {
  var pages = ['signal', 'pos', 'engine', 'settings'];
  for (var i = 0; i < pages.length; i++) {
    var pg = document.getElementById('pg-' + pages[i]);
    if (pg) { pg.className = 'page'; }
  }
  var activePage = document.getElementById('pg-' + name);
  if (activePage) { activePage.className = 'page active'; }
  var navBtns = document.querySelectorAll('.nb');
  for (var j = 0; j < navBtns.length; j++) {
    navBtns[j].className = 'nb';
    if (navBtns[j].getAttribute('data-page') === name) {
      navBtns[j].className = 'nb active';
    }
  }
  if (name === 'signal') { setTimeout(drawChart, 100); }
  if (name === 'pos') { updatePosUI(); setTimeout(drawEquity, 100); }
}

function setTF(tf) {
  currentTF = tf;
  document.querySelectorAll('.tf-btn').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-tf') === tf); });
  drawChart();
}

function renderCoinList() {
  var root = document.getElementById('coinList'); root.textContent = '';
  pairs.forEach(function(s) {
    var tag = document.createElement('span');
    tag.style.cssText = 'cursor:pointer;font-size:7px;padding:2px 5px;border-radius:2px;background:rgba(0,212,255,.04);border:1px solid var(--brd2);color:var(--text2);font-family:var(--mono);display:inline-block;margin:1px';
    tag.textContent = s.replace('_USDT', '') + ' ×';
    tag.onclick = function() { removeCoin(s); };
    root.appendChild(tag);
  });
}

function removeCoin(s) {
  if (pairs.length <= 1) return;
  pairs = pairs.filter(function(v) { return v !== s; });
  if (currentPair === s) currentPair = pairs[0];
  renderCoinList(); updatePairRow(); updateSignalUI();
}

function addCoin() {
  var raw = document.getElementById('newCoin').value.trim().toUpperCase(); if (!raw) return;
  var rejected = [];
  raw.split(/[,\s]+/).filter(Boolean).forEach(function(v) {
    try {
      var sym = validSymbol(v.indexOf('_USDT') === -1 ? v + '_USDT' : v);
      if (pairs.indexOf(sym) === -1 && pairs.length < 10) {
        pairs.push(sym);
        DEMO_BASE[sym] = DEMO_BASE[sym] || 1;
        pxState[sym] = {price: DEMO_BASE[sym], vel: 0};
      }
      else if (pairs.length >= 10) { rejected.push(v + ' (max 10)'); }
    } catch(e) { rejected.push(v); }
  });
  document.getElementById('newCoin').value = '';
  renderCoinList();
  if (rejected.length) notify('Rejected: ' + rejected.join(', '), 'error');
}

function fetchTopCoins() {
  if (!WORKER) { document.getElementById('fetchStatus').textContent = '⚠️ Live required.'; return; }
  var btn = document.getElementById('btnFetch'), status = document.getElementById('fetchStatus');
  btn.disabled = true; status.textContent = 'Loading...';
  Http.get('/gateio_tickers').then(function(d) {
    btn.disabled = false;
    if (d && d.success && Array.isArray(d.data)) {
      var list = d.data.filter(function(c) { return (c.contract || c.symbol || '').indexOf('_USDT') !== -1; });
      list.sort(function(a, b) { return (b.volume_24h_quote || 0) - (a.volume_24h_quote || 0); });
      pairs = list.slice(0, 10).map(function(c) {
        var sym = c.contract || c.symbol;
        if (!DEMO_BASE[sym]) DEMO_BASE[sym] = c.last_price || 1;
        return sym;
      });
      currentPair = pairs[0];
      pairs.forEach(function(s) {
        DEMO_BASE[s] = DEMO_BASE[s] || 1;
        pxState[s] = pxState[s] || {price: DEMO_BASE[s], vel: 0};
      });
      renderCoinList(); updatePairRow(); updateSignalUI();
      status.textContent = pairs.length + ' coins loaded.';
    } else status.textContent = 'Failed.';
  }).catch(function() { btn.disabled = false; status.textContent = 'Error.'; });
}

function doReset() {
  if (!confirm('Reset demo ledger?')) return;
  if (appMode === 'live' && positions.length) { notify('Live positions exist; close them first', 'error'); return; }
  balance = START_BAL; dailyPnL = 0; positions = []; trades = [];
  winStreak = 0; loseStreak = 0; tpSlHits = 0; equityHistory = [START_BAL]; peakBal = START_BAL;
  CFG.killSwitch = false; CFG.recoveryMode = false; autonomousTrades = 0;
  if (autonomousMode) toggleAutonomous();
  window.__apexStorage.removeItem(CFG.persistKey);
  stopTracker(); updatePosUI(); updateBalUI(); updateWRStrip(); drawEquity(); renderRiskStatus();
  log('Ledger reset to $50', 'info');
  sendTelegram('🔄 RESET');
}

function notify(msg, type) {
  var box = document.getElementById('notif');
  var d = document.createElement('div'); d.className = 'notif ' + (type || 'info'); d.textContent = msg;
  box.appendChild(d);
  setTimeout(function() { d.style.opacity = '0'; d.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(function() { if (d.parentNode) d.parentNode.removeChild(d); }, 2600);
}

function log(msg, t) {
  var b = document.getElementById('logEl'); if (!b) return;
  var ts = new Date().toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  var col = t === 'ok' ? '#00cc66' : t === 'err' ? '#ff3355' : '#0088aa';
  var d = document.createElement('div'); d.style.color = col; d.textContent = ts + ' ' + msg;
  b.appendChild(d); b.scrollTop = b.scrollHeight;
  while (b.childNodes.length > 100) b.removeChild(b.firstChild);
}

function logPos(msg, t) {
  var b = document.getElementById('posLogBox'); if (!b) return;
  var ts = new Date().toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  var col = t === 'ok' ? '#00cc66' : t === 'err' ? '#ff3355' : '#00d4ff';
  var d = document.createElement('div'); d.style.color = col; d.textContent = ts + ' ' + msg;
  b.appendChild(d); b.scrollTop = b.scrollHeight;
  while (b.childNodes.length > 80) b.removeChild(b.firstChild);
}

function openPos(sym, side, auto, manTP, manSL) { return Execution.open(sym, side, auto, manTP, manSL); }
function closePos(id, reason) { return Execution.close(id, reason); }
function manualOpen(side) {
  var tp = parseFloat(document.getElementById('manTP').value), sl = parseFloat(document.getElementById('manSL').value);
  if (isNaN(tp) || isNaN(sl) || tp <= 0 || sl <= 0) { notify('Enter valid TP/SL', 'error'); return; }
  openPos(currentPair, side, false, tp, sl);
}

function bindSafeUI() {
  var ids = {safeDaily: CFG.maxDailyLoss, safeDD: CFG.maxDrawdownPct, safeTrades: CFG.maxTradesPerDay,
             safeStale: CFG.staleDataMs / 1000, safeSlip: CFG.slippageBps, safeSpread: CFG.spreadBps};
  Object.keys(ids).forEach(function(id) { var e = document.getElementById(id); if (e) e.value = ids[id]; });
  
  var save = document.getElementById('safeSave');
  if (save) save.onclick = function() {
    function gv(id, fb) { var e = document.getElementById(id); return e ? num(e.value, fb) : fb; }
    CFG.maxDailyLoss = Math.abs(gv('safeDaily', 999));
    CFG.maxDrawdownPct = Math.abs(gv('safeDD', 8));
    CFG.maxTradesPerDay = Math.max(1, Math.floor(gv('safeTrades', 999)));
    CFG.staleDataMs = Math.max(10000, gv('safeStale', 90) * 1000);
    CFG.slippageBps = Math.max(0, gv('safeSlip', 2));
    CFG.spreadBps = Math.max(0, gv('safeSpread', 1));
    Store.save(); renderRiskStatus(); notify('Safety limits saved', 'success');
  };
  
  var kill = document.getElementById('safeKill');
  if (kill) kill.onclick = function() {
    CFG.killSwitch = !CFG.killSwitch; Store.save(); renderRiskStatus();
    if (autonomousMode) { toggleAutonomous(); }
    if (appMode === 'live' && WORKER && Runtime.capabilities.kill !== false) {
      Http.post('/kill', {enabled: CFG.killSwitch, closeAll: true}).catch(function() {});
    }
  };
  
  var bt = document.getElementById('runBacktest');
  if (bt) bt.onclick = function() {
    var out = document.getElementById('safeDiagOut');
    try {
      var r = Backtester.run(currentPair);
      out.textContent = 'BACKTEST ' + currentPair + '\nTrades: ' + r.trades + '\nWin rate: ' + r.winRate.toFixed(1) + '%\nNet: ' + (r.net >= 0 ? '+' : '') + '$' + r.net.toFixed(4);
    } catch(e) { out.textContent = 'BACKTEST ERROR: ' + e.message; }
  };
  
  var rt = document.getElementById('runTests');
  if (rt) rt.onclick = function() {
    var out = document.getElementById('safeDiagOut'), res = TestSuite.run();
    out.textContent = res.map(function(x, i) { return (x.ok ? '✅' : '❌') + ' ' + x.name + (x.error ? ' — ' + x.error : ''); }).join('\n') +
      '\n' + res.filter(function(x) { return x.ok; }).length + '/' + res.length + ' passed';
  };
  
  renderRiskStatus();
}
