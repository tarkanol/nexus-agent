/* ============================================================
   RISK MANAGER
   ============================================================ */
var RiskManager = {
  todayTrades: function() { return trades.filter(function(t) { return sameDay(t.closedAt || Date.now()); }).length; },
  drawdownPct: function() { return peakBal ? Math.max(0, (peakBal - balance) / peakBal * 100) : 0; },
  stale: function(sym) {
    var pd = pData[sym];
    return !pd || !pd.dataUpdatedAt || Date.now() - pd.dataUpdatedAt > CFG.staleDataMs;
  },
  gate: function(sym, notional) {
    if (CFG.killSwitch) return {ok: false, reason: 'KILL'};
    if (RiskManager.drawdownPct() >= CFG.maxDrawdownPct) return {ok: false, reason: 'DD'};
    if (RiskManager.stale(sym)) return {ok: false, reason: 'STALE'};
    if (Runtime.openingLocks[sym]) return {ok: false, reason: 'LOCK'};
    var margin = Accounting.marginRequired(notional, (typeof leverage !== 'undefined' ? leverage : 2));
    if (appMode === 'demo' && margin > balance * 0.90) return {ok: false, reason: 'MARGIN'};
    return {ok: true};
  },
  enforce: function() {
    if (CFG.killSwitch) return;
    var reasons = [];
    if (dailyPnL < 0 && Math.abs(dailyPnL) >= CFG.maxDailyLoss) reasons.push('Günlük zarar limiti');
    if (RiskManager.drawdownPct() >= CFG.maxDrawdownPct) reasons.push('Max drawdown');
    if (RiskManager.todayTrades() >= CFG.maxTradesPerDay) reasons.push('Günlük işlem limiti');
    if (!reasons.length) return;
    CFG.killSwitch = true;
    try { Store.save(); } catch(e) {}
    try { renderRiskStatus(); } catch(e) {}
    if (autonomousMode) { try { toggleAutonomous(); } catch(e) {} }
    notify('🛑 Risk limiti aşıldı: ' + reasons.join(', '), 'error');
    log('[RISK] Kill-switch etkinleşti: ' + reasons.join(', '), 'err');
  }
};

function isDeadHour() {
  var h = new Date().getUTCHours();
  return (h >= 2 && h < 6);
}

function analyzeAll() {
  for (var i = 0; i < pairs.length; i++) {
    var s = pairs[i]; if (!pData[s]) continue;
    try { pData[s].an = analyze(s); } catch(e) { log('Err ' + s, 'err'); }
  }
}

/* ============================================================
   TRACKER - DÜZELTİLMİŞ VE İYİLEŞTİRİLMİŞ
   ============================================================ */
function startTracker() {
  if (TRACKER_INTERVAL) {
    clearInterval(TRACKER_INTERVAL);
    TRACKER_INTERVAL = null;
  }
  
  var activePositions = positions.filter(function(p) {
    return p.state !== POSITION_STATE.CLOSED;
  });
  
  if (!activePositions.length) {
    logPos('Tracker: No active positions', 'info');
    return;
  }
  
  trackerTick = 0;
  TRACKER_INTERVAL = setInterval(runTracker, CFG.trackerMs || 500);
  logPos('Tracker started (' + (CFG.trackerMs || 500) + 'ms) - ' + activePositions.length + ' positions', 'ok');
}

function stopTracker() {
  if (TRACKER_INTERVAL) { 
    clearInterval(TRACKER_INTERVAL); 
    TRACKER_INTERVAL = null; 
    logPos('Tracker stopped', 'info');
  }
}

function runTracker() {
  // Kapalı pozisyonları temizle
  positions = positions.filter(function(p) {
    if (p.state === POSITION_STATE.CLOSED) {
      delete closingNow[p.id];
      return false;
    }
    return true;
  });
  
  var activePositions = positions.filter(function(p) {
    return p.state === POSITION_STATE.OPEN || p.state === POSITION_STATE.ERROR;
  });
  
  if (!activePositions.length) {
    stopTracker();
    return;
  }
  
  trackerTick++;
  
  if (appMode === 'demo') {
    pairs.forEach(function(s) { tickPriceOnly(s); });
    processTrackedPositions();
  } else {
    processTrackedPositions();
    MarketData.refreshOpenPrices()
      .then(function() { 
        processTrackedPositions(); 
        updateTicker(); 
      })
      .catch(function(e) { 
        logPos('[LIVE PRICE] ' + e.message, 'err'); 
      });
  }
  
  if (trailOn) {
    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      if (!pos || closingNow[pos.id]) continue;
      if (pos.state !== POSITION_STATE.OPEN) continue;
      var pr = Number(pData[pos.pair] && pData[pos.pair].price);
      if (Number.isFinite(pr) && pr > 0) {
        TrailService.update(pos, pr);
      }
    }
  }
  
  var now = Date.now();
  for (var i = 0; i < positions.length; i++) {
    var pos = positions[i];
    if (!pos || pos.state !== POSITION_STATE.OPEN) continue;
    if (!pos.lastWeaknessCheck) pos.lastWeaknessCheck = 0;
    if (now - pos.lastWeaknessCheck < 300000) continue;
    pos.lastWeaknessCheck = now;
    
    var pd = pData[pos.pair];
    if (!pd) continue;
    var kl1h = pd.kl1h || [];
    if (kl1h.length < 5) continue;
    
    var c1h = kl1h.map(function(k) { return k.c; });
    var e9 = calcEMA(c1h, 9);
    var e21 = calcEMA(c1h, 21);
    if (!e9 || e9.length < 2 || !e21 || e21.length < 2) continue;
    
    var lastE9 = e9[e9.length - 1];
    var lastE21 = e21[e21.length - 1];
    var prevE9 = e9[e9.length - 2];
    var prevE21 = e21[e21.length - 2];
    if (!lastE9 || !lastE21 || !prevE9 || !prevE21) continue;
    
    var macd = calcMACD(c1h);
    var rsi = calcRSI(c1h, 14);
    var vol = kl1h[kl1h.length - 1].v;
    var volAvg = 0;
    for (var j = kl1h.length - 20; j < kl1h.length; j++) volAvg += kl1h[j].v;
    volAvg /= 20;
    if (volAvg <= 0) volAvg = 1;

    var currentData = {
      macdHist: macd.hist,
      prevMacdHist: macd.prev,
      ema9: lastE9,
      ema21: lastE21,
      prevEma9: prevE9,
      prevEma21: prevE21,
      volume: vol,
      avgVolume: volAvg,
      rsi: rsi,
      emaSlope: (lastE9 - e9[Math.max(0, e9.length - 5)]) / (e9[Math.max(0, e9.length - 5)] || 1)
    };

    var wScore = weaknessScore(pos, currentData);
    if (wScore >= 5) {
      Execution.close(pos.id, 'WEAKNESS_FULL');
    } else if (wScore >= 3) {
      Execution.closePartial(pos.id, 0.5, 'WEAKNESS_HALF');
    }
  }
  
  if (appMode === 'live' && trackerTick % Math.max(1, Math.round((CFG.reconcileMs || 3000) / (CFG.trackerMs || 500))) === 0) {
    Execution.reconcile(false);
  }
  
  if (trackerTick % 10 === 0 && Execution.sweepStuck) {
    Execution.sweepStuck();
  }
  
  if (trackerTick % 2 === 0) { 
    updatePosUI(); 
    updateTicker(); 
    renderRiskStatus(); 
  }
  
  activePositions = positions.filter(function(p) {
    return p.state === POSITION_STATE.OPEN || p.state === POSITION_STATE.ERROR;
  });
  
  if (!activePositions.length) {
    stopTracker();
  }
}

function processTrackedPositions() {
  positions = positions.filter(function(p) {
    if (p.state === POSITION_STATE.CLOSED) {
      delete closingNow[p.id];
      return false;
    }
    return true;
  });
  
  var openPositions = positions.filter(function(p) {
    return p.state === POSITION_STATE.OPEN || p.state === POSITION_STATE.ERROR;
  });
  var trackNow = Date.now();
  
  for (var i = 0; i < openPositions.length; i++) {
    var pos = openPositions[i];
    if (!pos || closingNow[pos.id]) continue;
    // v16.4: bir onceki kapama denemesi basarisiz oldugunda (state=ERROR),
    // her tracker tick'inde (500ms) hemen tekrar denemek yerine 5sn soguma
    // uyguluyoruz. Boylece kalici bir hata (ornegin borsada pozisyon zaten
    // yokken tekrar tekrar /close cagirmak) siki bir donguye donusmuyor.
    if (pos.state === POSITION_STATE.ERROR && (trackNow - (pos.stateUpdatedAt || 0)) < 5000) continue;
    
    var pr = Number(pData[pos.pair] && pData[pos.pair].price);
    if (!Number.isFinite(pr) || pr <= 0) continue;
    
    var hitSL = (pos.side === 'LONG' && pr <= Number(pos.sl)) || 
               (pos.side === 'SHORT' && pr >= Number(pos.sl));
    if (hitSL) {
      logPos('[SL HIT] ' + pos.pair + ' price:' + fp(pr) + ' sl:' + fp(pos.sl), 'err');
      Execution.close(pos.id, pos.trailActive ? 'TRAILING STOP' : 'STOP LOSS');
      continue;
    }
    
    var hitTP = (pos.side === 'LONG' && pr >= Number(pos.tp)) || 
               (pos.side === 'SHORT' && pr <= Number(pos.tp));
    if (hitTP) {
      logPos('[TP HIT] ' + pos.pair + ' price:' + fp(pr) + ' tp:' + fp(pos.tp), 'ok');
      Execution.close(pos.id, 'TAKE PROFIT');
    }
  }
}

var TrailService = {
  update: function(pos, price) {
    var qty = Math.abs(Number(pos.qty) || 0);
    if (!qty) return;
    var grossPnl = Accounting.grossPnl(pos.side, pos.entry, price, qty);
    if (grossPnl > pos.highPnl) pos.highPnl = grossPnl;
    var high = pos.highPnl || 0;
    var roundTrip = Accounting.roundTripCost(pos.posVal, pos.feeRate);
    var refTarget = Math.abs(pos.entry * 0.008 * (pos.leverage || 1));
    var activation = Math.max(refTarget * 0.25, roundTrip * 1.2);
    if (high < activation) return;
    var pullback = high >= refTarget * 1.5 ? 0.12 : 
                   high >= refTarget * 1.0 ? 0.20 : 
                   high >= refTarget * 0.5 ? 0.30 : 0.40;
    var locked = Math.max(high * (1 - pullback), roundTrip);
    var dist = locked / qty;
    var newSL = pos.side === 'LONG' ? pos.entry + dist : pos.entry - dist;
    var improved = pos.side === 'LONG' ? newSL > pos.sl : newSL < pos.sl;
    if (!improved) return;
    if (Math.abs(newSL - pos.sl) / (price || pos.entry) < 0.00015) return;
    pos.sl = newSL;
    pos.trailActive = true;
    logPos('[TRAIL] ' + pos.pair.replace('_USDT', '') + ' SL→$' + fp(newSL), 'ok');
  }
};

function weaknessScore(pos, currentData) {
  var score = 0;
  var yon = pos.side;

  if (yon === 'LONG' && currentData.macdHist < currentData.prevMacdHist) score += 1;
  if (yon === 'SHORT' && currentData.macdHist > currentData.prevMacdHist) score += 1;

  var emaSpread = currentData.ema9 - currentData.ema21;
  var prevSpread = currentData.prevEma9 - currentData.prevEma21;
  if (yon === 'LONG' && emaSpread < prevSpread) score += 1;
  if (yon === 'SHORT' && emaSpread > prevSpread) score += 1;

  if (currentData.volume < currentData.avgVolume * 0.8) score += 1;
  if (yon === 'LONG' && currentData.rsi > 75) score += 2;
  if (yon === 'SHORT' && currentData.rsi < 25) score += 2;
  if (yon === 'LONG' && currentData.emaSlope < 0) score += 2;
  if (yon === 'SHORT' && currentData.emaSlope > 0) score += 2;

  return score;
}
