/* ============================================================
   AUTONOMOUS MODE
   ============================================================ */
function toggleAutonomous() {
  autonomousMode = !autonomousMode;
  var btn = document.getElementById('autoBtn');
  var btnText = document.getElementById('autoBtnText');
  var btnSub = document.getElementById('autoBtnSub');
  var btnStats = document.getElementById('autoBtnStats');
  var bdg = document.getElementById('bdgAuto');
  var qa = document.getElementById('qaAuto');
  
  if (autonomousMode) {
    btn.className = 'auto-btn active';
    btnText.textContent = '⏹ STOP';
    btnSub.textContent = 'Active • Trading full autonomy';
    btnStats.textContent = 'RUNNING • ' + positions.length + ' open • ' + autonomousTrades + ' trades';
    bdg.textContent = '⚡';
    bdg.className = 'bdg autonomous';
    document.getElementById('wrAutoStatus').textContent = '⚡ RUN';
    document.getElementById('wrAutoStatus').style.color = 'var(--long)';
    if (qa) { qa.className = 'qa-btn on'; }
    if (!engineOn) toggleEng();
    sendTelegram('⚡ AUTONOMOUS ACTIVATED\nBalance: $' + balance.toFixed(2));
    notify('🚀 AUTONOMOUS ACTIVE', 'autonomous');
  } else {
    btn.className = 'auto-btn';
    btnText.textContent = '▶ START';
    btnSub.textContent = 'Full autonomous trading';
    btnStats.textContent = 'Idle • ' + autonomousTrades + ' trades';
    bdg.textContent = '⏸️';
    bdg.className = 'bdg';
    document.getElementById('wrAutoStatus').textContent = '⏸️';
    document.getElementById('wrAutoStatus').style.color = 'var(--warn)';
    if (qa) { qa.className = 'qa-btn'; }
    autoTrade = false;
    sendTelegram('⏹ AUTONOMOUS STOPPED\nBalance: $' + balance.toFixed(2));
    notify('⏹ Autonomous stopped', 'info');
  }
  updateSignalUI();
}

/* ============================================================
   EXECUTION - DÜZELTİLMİŞ VERSİYON
   ============================================================ */
var StateMachine = {
  allowed: {
    PENDING_OPEN: ['OPEN', 'ERROR'],
    OPEN: ['PENDING_CLOSE', 'ERROR'],
    PENDING_CLOSE: ['CLOSED', 'OPEN', 'ERROR'],
    ERROR: ['OPEN', 'PENDING_CLOSE', 'CLOSED'],
    CLOSED: []
  },
  transition: function(pos, next, message) {
    var current = pos.state || POSITION_STATE.OPEN;
    var allowed = StateMachine.allowed[current] || [];
    if (allowed.indexOf(next) === -1) throw new Error('Invalid state transition ' + current + ' -> ' + next);
    pos.state = next;
    pos.stateUpdatedAt = Date.now();
    pos.lastError = next === POSITION_STATE.ERROR ? String(message || 'Unknown error') : '';
    return pos;
  }
};

var Execution = {
  makePosition: function(sym, side, price, posVal, qty, sl, tp, auto, cOrderId, score, entryAtr, leverageUsed) {
    return {
      id: posId++, pair: sym, side: side, entry: price, qty: qty, posVal: posVal,
      sl: sl, tp: tp, initialSL: sl, initialTP: tp,
      feeRate: CFG.feeRate, entryFee: Accounting.entryFee(posVal, CFG.feeRate),
      openTime: Date.now(), highPnl: 0, trailActive: false, auto: !!auto,
      state: POSITION_STATE.PENDING_OPEN, stateUpdatedAt: Date.now(),
      clientOrderId: cOrderId, exchangeOrderId: null, lastError: '', serverManaged: appMode === 'live',
      score: score || 0, entryAtr: entryAtr || 0, leverage: leverageUsed || 1,
      lastWeaknessCheck: 0
    };
  },
  
  open: async function(sym, side, auto, manualTargetUsd, manualRiskUsd) {
    try { sym = validSymbol(sym); } catch(e) { notify(e.message, 'error'); return; }
    var pd = pData[sym], an = pd && pd.an && pd.an.signal !== 'WAIT' ? pd.an : null;
    var price = an ? Number(an.price) : Number(pd && pd.price);
    if (!price) { notify('Price unavailable', 'error'); return; }
    
    var posVal, qty, sl, tp, lev = 1;
    if (manualTargetUsd && manualRiskUsd) {
      posVal = maxPosSize > 0 ? maxPosSize : Math.max(MIN_POS_VAL, balance * 0.1);
      if (posVal < MIN_POS_VAL) { notify('Position too small ($' + posVal.toFixed(2) + ')', 'error'); return; }
      qty = posVal / price;
      var slDist = Accounting.pnlTargetToDistance(manualRiskUsd, qty);
      var tpDist = Accounting.pnlTargetToDistance(manualTargetUsd, qty);
      sl = side === 'LONG' ? price - slDist : price + slDist;
      tp = side === 'LONG' ? price + tpDist : price - tpDist;
      lev = maxLeverage > 0 ? Math.min(maxLeverage, 15) : Math.min(3, (typeof leverage !== 'undefined' ? leverage : 2));
    } else if (an) {
      posVal = Number(an.posVal); qty = posVal / price; sl = Number(an.sl); tp = Number(an.tp);
      lev = an.leverage || Math.min(5, (typeof leverage !== 'undefined' ? leverage : 2));
      if (posVal < MIN_POS_VAL) {
        posVal = MIN_POS_VAL;
        qty = posVal / price;
      }
    } else { notify('No signal', 'error'); return; }
    
    var sameSideOpen = positions.filter(function(p) { return p.side === side && p.state !== POSITION_STATE.CLOSED; }).length;
    if (sameSideOpen > 0) {
      var corrMult = sameSideOpen === 1 ? 0.5 : sameSideOpen === 2 ? 0.25 : 0.12;
      posVal = posVal * corrMult;
      qty = posVal / price;
      if (posVal < MIN_POS_VAL * 0.5) { return; }
    }
    
    var gate = RiskManager.gate(sym, posVal);
    if (!gate.ok) { if (!auto) notify(gate.reason, 'error'); return; }
    
    var cOrderId = orderId('open', sym);
    var pos = Execution.makePosition(sym, side, price, posVal, qty, sl, tp, auto, cOrderId, an ? an.score : 0, an ? an.atrPct : 0, lev);
    Runtime.openingLocks[sym] = true;
    updateSignalUI();
    try {
      if (appMode === 'live') {
        var r = await Http.post('/order', {
          symbol: sym, side: side, usdAmount: posVal, leverage: lev, sl: sl, tp: tp,
          clientOrderId: cOrderId, maxSlippageBps: CFG.slippageBps + CFG.spreadBps
        });
        if (!r || !(r.success || r.ok)) throw new Error((r && r.error) || 'Order rejected');
        pos.exchangeOrderId = r.orderId || (r.order && r.order.id) || null;
        if (r.fillPrice) pos.entry = Number(r.fillPrice);
        StateMachine.transition(pos, POSITION_STATE.OPEN);
        positions.push(pos);
        Store.save();
        await Execution.reconcile(true);
      } else {
        balance -= pos.entryFee;
        dailyPnL -= pos.entryFee;
        StateMachine.transition(pos, POSITION_STATE.OPEN);
        positions.push(pos);
        peakBal = Math.max(peakBal, balance);
        if (auto) autonomousTrades++;
        Store.save();
        logPos('OPEN ' + pos.side + ' ' + pos.pair.replace('_USDT', '') + ' @' + fp(pos.entry), 'ok');
      }
      notify((auto ? '🤖 AUTO ' : '') + side + ' ' + sym.replace('_USDT', '') + ' opened $' + posVal.toFixed(2), 'success');
      sendTelegram('🔓 OPEN\n' + sym + ' ' + side + '\nEntry: $' + fp(price) + '\nSize: $' + posVal.toFixed(2) + '\nSL: $' + fp(sl) + '\nTP: $' + fp(tp) + '\nLev: ' + lev + 'x');
      
      if (focusModeOn) {
        updateFocusUI();
        var sigEl = document.getElementById('eSig');
        if (sigEl) sigEl.textContent = '🔒 FOCUS: ' + sym.replace('_USDT', '');
      }
      
      startTracker();
    } catch(e) {
      try { StateMachine.transition(pos, POSITION_STATE.ERROR, e.message); } catch(_) {}
      notify('Open failed: ' + e.message, 'error');
      sendTelegram('❌ OPEN FAILED\n' + sym + '\n' + e.message);
    } finally {
      delete Runtime.openingLocks[sym];
      updatePosUI(); updateSignalUI();
    }
  },
  
  close: async function(id, reason) {
    var pos = positions.find(function(p) { return p.id === id; });
    
    if (!pos) {
      delete closingNow[id];
      return;
    }
    
    if (pos.state === POSITION_STATE.CLOSED) {
      delete closingNow[id];
      positions = positions.filter(function(p) { return p.id !== id; });
      return;
    }
    
    if (pos.state === POSITION_STATE.PENDING_CLOSE) {
      return;
    }
    
    try { 
      StateMachine.transition(pos, POSITION_STATE.PENDING_CLOSE); 
    } catch(e) {
      delete closingNow[id];
      positions = positions.filter(function(p) { return p.id !== id; });
      return;
    }
    
    closingNow[id] = true;
    updatePosUI();
    
    try {
      if (appMode === 'live') {
        var cid = orderId('close', pos.pair);
        var r = await Http.post('/close', {
          symbol: pos.pair, 
          side: pos.side, 
          clientOrderId: cid, 
          reason: reason || 'MANUAL'
        });
        if (!r || !(r.success || r.ok)) {
          throw new Error((r && r.error) || 'Close rejected');
        }
        var exitPrice = Number(r.fillPrice) || 
                       Number(r.trade && r.trade.exitPrice) || 
                       Number(pData[pos.pair] && pData[pos.pair].price) || 
                       pos.entry;
        var serverTrade = r.trade || null;
        Execution.finalizeClose(pos, exitPrice, reason || 'MANUAL', serverTrade);
        
        if (Runtime.capabilities.state === false) {
          if (!Runtime.posListWarnedOnce) {
            Runtime.posListWarnedOnce = true;
            logPos('[COMPAT] State endpoint unavailable', 'info');
          }
          ApiCompat.syncLegacyBalance(true).catch(function() {});
        } else {
          await Execution.reconcile(true);
        }
        notify(pos.pair.replace('_USDT', '') + ' closed', 'success');
      } else {
        var pr = Number(pData[pos.pair] && pData[pos.pair].price) || pos.entry;
        Execution.finalizeClose(pos, pr, reason || 'MANUAL', null);
      }
    } catch(e) {
      delete closingNow[id];
      try { 
        StateMachine.transition(pos, POSITION_STATE.ERROR, e.message); 
      } catch(_) { 
        pos.state = POSITION_STATE.ERROR; 
        pos.lastError = e.message; 
      }
      logPos('CLOSE FAILED ' + pos.pair + ': ' + e.message, 'err');
      notify('Close failed; position kept: ' + e.message, 'error');
      if (appMode === 'live') {
        setTimeout(function() { Execution.reconcile(true); }, 1000);
      }
    } finally {
      if (pos.state === POSITION_STATE.CLOSED) {
        delete closingNow[pos.id];
        positions = positions.filter(function(p) { return p.id !== pos.id; });
      }
      updatePosUI(); 
      updateSignalUI();
      if (!positions.length) {
        stopTracker();
      } else {
        startTracker();
      }
    }
  },
  
  closePartial: function(id, fraction, reason) {
    var pos = positions.find(function(p) { return p.id === id; });
    if (!pos || pos.state !== POSITION_STATE.OPEN) return;
    var closeQty = pos.qty * fraction;
    var remainQty = pos.qty - closeQty;
    if (remainQty < 0.001 * pos.qty) { Execution.close(id, reason); return; }
    var price = Number(pData[pos.pair] && pData[pos.pair].price) || pos.entry;
    var gross = (price - pos.entry) * (pos.side === 'LONG' ? 1 : -1) * closeQty;
    var exitFee = closeQty * price * CFG.feeRate;
    var net = gross - exitFee;
    pos.qty = remainQty;
    pos.posVal = remainQty * pos.entry;
    var partialEntryFee = pos.entryFee * fraction;
    pos.entryFee = pos.entryFee * (1 - fraction);
    trades.push({
      pair: pos.pair, side: pos.side, pnl: net, gross: gross,
      entryFee: partialEntryFee, exitFee: exitFee, reason: reason + ' (partial)',
      entry: pos.entry, exit: price, openedAt: pos.openTime, closedAt: Date.now(),
      score: pos.score || 0, entryAtr: pos.entryAtr || 0
    });
    balance += net;
    dailyPnL += net;
    peakBal = Math.max(peakBal, balance);
    if (net > 0) { winStreak++; loseStreak = 0; } else { loseStreak++; winStreak = 0; }
    logPos('PARTIAL CLOSE: ' + pos.pair + ' ' + (fraction * 100) + '% closed', 'ok');
    Store.save();
    updatePosUI();
    updateBalUI();
    updateWRStrip();
  },
  
  finalizeClose: function(pos, exitPrice, reason, serverTrade) {
    var br = Accounting.closeBreakdown(pos, exitPrice, 0);
    var net = (serverTrade && Number.isFinite(Number(serverTrade.net))) ? Number(serverTrade.net) : br.tradeNet;
    
    try { 
      StateMachine.transition(pos, POSITION_STATE.CLOSED); 
    } catch(_) { 
      pos.state = POSITION_STATE.CLOSED; 
    }
    
    positions = positions.filter(function(p) { return p.id !== pos.id; });
    delete closingNow[pos.id];
    
    balance = Number(balance) + Number(pos.posVal || 0) + net;
    if (!isFinite(balance)) balance = START_BAL;
    dailyPnL += net;
    peakBal = Math.max(peakBal, balance);
    
    var pnlText = (net >= 0 ? '+' : '') + '$' + net.toFixed(4);
    var emoji = net >= 0 ? '✅' : '❌';
    
    if (net > 0) { winStreak++; loseStreak = 0; } else { loseStreak++; winStreak = 0; }
    
    trades.push({
      pair: pos.pair, side: pos.side, pnl: net, gross: br.gross,
      entryFee: br.entryFee, exitFee: br.exitFee, reason: reason + (pos.auto ? ' (AUTO)' : ''),
      entry: pos.entry, exit: exitPrice, openedAt: pos.openTime, closedAt: Date.now(),
      score: pos.score || 0, entryAtr: pos.entryAtr || 0
    });
    
    equityHistory.push(balance);
    if (equityHistory.length > 500) equityHistory.shift();
    if (/TAKE PROFIT|STOP LOSS|TRAILING/.test(reason)) tpSlHits++;
    
    logPos('CLOSE: ' + pos.pair.replace('_USDT', '') + ' ' + reason + ' ' + pnlText, net >= 0 ? 'ok' : 'err');
    sendTelegram(emoji + ' CLOSE\n' + pos.pair + ' ' + reason + '\nPnL: ' + pnlText + '\nBalance: $' + balance.toFixed(2));
    
    if (/TAKE PROFIT|STOP LOSS|TRAILING/.test(reason)) {
      notify(reason + ' — ' + pos.pair.replace('_USDT', '') + ' ' + pnlText, net >= 0 ? 'success' : 'error');
    }
    
    if (focusModeOn) {
      updateFocusUI();
      if (positions.length === 0) {
        var sigEl = document.getElementById('eSig');
        if (sigEl) sigEl.textContent = 'Scanning...';
      }
    }
    
    RiskManager.enforce();
    Store.save();
    
    if (!positions.length) {
      stopTracker();
    }
    
    updatePosUI(); 
    updateSignalUI(); 
    updateWRStrip(); 
    updateBalUI(); 
    drawEquity();
  },
  
  sweepStuck: function() {
    var now = Date.now();
    positions = positions.filter(function(pos) {
      if (pos.state === POSITION_STATE.CLOSED) {
        delete closingNow[pos.id];
        return false;
      }
      var stuck = (pos.state === POSITION_STATE.PENDING_CLOSE || pos.state === POSITION_STATE.ERROR) &&
                  (now - (pos.stateUpdatedAt || 0) > 8000);
      if (stuck) {
        delete closingNow[pos.id];
        log('[SWEEP] Removed stuck: ' + pos.pair, 'err');
        return false;
      }
      return true;
    });
  },
  
  reconcile: async function(force) {
    if (appMode !== 'live' || !WORKER || Runtime.liveReconcileBusy) return;
    if (!force && Date.now() - Runtime.lastReconcileAt < CFG.reconcileMs) return;
    Runtime.liveReconcileBusy = true;
    try {
      if (Runtime.capabilities.state === false) {
        return await ApiCompat.syncLegacyBalance(force);
      }
      try {
        var r = await Http.get('/state');
        if (!r || !r.success) throw new Error((r && r.error) || 'State unavailable');
        Runtime.capabilities.state = true;
        Execution.reconcilePayload(r);
        return r;
      } catch(e) {
        if (isNotFound(e)) { Runtime.capabilities.state = false; return await ApiCompat.syncLegacyBalance(force); }
        throw e;
      }
    } catch(e) {
      log('[RECONCILE] ' + e.message, 'err');
    } finally { Runtime.liveReconcileBusy = false; }
  },
  
  reconcilePayload: function(payload) {
    if (!payload) return;
    var reconciledBalance = ApiCompat.extractBalance(payload);
    if (Number.isFinite(reconciledBalance)) { futBal = reconciledBalance; balance = futBal; peakBal = Math.max(peakBal, balance); }
    if (Array.isArray(payload.positions)) {
      var next = [];
      payload.positions.filter(function(p) { return Math.abs(Number(p.size || p.qty || 0)) > 0; }).forEach(function(sp) {
        var sym = sp.symbol || sp.contract;
        var old = positions.find(function(x) { return x.pair === sym && x.state !== POSITION_STATE.CLOSED; });
        if (old) {
          old.entry = Number(sp.entryPrice || sp.entry_price || old.entry);
          old.qty = Math.abs(Number(sp.qty || sp.baseQty || old.qty));
          old.posVal = Math.abs(Number(sp.notional || sp.value || old.posVal));
          var serverSL = Number(sp.sl), localSL = Number(old.sl);
          if (Number.isFinite(serverSL) && serverSL > 0) {
            if (old.trailActive && Number.isFinite(localSL) && localSL > 0) {
              old.sl = old.side === 'LONG' ? Math.max(localSL, serverSL) : Math.min(localSL, serverSL);
            } else old.sl = serverSL;
          }
          var serverTP = Number(sp.tp);
          if (Number.isFinite(serverTP) && serverTP > 0) old.tp = serverTP;
          old.state = POSITION_STATE.OPEN; old.lastError = '';
          next.push(old);
        } else next.push(Execution.normalizeServerPosition(sp));
      });
      positions = next;
    }
    Runtime.lastReconcileAt = Date.now();
    Store.save(); updatePosUI(); updateBalUI();
  },
  
  normalizeServerPosition: function(p) {
    var side = p.side || (Number(p.size) >= 0 ? 'LONG' : 'SHORT');
    return {
      id: p.localId || posId++, pair: p.symbol || p.contract, side: side,
      entry: Number(p.entryPrice || p.entry_price), qty: Math.abs(Number(p.qty || p.baseQty || 0)),
      posVal: Math.abs(Number(p.notional || p.value || 0)), sl: Number(p.sl || 0), tp: Number(p.tp || 0),
      initialSL: Number(p.sl || 0), initialTP: Number(p.tp || 0), feeRate: CFG.feeRate,
      entryFee: Number(p.entryFee || 0), openTime: Number(p.openTime || Date.now()), highPnl: 0,
      trailActive: !!p.trailActive, state: POSITION_STATE.OPEN, stateUpdatedAt: Date.now(),
      clientOrderId: p.clientOrderId || '', exchangeOrderId: p.orderId || '', serverManaged: true,
      score: p.score || 0, entryAtr: p.entryAtr || 0, leverage: p.leverage || 1,
      lastWeaknessCheck: 0
    };
  }
};
