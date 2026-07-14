/* ============================================================
   CONNECT / DEMO
   ============================================================ */
function connectLive() {
  var url = document.getElementById('wUrl').value.trim();
  if (!url) { notify('Enter Worker URL', 'error'); return; }
  WORKER = url.replace(/\/+$/, '');
  Runtime.apiMode = 'unknown';
  Runtime.capabilities = {snapshot: null, state: null, riskUpdate: null, kill: null};
  Runtime.compatNotified = false;
  Http.get('/ping').then(function(d) {
    if (!d || !d.success) throw new Error('Worker not responding');
    ApiCompat.applyPing(d);
    appMode = 'live';
    document.getElementById('bdgConn').textContent = 'LIVE';
    document.getElementById('bdgConn').className = 'bdg live';
    return Execution.reconcile(true).then(function() {
      // v16.4 FIX: canliya baglanildiginda peakBal'i demo'nun sabit $50
      // varsayimina degil, GERCEK bakiyeye gore sifirliyoruz. Aksi halde
      // kullanici futures cuzdanini bilerek dusuk bir limitle (orn. $21)
      // fonlamissa, uygulama bunu kalici bir "drawdown" saniyor ve DD%
      // gostergesi hicbir zaman duzelmiyor; hatta gereksiz yere
      // kill-switch'i tetikleyebiliyor. Gercek sermaye artik yeni baslangic
      // noktasi.
      if (Number.isFinite(balance) && balance > 0) {
        var oldPeak = peakBal;
        peakBal = balance;
        if (Math.abs(oldPeak - peakBal) > 0.01) {
          log('[BASELINE] Risk referansi $' + oldPeak.toFixed(2) + ' -> $' + peakBal.toFixed(2) + ' olarak güncellendi (gerçek bakiye)', 'info');
        }
      }
      return MarketData.fetchLive();
    });
  }).then(function() {
    var hasData = pairs.some(function(s) { return pData[s] && pData[s].price; });
    if (!hasData) {
      pairs.forEach(function(s) {
        if (!pData[s]) pData[s] = {};
        if (!pData[s].price) { pData[s].price = DEMO_BASE[s] || 1; }
        if (!pData[s].masterKlines) { pData[s].masterKlines = seedKlines(s, 500); tickFull(s); }
      });
      analyzeAll();
    }
    document.getElementById('connStatus').textContent = ApiCompat.statusText();
    if (loopTimer) clearTimeout(loopTimer);
    mainLoop();
    notify('Live connected', 'success');
    sendTelegram('✅ LIVE CONNECTED');
  }).catch(function(e) {
    WORKER = ''; appMode = 'demo';
    notify('Connection error: ' + e.message, 'error');
  });
}

function startDemo() {
  WORKER = ''; appMode = 'demo'; futBal = null;
  document.getElementById('bdgConn').textContent = 'DEMO';
  document.getElementById('bdgConn').className = 'bdg';
  document.getElementById('connStatus').textContent = 'Demo mode';
  
  for (var i = 0; i < 3; i++) { demoRefresh(); }
  
  if (loopTimer) clearTimeout(loopTimer);
  mainLoop();
  log('V' + APP_VERSION + ' demo started | Min pos: $' + MIN_POS_VAL, 'ok');
  sendTelegram('🔄 DEMO MODE V' + APP_VERSION);
}

/* ============================================================
   MAIN LOOP
   ============================================================ */
async function mainLoop() {
  if (Runtime.scanBusy) { loopTimer = setTimeout(mainLoop, 1000); return; }
  Runtime.scanBusy = true;
  try {
    if (appMode === 'demo') demoRefresh();
    else await MarketData.fetchLive();
    Runtime.lastScanAt = Date.now();
    if (engineOn) runEngine();
    updateSignalUI(); updatePairRow(); updateTicker(); updateCoinScoreTable();
    updateWRStrip(); drawChart(); drawEquity(); renderRiskStatus();
    if (engineOn) startCountdown();
  } catch(e) { log('[SCAN] ' + e.message, 'err'); }
  finally { Runtime.scanBusy = false; loopTimer = setTimeout(mainLoop, scanSec * 1000); }
}
