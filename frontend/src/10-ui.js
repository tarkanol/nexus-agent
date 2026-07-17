/* ============================================================
   UI - TÜM GÜNCELLEME FONKSİYONLARI
   ============================================================ */
function updateWRStrip() {
  var wins = 0, losses = 0, totalW = 0, totalL = 0;
  var returns = [];
  for (var i = 0; i < trades.length; i++) {
    if (trades[i].pnl > 0) { wins++; totalW += trades[i].pnl; }
    else { losses++; totalL += Math.abs(trades[i].pnl); }
    returns.push(trades[i].pnl / 50);
  }
  var total = wins + losses;
  var wr = total ? ((wins / total) * 100).toFixed(1) + '%' : '--%';
  
  var sharpe = '--';
  if (returns.length > 5) {
    var avg = returns.reduce(function(a, b) { return a + b; }, 0) / returns.length;
    var std = Math.sqrt(returns.reduce(function(a, b) { return a + (b - avg) * (b - avg); }, 0) / returns.length);
    if (std > 0) sharpe = (avg / std).toFixed(2);
  }
  
  document.getElementById('wrWinRate').textContent = wr;
  document.getElementById('wrWL').textContent = wins + '/' + losses;
  document.getElementById('wrSharpe').textContent = sharpe;
  
  var streakTxt = winStreak > 0 ? winStreak + 'W' : loseStreak > 0 ? loseStreak + 'L' : '--';
  var streakEl = document.getElementById('wrStreak');
  if (streakEl) { streakEl.textContent = streakTxt; streakEl.className = 'wr-val ' + (winStreak > 0 ? 'pos' : loseStreak > 0 ? 'neg' : ''); }
  
  var stWR = document.getElementById('stWR'); if (stWR) stWR.textContent = wr;
  var bdg = document.getElementById('bdgStreak');
  if (bdg) { if (winStreak >= 3) { bdg.style.display = 'inline-block'; bdg.textContent = '🔥' + winStreak; } else bdg.style.display = 'none'; }
  var banner = document.getElementById('bannerStreak');
  if (banner) banner.style.display = (winStreak >= 3) ? 'block' : 'none';
}

function updateBalUI() {
  var bal = (appMode === 'live' && futBal !== null) ? Number(futBal) : Number(balance);
  if (isNaN(bal)) { bal = START_BAL; balance = START_BAL; }
  var pct = (bal - START_BAL) / START_BAL * 100;
  document.getElementById('balNum').textContent = '$' + bal.toFixed(2);
  document.getElementById('balDay').textContent = 'DAY: ' + (dailyPnL >= 0 ? '+' : '') + '$' + dailyPnL.toFixed(2);
  document.getElementById('balDay').style.color = dailyPnL >= 0 ? 'var(--long)' : 'var(--short)';
  var pctEl = document.getElementById('balPct');
  pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  pctEl.className = 'bal-pct ' + (pct >= 0 ? 'up' : 'dn');
  document.getElementById('progFill').style.width = Math.max(0, Math.min(100, (bal - START_BAL) / (100 - START_BAL) * 100)) + '%';
  document.getElementById('bdgPos').textContent = positions.length + '/4';
  document.getElementById('stBal').textContent = '$' + bal.toFixed(2);
  document.getElementById('stDay').textContent = (dailyPnL >= 0 ? '+' : '') + '$' + dailyPnL.toFixed(2);
  document.getElementById('stDay').style.color = dailyPnL >= 0 ? 'var(--long)' : 'var(--short)';
  document.getElementById('showRisk').textContent = 'Dynamic';
  document.getElementById('showTP').textContent = 'ATR';
  document.getElementById('showLev').textContent = 'Auto';
  renderRiskStatus();
  updateAutoStats();
}

function renderRiskStatus() {
  var k = document.getElementById('safeKill');
  if (k) { k.textContent = 'KILL: ' + (CFG.killSwitch ? 'ON' : 'OFF'); k.style.background = CFG.killSwitch ? 'rgba(255,51,85,.18)' : 'transparent'; }
  var s = document.getElementById('safeRiskStatus');
  if (s) s.textContent = 'PnL: ' + (dailyPnL >= 0 ? '+' : '') + '$' + dailyPnL.toFixed(2) + ' | DD: ' + RiskManager.drawdownPct().toFixed(2) + '%';
}

function setFilter(id, val) {
  var el = document.getElementById(id); if (!el) return;
  el.textContent = val || '--';
  var cls = 'filter-val';
  var v = String(val || '');
  if (v.indexOf('FAIL') >= 0 || v === '--' || v === 'WAIT') cls += ' fail';
  else if (v.indexOf('OK') >= 0 || v.indexOf('ALIGN') >= 0 || parseFloat(v) > 0) cls += ' pass';
  else cls += ' warn';
  el.className = cls;
}

function sInd(id, val, cls) { var el = document.getElementById(id); if (el) { el.textContent = val; el.className = 'ind-val ' + (cls || 'neut'); } }
function sMTF(id, val) { var el = document.getElementById(id); if (el) { el.textContent = val || '--'; el.className = 'mtf-val ' + (val || 'WAIT'); } }

function updateSignalUI() {
  updateBalUI();
  var pd = pData[currentPair], an = pd && pd.an;
  var sig = an && an.signal !== 'WAIT' ? an.signal : 'WAIT';
  
  var isStrong = an && an.tier === 'A' && an.score >= 75;
  var badgeClass = isStrong ? 'STRONG' : sig;
  document.getElementById('sigBadge').textContent = isStrong ? 'STRONG' : sig;
  document.getElementById('sigBadge').className = 'sig-badge ' + badgeClass;
  
  var ct = document.getElementById('confTier');
  if (ct) {
    if (an && an.tier) {
      ct.style.display = 'inline-block';
      ct.textContent = (isStrong ? '⭐ A+' : an.tier + '-GRADE');
      ct.className = 'conf-tier ' + an.tier;
    } else ct.style.display = 'none';
  }
  
  var meta = document.getElementById('sigMeta');
  if (meta) {
    if (marketMode === 'SPOT' && an) {
      // v8.3: SPOT modunda EMA yigininin anlik degerlerini her zaman
      // goster (sinyal WAIT olsa da) — "ne durumda oldugu" hep gorunsun.
      var emaTxt = (an.emaS != null && an.emaM != null && an.emaL != null)
        ? 'EMA' + (an.lens ? an.lens.s : '9') + ':' + fp(an.emaS) +
          '  EMA' + (an.lens ? an.lens.m : '21') + ':' + fp(an.emaM) +
          '  EMA' + (an.lens ? an.lens.l : '55') + ':' + fp(an.emaL)
        : 'EMA hesaplanıyor...';
      var trendTxt = an.trendUp ? '📈 TREND:UP' : an.trendDown ? '📉 TREND:DOWN' : '➖ TREND:FLAT';
      var stateTxt = sig !== 'WAIT'
        ? ('SCORE:' + an.score + '%  TIER:' + an.tier)
        : (an.failReason ? 'BEKLİYOR: ' + an.failReason : 'Bekleniyor...');
      meta.innerHTML = emaTxt + '<br>' + trendTxt + '  ' + stateTxt;
    } else if (an && sig !== 'WAIT' && an.rrActual != null) {
      meta.textContent = 'SCORE:' + an.score + '%  VOL:' + an.vr.toFixed(2) + 'x  RR:1:' + an.rrActual.toFixed(2) +
        '  TIER:' + an.tier + (an.leverage ? '  LEV:' + an.leverage + 'x' : '') + (an.strategy ? '  MOD:' + an.strategy : '');
    } else if (an && an.failReason) {
      meta.textContent = 'BLOCKED: ' + an.failReason;
    } else {
      meta.textContent = 'Awaiting signal...';
    }
  }
  
  var filters = an && an.filters;
  setFilter('fAtr', filters ? filters.atr : '--');
  setFilter('fVol', filters ? filters.vol : '--');
  setFilter('fTrend', filters ? filters.trend : '--');
  setFilter('fRsi', filters ? filters.rsi : '--');
  setFilter('fMacd', filters ? filters.macd : '--');
  setFilter('fAdx', filters ? filters.adx : '--');
  setFilter('fRegime', filters ? filters.regime : '--');
  setFilter('fScore', filters && filters.score ? filters.score : (an && an.score ? an.score + '%' : '--'));
  
  var sc = an ? an.score : 0;
  document.getElementById('qVal').textContent = an ? (sig !== 'WAIT' ? sc + '%' : sc + '% candidate') : '--%';
  document.getElementById('qBar').style.width = sc + '%';
  document.getElementById('qBar').style.background = sc >= 80 ? 'var(--long)' : sc >= 55 ? 'var(--warn)' : 'var(--short)';
  
  var rr = document.getElementById('reasonRow');
  if (rr && an && an.reasons && an.reasons.length) {
    var rh = '';
    for (var ri = 0; ri < an.reasons.length; ri++) {
      var r = an.reasons[ri];
      var cls = r.cls || '';
      rh += '<span class="rtag ' + cls + '">' + r.t + '</span>';
    }
    rr.innerHTML = rh;
  } else if (rr) {
    rr.innerHTML = '';
  }
  
  if (an && an.indicators) {
    var ind = an.indicators;
    sInd('iRsi5', ind.rsi5.toFixed(1), ind.rsi5 < 40 ? 'bull' : ind.rsi5 > 60 ? 'bear' : 'neut');
    sInd('iRsi15', ind.rsi15.toFixed(1), ind.rsi15 < 40 ? 'bull' : ind.rsi15 > 60 ? 'bear' : 'neut');
    sInd('iMacd', (ind.macd.hist >= 0 ? '+' : '') + ind.macd.hist.toFixed(5), ind.macd.hist > 0 ? 'bull' : 'bear');
    sInd('iEma', ind.goldenX ? 'GOLDEN_X' : ind.deathX ? 'DEATH_X' : ind.aboveEMA ? 'ABOVE' : 'BELOW', ind.goldenX ? 'bull' : ind.deathX ? 'bear' : ind.aboveEMA ? 'bull' : 'bear');
    sInd('iVol', ind.vr.toFixed(2) + 'x', ind.vr >= 1.5 ? 'bull' : ind.vr < 0.9 ? 'bear' : 'neut');
    sInd('iAdx', (ind.adx || 0).toFixed(0), (ind.adx || 0) >= 25 ? 'bull' : (ind.adx || 0) >= 15 ? 'neut' : 'bear');
    sInd('iMom', 'StRSI:' + ind.stochRsi5.toFixed(0), ind.stochRsi5 < 35 ? 'bull' : ind.stochRsi5 > 65 ? 'bear' : 'neut');
    sInd('iBb', ind.bbSqueeze ? 'SQZ' : 'NORMAL', ind.bbSqueeze ? 'warn' : 'neut');
    sInd('iAtr', '$' + fp(ind.atrVal || 0), 'neut');
  }
  if (an && an.mtf) {
    sMTF('m5', an.mtf['5m']);
    sMTF('m15', an.mtf['15m']);
    sMTF('m1h', an.mtf['1h']);
    sMTF('m4h', an.mtf['4h']);
  }
  
  var reg = an && an.regime;
  if (reg) {
    document.getElementById('bannerRegime').style.display = 'flex';
    document.getElementById('regimeLabel').textContent = '📊 REGIME';
    document.getElementById('regimeValue').textContent = reg.regime + ' | ADX:' + reg.adx.toFixed(0);
    document.getElementById('regimeValue').style.color = reg.regime === 'TRENDING' ? 'var(--long)' :
                                                         reg.regime === 'RANGING' ? 'var(--gold)' : 'var(--short)';
    document.getElementById('regTrend').textContent = reg.trend;
    document.getElementById('regTrend').className = 'regime-value ' + (reg.trend.indexOf('UP') >= 0 ? 'trend' : reg.trend.indexOf('DOWN') >= 0 ? 'volatile' : 'range');
    document.getElementById('regVol').textContent = reg.volatility;
    document.getElementById('regVol').className = 'regime-value ' + (reg.volatility === 'LOW' ? 'trend' : reg.volatility === 'HIGH' ? 'volatile' : 'range');
    document.getElementById('regAdx').textContent = reg.adx.toFixed(0);
    document.getElementById('regAdx').className = 'regime-value ' + (reg.adx >= 25 ? 'trend' : reg.adx >= 15 ? 'range' : 'volatile');
    document.getElementById('regRegime').textContent = reg.regime;
    document.getElementById('regRegime').className = 'regime-value ' + (reg.regime === 'TRENDING' ? 'trend' : reg.regime === 'RANGING' ? 'range' : 'volatile');
  } else {
    document.getElementById('bannerRegime').style.display = 'none';
  }
  
  renderPlan(an, (pd && pd.price) || DEMO_BASE[currentPair] || 1);
  
  var banPos = document.getElementById('bannerPos');
  if (banPos && !focusModeOn) {
    banPos.style.display = (positions.length > 0) ? 'block' : 'none';
    if (positions.length > 0) banPos.textContent = '⚠️ OPEN POSITION (Focus OFF)';
  }
  var deadEl = document.getElementById('bannerDead');
  if (deadEl) {
    var deadNow = isDeadHour();
    deadEl.style.display = deadNow ? 'block' : 'none';
    if (deadNow) {
      deadEl.textContent = CFG.deadHourEnabled
        ? '🔒 UTC ' + CFG.deadHourStart + '-' + CFG.deadHourEnd + ' — yeni işlem ENGELLİ'
        : '⚠️ UTC ' + CFG.deadHourStart + '-' + CFG.deadHourEnd + ' — bilgi amaçlı (engelleme kapalı)';
    }
  }
  
  var dsEl = document.getElementById('bannerDataSrc');
  if (dsEl) {
    var pdSrc = pd && pd.source;
    var goodSources = {live: 1, 'live-legacy': 1, 'live-spot': 1};
    var showWarn = appMode === 'live' && pdSrc && !goodSources[pdSrc];
    if (showWarn) { dsEl.style.display = 'block'; dsEl.textContent = '⚠️ ' + currentPair.replace('_USDT', '') + ' canlı fiyat yerine yedek veri kullanıyor (' + pdSrc + ') — LOG sekmesine bak'; }
    else dsEl.style.display = 'none';
  }
  
  var canOpen = positions.length < 4;
  document.getElementById('btnL').disabled = !canOpen;
  document.getElementById('btnS').disabled = !canOpen;
  document.getElementById('manNote').textContent = canOpen ? 'Emergency manual | Auto: ' + (autonomousMode ? 'ON' : 'OFF') : 'Max open';
  
  updateFocusUI();
}

function renderPlan(an, price) {
  var el = document.getElementById('planWrap');
  var openHere = positions.find(function(p) { return p.pair === currentPair; });
  if (openHere) {
    var pr = Number(pData[openHere.pair] && pData[openHere.pair].price) || openHere.entry;
    var pnl = (pr - openHere.entry) * (openHere.side === 'LONG' ? 1 : -1) * openHere.qty;
    el.innerHTML = '<div class="plan-box"><div class="plan-hd ' + openHere.side.toLowerCase() + '"><span>ACTIVE // ' + openHere.pair.replace('_USDT', '') + '</span><span style="font-size:7px">' + openHere.side + ' ' + (openHere.leverage || 1) + 'x</span></div><div class="plan-body"><div class="plan-row"><span class="pk">ENTRY</span><span>$' + fp(openHere.entry) + '</span></div><div class="plan-row"><span class="pk">NOW</span><span>$' + fp(pr) + '</span></div><div class="plan-row"><span class="pk">TP</span><span class="pv tp">$' + fp(openHere.tp) + '</span></div><div class="plan-row"><span class="pk">SL</span><span class="pv sl">$' + fp(openHere.sl) + '</span></div><div class="plan-row"><span class="pk">PNL</span><span style="color:' + (pnl >= 0 ? 'var(--long)' : 'var(--short)') + '">' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(4) + '</span></div></div></div>';
    return;
  }
  if (!an || !an.sl || an.signal === 'WAIT') { el.innerHTML = ''; return; }
  var s = an.signal, cls = s.toLowerCase();
  var slPct = Math.abs(price - an.sl) / price * 100, tpPct = Math.abs(an.tp - price) / price * 100;
  el.innerHTML = '<div class="plan-box"><div class="plan-hd ' + cls + '"><span>' + s + ' // ' + currentPair.replace('_USDT', '') + '</span><span style="font-size:7px">' + an.tier + '-GRADE ' + (an.strategy || '') + '</span></div><div class="plan-body"><div class="plan-row"><span class="pk">ENTRY</span><span>$' + fp(price) + '</span></div><div class="plan-row"><span class="pk">TP (+' + tpPct.toFixed(2) + '%)</span><span class="pv tp">$' + fp(an.tp) + '</span></div><div class="plan-row"><span class="pk">SL (-' + slPct.toFixed(2) + '%)</span><span class="pv sl">$' + fp(an.sl) + '</span></div><div class="plan-row"><span class="pk">R:R</span><span class="pv rr">1:' + (an.rrActual || 0).toFixed(2) + '</span></div><div class="plan-row"><span class="pk">SIZE</span><span style="color:var(--acc)">$' + an.posVal.toFixed(2) + '</span></div></div></div>';
}

function updatePairRow() {
  var html = '', i;
  for (i = 0; i < pairs.length; i++) {
    var sym = pairs[i], pd = pData[sym] || {}, p = pd.price || DEMO_BASE[sym] || 1, prev = prevPx[sym] || p;
    var an = pd.an, sig = (an && an.signal !== 'WAIT') ? an.signal : 'WAIT', sc = an && an.score ? ' ' + an.score + '%' : '';
    html += '<button class="pp ' + (sym === currentPair ? 'active' : '') + '" data-sym="' + sym + '">' +
      '<span>' + sym.replace('_USDT', '') + '</span>' +
      '<span class="pp-price" style="color:' + (p >= prev ? 'var(--long)' : 'var(--short)') + '">$' + fp(p) + '</span>' +
      '<span class="pp-sig ' + sig + '">' + sig + sc + '</span>' +
    '</button>';
  }
  document.getElementById('pairRow').innerHTML = html;
  var btns = document.querySelectorAll('.pp');
  for (i = 0; i < btns.length; i++) {
    btns[i].onclick = (function(s) { return function() { selPair(s); }; })(btns[i].getAttribute('data-sym'));
  }
}

function updateTicker() {
  var t = document.getElementById('tickerEl'), html = '', i;
  for (i = 0; i < pairs.length; i++) {
    var s = pairs[i], p = (pData[s] && pData[s].price) || DEMO_BASE[s] || 0, prev = prevPx[s] || p;
    html += '<span class="tick"><span class="tick-s">' + s.replace('_USDT', '') + '</span><span class="tick-p" style="color:' + (p >= prev ? 'var(--long)' : 'var(--short)') + '">$' + fp(p) + '</span></span>';
  }
  t.innerHTML = html;
}

function selPair(s) { currentPair = s; updatePairRow(); updateSignalUI(); drawChart(); }

function updateCoinScoreTable() {
  var el = document.getElementById('coinScoreTable'); if (!el) return;
  var sorted = pairs.slice().sort(function(a, b) {
    var sa = (pData[a] && pData[a].an && pData[a].an.score) || 0;
    var sb = (pData[b] && pData[b].an && pData[b].an.score) || 0;
    return sb - sa;
  });
  var rows = '';
  for (var i = 0; i < sorted.length; i++) {
    var sym = sorted[i], pd = pData[sym] || {}, an = pd.an || null;
    var sig = an && an.signal ? an.signal : 'WAIT';
    var sc = an ? an.score : 0;
    var price = pd.price || DEMO_BASE[sym] || 0;
    var tier = an && an.tier ? '[' + an.tier + ']' : '';
    var reason;
    if (marketMode === 'SPOT' && an) {
      // v8.3: SPOT modunda "reason" sutununda EMA yigininin anlik
      // degerlerini goster — hangi coin'in ne durumda oldugu tek
      // bakista gorulsun.
      reason = (an.emaS != null)
        ? 'S:' + fp(an.emaS) + ' M:' + fp(an.emaM) + ' L:' + fp(an.emaL) + ' ' + (an.trendUp ? '↑' : an.trendDown ? '↓' : '–')
        : (an.failReason || 'DATA_WARMUP');
    } else {
      reason = an && an.failReason ? an.failReason : (an && an.strategy ? an.strategy : '');
    }
    rows += '<div class="score-row"><span style="min-width:32px;font-size:7px">' + sym.replace('_USDT', '') + '</span><span style="color:var(--dim2);font-size:6px">$' + fp(price) + '</span><span class="signal ' + sig + '" style="min-width:32px;text-align:center">' + sig + ' ' + tier + '</span><span style="color:var(--acc);font-size:6px">' + (sc > 0 ? sc + '%' : '--') + '</span><span style="color:var(--dim2);font-size:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:right">' + reason + '</span></div>';
  }
  el.innerHTML = rows || '<div style="color:var(--dim2);padding:4px 0;font-family:var(--mono);font-size:8px">Warming...</div>';
}

function updatePosUI() {
  updateBalUI();
  var html = '', i;
  if (!positions.length) {
    html = '<div style="text-align:center;padding:14px;color:var(--dim2);font-family:var(--mono);font-size:8px">// NO OPEN POSITIONS</div>';
  } else {
    for (i = 0; i < positions.length; i++) {
      var pos = positions[i];
      var pr = (pData[pos.pair] && pData[pos.pair].price) || pos.entry;
      var pnl = (pr - pos.entry) * (pos.side === 'LONG' ? 1 : -1) * pos.qty;
      var prog = Math.min(100, Math.max(0, (pnl / (pos.entry * 0.008 * (pos.leverage || 1))) * 100));
      var pc = pnl >= 0 ? 'var(--long)' : 'var(--short)';
      var tTag = pos.trailActive ? '<span style="font-size:5px;color:var(--acc);margin-left:2px">▲T</span>' : '';
      var autoTag = pos.auto ? '<span style="font-size:5px;color:var(--long);margin-left:2px">🤖</span>' : '';
      var closing = pos.state === POSITION_STATE.PENDING_CLOSE;
      var btnLabel = closing ? 'CLOSING...' : pos.state === POSITION_STATE.ERROR ? 'RETRY' : 'CLOSE';
      html += '<div class="pos-card ' + pos.side.toLowerCase() + '">' +
        '<div class="pos-hd"><span class="pos-sym">' + pos.pair.replace('_USDT', '') + autoTag + tTag + '</span>' +
        '<span class="pos-side ' + pos.side + '">' + (pos.market === 'SPOT' ? 'SPOT BUY' : pos.side + ' ' + (pos.leverage || 1) + 'x') + '</span>' +
        '<span class="pos-pnl ' + (pnl >= 0 ? 'up' : 'dn') + '">' + (pnl >= 0 ? '+' : '') + ' $' + pnl.toFixed(4) + '</span></div>' +
        '<div class="pos-grid">' +
          '<div class="pgc"><div class="pgc-l">ENTRY</div><div class="pgc-v">' + fp(pos.entry) + '</div></div>' +
          '<div class="pgc"><div class="pgc-l">NOW</div><div class="pgc-v" style="color:' + pc + '">' + fp(pr) + '</div></div>' +
          '<div class="pgc"><div class="pgc-l">SL</div><div class="pgc-v" style="color:var(--short)">' + fp(pos.sl) + '</div></div>' +
          '<div class="pgc"><div class="pgc-l">TP</div><div class="pgc-v" style="color:var(--long)">' + fp(pos.tp) + '</div></div>' +
        '</div>' +
        '<div class="pbar-track"><div class="pbar-fill" style="width:' + prog + '%;background:' + pc + '"></div></div>' +
        (pos.lastError ? '<div class="pos-err">' + pos.lastError + '</div>' : '') +
        '<button class="btn btn-out btn-sm" ' + (closing ? 'disabled' : '') + ' onclick="closePos(' + pos.id + ',\'Manual\')">' + btnLabel + '</button>' +
      '</div>';
    }
  }
  document.getElementById('posList').innerHTML = html;
  
  var hh = '';
  for (var hi = Math.min(trades.length, 10) - 1; hi >= 0; hi--) {
    var t = trades[hi];
    hh += '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--brd);font-family:var(--mono);font-size:7px">' +
      '<span>' + t.pair.replace('_USDT', '') + ' <span style="color:var(--dim2);font-size:6px">' + t.side + '</span></span>' +
      '<span style="color:' + (t.pnl >= 0 ? 'var(--long)' : 'var(--short)') + '">' + (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(4) + '</span>' +
    '</div>';
  }
  document.getElementById('histBox').innerHTML = hh || '<div style="color:var(--dim2);font-family:var(--mono);font-size:7px">--</div>';
}
