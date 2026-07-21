/* ============================================================
   SPOT MODE — v8.2
   ─────────────────────────────────────────────────────────────
   FUTURES/SPOT piyasa modu anahtari + kullanicinin Pine Script'i
   "Trend & Swing Signal Suite w/ Auto-Fib" (v5) sinyal mantiginin
   birebir portu.

   Pine kaynagi (ilgili bolum):
     sLen = max(1, round(shortLen * lenMult))   // 9  × mult
     mLen = max(1, round(midLen   * lenMult))   // 21 × mult
     lLen = max(1, round(longLen  * lenMult))   // 55 × mult
     emaS = ta.ema(close, sLen)
     emaM = ta.ema(close, mLen)
     emaL = ta.ema(close, lLen)
     trendUp   = emaS > emaM and emaM > emaL
     trendDown = emaS < emaM and emaM < emaL
     buyCond   = ta.crossover(emaS, emaM)  and trendUp
     sellCond  = ta.crossunder(emaS, emaM) and trendDown

   Pine semantigi korunuyor:
   - ta.crossover(a,b)  => a[1] <= b[1] AND a[0] > b[0]
   - ta.crossunder(a,b) => a[1] >= b[1] AND a[0] < b[0]
   - trendUp/trendDown SINYAL BARININ kendi degerleriyle olculur
     (Pine'daki gibi: cross ani + tam yigin hizasi ayni barda).
   - Sinyaller yalnizca KAPANMIS mumlarda degerlendirilir (repaint
     yok; codebase'in closedCandles() konvansiyonuyla ayni).
   - Ayni bar'da sinyal bir kez islenir (barState kilidi) — Pine'in
     "bar close'da bir kez tetiklenir" davranisinin karsiligi.

   Porta ALINMAYANLAR (grafik gorseli / canli emre uygun degil):
   - Swing AL/SAT: ta.pivothigh/low(swingLen) pivotlari ancak
     swingLen bar SONRA kesinlesir; gercek zamanli emir tetiklemek
     icin kullanilamaz (gecmise bakan etiket/backtest ogesidir).
   - Auto-Fib seviyeleri ve backtest tablosu: overlay gorselleri.

   SPOT'ta SHORT yoktur: buyCond = AL (USDT -> coin), sellCond /
   SL / TP = SAT (coin -> USDT; worker /spot/close tum eldeki
   miktari satar). Kaldirac her zaman 1x.
   ============================================================ */

/* v8.2 FIX: spotAnalyze WAIT durumlarinda failReason/rrActual hic
   set etmiyordu. updateSignalUI()'daki meta satiri
   "an.rrActual != null" kosuluna bagli oldugu icin sinyal GERCEKTEN
   ateslense bile alt yazi hep "Awaiting signal..." gosteriyordu —
   kullaniciya "sinyal yok gibi" hissi veren asil sebep buydu.
   Ayrica coin skor tablosundaki "reason" alani her zaman sabit
   'EMA_STACK' gosteriyordu, WAIT sebebini (veri yetersiz mi, cross
   var ama trend filtresi mi tutmadi) hic ayirt etmiyordu. */

/* ── Pine port: crossover / crossunder ── */
function pineCrossover(fastArr, slowArr) {
  var n = fastArr.length - 1;
  if (n < 1) return false;
  var f0 = fastArr[n], f1 = fastArr[n - 1];
  var s0 = slowArr[n], s1 = slowArr[n - 1];
  if (f0 == null || f1 == null || s0 == null || s1 == null) return false;
  return f1 <= s1 && f0 > s0;
}
function pineCrossunder(fastArr, slowArr) {
  var n = fastArr.length - 1;
  if (n < 1) return false;
  var f0 = fastArr[n], f1 = fastArr[n - 1];
  var s0 = slowArr[n], s1 = slowArr[n - 1];
  if (f0 == null || f1 == null || s0 == null || s1 == null) return false;
  return f1 >= s1 && f0 < s0;
}

/* Pine: sLen = math.max(1, int(math.round(shortLen * lenMult))) */
function spotEffLengths() {
  var m = num(SPOT_CFG.lenMult, 1) || 1;
  return {
    s: Math.max(1, Math.round(num(SPOT_CFG.emaShort, 9)  * m)),
    m: Math.max(1, Math.round(num(SPOT_CFG.emaMid,  21)  * m)),
    l: Math.max(1, Math.round(num(SPOT_CFG.emaLong, 55)  * m))
  };
}

/* ── SPOT sinyal analizi (futures analyze()'in spot karsiligi) ──
   pData[sym].an ile ayni sekle sahip bir obje doner ki mevcut UI
   (sinyal karti, skor tablosu, engine) degisiklik olmadan calissin. */
function spotAnalyze(sym) {
  var pd = pData[sym];
  var L = spotEffLengths();
  var base = {
    pair: sym, price: pd ? Number(pd.price) : 0, signal: 'WAIT', exitNow: false,
    score: 0, tier: 'C', strategy: 'EMA_STACK', reasons: [], vr: 1, adx: 20,
    sl: 0, tp: 0, posVal: 0, leverage: 1, atrPct: 0, rrActual: null, failReason: null,
    trendUp: false, trendDown: false,
    emaS: null, emaM: null, emaL: null, barT: 0, lens: L
  };
  if (!pd) { base.failReason = 'NO_DATA'; return base; }

  var tfKey = SPOT_CFG.tf === '15m' ? 'kl15m' : SPOT_CFG.tf === '1h' ? 'kl1h' : 'kl5m';
  var kl = pd[tfKey] || pd.kl5m || [];
  var need = Math.max(L.l + 2, 30);
  if (kl.length < need) {
    base.reasons.push('DATA<' + need);
    base.failReason = 'DATA_WARMUP (' + kl.length + '/' + need + ')';
    return base;
  }

  // Pine: sigSource varsayilani close
  var closes = kl.map(function(k) { return k.c; });
  var emaS = calcEMA(closes, L.s);
  var emaM = calcEMA(closes, L.m);
  var emaL = calcEMA(closes, L.l);
  var n = closes.length - 1;
  var lastBar = kl[kl.length - 1];
  var price = Number(pd.price) || lastBar.c;

  base.price = price;
  base.barT = lastBar.t;
  base.emaS = emaS[n]; base.emaM = emaM[n]; base.emaL = emaL[n];
  base.gapSM = (base.emaS != null && base.emaM != null && price > 0)
    ? ((base.emaS - base.emaM) / price * 100) : null;
  base.gapML = (base.emaM != null && base.emaL != null && price > 0)
    ? ((base.emaM - base.emaL) / price * 100) : null;
  base.adx = calcADX(kl, 14);
  base.vr = calcVolRatio(kl);
  var atr = calcATR(kl, 14);
  base.atrPct = price > 0 ? (atr / price) * 100 : 0;

  if (base.emaS == null || base.emaM == null || base.emaL == null) {
    base.reasons.push('EMA_NULL');
    base.failReason = 'EMA_WARMUP';
    return base;
  }

  // Pine: trendUp / trendDown (sinyal barinin degerleri)
  var trendUp   = base.emaS > base.emaM && base.emaM > base.emaL;
  var trendDown = base.emaS < base.emaM && base.emaM < base.emaL;
  base.trendUp = trendUp; base.trendDown = trendDown;

  var crossUp = pineCrossover(emaS, emaM);
  var crossDn = pineCrossunder(emaS, emaM);

  // Pine: buyCond / sellCond
  var buyCond  = crossUp && trendUp;
  var sellCond = crossDn && trendDown;

  if (sellCond) {
    base.exitNow = true;
    base.reasons.push('S↓M+STACK↓ (' + L.s + '/' + L.m + '/' + L.l + ')');
  } else if (crossDn && !trendDown) {
    // Bilgi amacli: cross var ama yigin hizasi yok -> Pine'da sinyal YOK
    base.reasons.push('S↓M ama L filtresi tutmadı');
  }

  if (buyCond) {
    base.signal = 'LONG'; // spot'ta LONG == BUY
    base.reasons.push('S↑M+STACK↑ (' + L.s + '/' + L.m + '/' + L.l + ')');
    // Skor: buyCond kesinligi taban + trend gucu (ADX) + hacim katkisi.
    var score = 60; // yigin filtresi jenerik cross'tan daha secici -> taban yuksek
    if (base.adx >= 25) { score += 12; base.reasons.push('ADX' + Math.round(base.adx)); }
    else if (base.adx >= 20) { score += 6; }
    if (base.vr >= 1.2) { score += 10; base.reasons.push('VOL×' + base.vr.toFixed(1)); }
    var slopeVal = emaSlope(emaL, 4); // uzun EMA egimi yukariysa ekstra guven
    if (slopeVal > 0) { score += 8; base.reasons.push('L-SLOPE+'); }
    base.score = Math.min(95, Math.round(score));
    base.tier = tierOf(base.score);

    base.posVal = maxPosSize > 0 ? maxPosSize : Math.max(MIN_POS_VAL, num(SPOT_CFG.buyUsd, 10));
    base.sl = price * (1 - num(SPOT_CFG.slPct, 1.5) / 100);
    base.tp = price * (1 + num(SPOT_CFG.tpPct, 3.0) / 100);
    // v8.2 FIX: rrActual artik her zaman set ediliyor ki updateSignalUI()
    // meta satirini dogru dalda gostersin (asil bug buradaydi).
    base.rrActual = num(SPOT_CFG.tpPct, 3) / Math.max(0.0001, num(SPOT_CFG.slPct, 1.5));
  } else if (crossUp && !trendUp) {
    base.reasons.push('S↑M ama L filtresi tutmadı');
  }

  // v8.2 FIX: WAIT durumunda da anlamli bir failReason birak (skor
  // tablosunda "EMA_STACK" yerine gercek durum gorunsun).
  if (base.signal === 'WAIT' && !base.failReason) {
    base.failReason = base.reasons.length ? base.reasons[base.reasons.length - 1]
      : (trendUp ? 'TREND_UP_NO_CROSS' : trendDown ? 'TREND_DOWN_NO_CROSS' : 'NO_TREND');
  }
  return base;
}

/* ── SpotEngine: veri, bakiye, emir ve engine dongusu ── */
var SpotEngine = {
  barState: {},    // 'buy:PAIR' / 'exit:PAIR' -> son islenen bar timestamp'i
  holdings: [],
  _lastBalSync: 0,

  /* Canli spot piyasa verisi: /spot/price + /spot/klines.
     Futures /snapshot'in spot karsiligi worker'da yok; pair basina
     paralel cekiyoruz. Worker /spot/klines'i zaten [t,o,h,l,c,v]
     sirasina normalize edip t'yi ms'e cevirmis durumda. */
  fetchMarket: async function() {
    if (!WORKER) return;
    var okCount = 0;
    var specs = [
      {tf: '5m',  limit: 200, key: 'kl5m'},
      {tf: '15m', limit: 120, key: 'kl15m'},
      {tf: '1h',  limit: 80,  key: 'kl1h'}
    ];
    await Promise.all(pairs.map(async function(sym) {
      if (!pData[sym]) pData[sym] = {};
      var priceOk = false, candleOk = false;
      try {
        var d = await Http.get('/spot/price?symbol=' + encodeURIComponent(sym));
        var src = d && (d.data || d);
        var pr = Number(src && (src.lastPrice != null ? src.lastPrice : src.price));
        if (pr > 0) {
          prevPx[sym] = pData[sym].price || pr;
          pData[sym].price = pr;
          if (!pxState[sym]) pxState[sym] = {price: pr, vel: 0};
          pxState[sym].price = pr;
          priceOk = true;
        }
      } catch(e) {}
      await Promise.all(specs.map(async function(s) {
        try {
          var d = await Http.get('/spot/klines?symbol=' + encodeURIComponent(sym) + '&interval=' + s.tf + '&limit=' + s.limit);
          var rows = d && (Array.isArray(d.data) ? d.data : null);
          if (rows && rows.length) {
            pData[sym][s.key] = closedCandles(rows.map(ApiCompat.normalizeCandle).filter(function(k) { return k.t && k.c; }), s.tf, Date.now());
            if (pData[sym][s.key].length > 0) candleOk = true;
          }
        } catch(e) {}
      }));
      if (priceOk || candleOk) {
        pData[sym].dataUpdatedAt = Date.now();
        pData[sym].source = candleOk ? 'live-spot' : 'live-nocandles';
        okCount++;
      }
    }));
    if (okCount === 0) throw new Error('Spot verisi alınamadı');
    analyzeAll();
    return {success: true, spot: true, count: okCount};
  },

  /* Acik spot pozisyonlarin fiyatini hizli tazele (tracker icin). */
  refreshOpenPrices: function(symbols) {
    return Promise.all(symbols.map(function(sym) {
      return Http.request(WORKER + '/spot/price?symbol=' + encodeURIComponent(sym), {}, 1800)
        .then(function(d) {
          var raw = d && d.data ? d.data : (d || {});
          var price = Number(raw.lastPrice || raw.price);
          if (!Number.isFinite(price) || price <= 0) return false;
          if (!pData[sym]) pData[sym] = {};
          prevPx[sym] = Number(pData[sym].price) || price;
          pData[sym].price = price;
          pData[sym].priceUpdatedAt = Date.now();
          pData[sym].dataUpdatedAt = Date.now();
          pData[sym].source = 'live-spot';
          return true;
        })
        .catch(function() { return false; });
    }));
  },

  /* /spot/balance: USDT bakiyesi + eldeki coin'ler.
     Ayrica dis mudahale senkronu: yerelde OPEN gorunen bir spot
     pozisyonun base coin'i cuzdanda artik yoksa (kullanici borsadan
     elle satmistir), pozisyonu mevcut fiyattan kapali sayariz —
     futures'taki EXCHANGE_CLOSED auto-resolve'un spot karsiligi. */
  syncBalance: async function(force) {
    if (appMode !== 'live' || !WORKER) return;
    var now = Date.now();
    if (!force && now - SpotEngine._lastBalSync < 2500) return {success: true, skipped: true};
    SpotEngine._lastBalSync = now;
    var d = await Http.get('/spot/balance');
    if (!d || d.success === false) throw new Error((d && d.error) || 'Spot balance failed');
    var usdt = Number(d.balance);
    if (Number.isFinite(usdt)) {
      futBal = usdt; balance = usdt;
      peakBal = Math.max(peakBal, balance);
    }
    SpotEngine.holdings = Array.isArray(d.holdings) ? d.holdings : [];
    SpotEngine.renderHoldings();

    positions.filter(function(p) { return p.market === 'SPOT' && p.state === POSITION_STATE.OPEN; })
      .forEach(function(p) {
        var baseCoin = p.pair.split('_')[0];
        var h = SpotEngine.holdings.find(function(x) { return x.currency === baseCoin; });
        var have = h ? Number(h.available) + Number(h.locked || 0) : 0;
        if (have < p.qty * 0.05) { // %95'i gitmis: dis satis varsay
          var exitGuess = Number(pData[p.pair] && pData[p.pair].price) || p.entry;
          logPos('[SPOT-SYNC] ' + baseCoin + ' cüzdanda yok — pozisyon dışarıda satılmış, senkronize ediliyor', 'info');
          Execution.finalizeClose(p, exitGuess, 'EXTERNAL_SELL', null);
        }
      });

    Runtime.lastReconcileAt = Date.now();
    updateBalUI();
    return d;
  },

  renderHoldings: function() {
    var box = document.getElementById('spotHoldingsBox');
    if (!box) return;
    if (marketMode !== 'SPOT' || appMode !== 'live' || !SpotEngine.holdings.length) {
      box.style.display = 'none'; box.innerHTML = ''; return;
    }
    box.style.display = 'block';
    var parts = SpotEngine.holdings.map(function(h) {
      var amt = Number(h.available) + Number(h.locked || 0);
      var sym = h.currency + '_USDT';
      var label = h.currency + ':' + (amt >= 1 ? amt.toFixed(3) : amt.toPrecision(3));
      var tracked = positions.some(function(p) { return p.pair === sym && p.market === 'SPOT' && p.state !== POSITION_STATE.CLOSED; });
      if (tracked) {
        label += ' ✓';
      } else if (pairs.indexOf(sym) !== -1 && h.currency !== 'USDT') {
        // v8.3: bu coin cuzdanda var ama uygulama izlemiyor (elle
        // alinmis ya da eski bir pozisyon). Tikla-izle butonu ekle.
        label += ' <span style="text-decoration:underline;cursor:pointer;color:var(--acc)" onclick="adoptSpotHoldingPrompt(\'' + sym + '\')">[izle]</span>';
      }
      return label;
    });
    box.innerHTML = '💰 ' + parts.join('&nbsp;&nbsp;');
  },

  /* Engine tick'i (runEngine'in spot dali):
     1) Eldeki her spot pozisyonun pair'inde sellCond varsa SAT
        (Pine: crossunder(S,M) AND trendDown).
     2) Focus/limitler uygunsa en iyi buyCond'da AL
        (Pine: crossover(S,M) AND trendUp). */
  engineTick: function() {
    // 1) EXIT taramasi — focus modundan BAGIMSIZ (cikislar her zaman calisir)
    positions.filter(function(p) { return p.market === 'SPOT' && p.state === POSITION_STATE.OPEN; })
      .forEach(function(p) {
        var an = pData[p.pair] && pData[p.pair].an;
        if (!an || !an.exitNow || !an.barT) return;
        var key = 'exit:' + p.pair;
        if (SpotEngine.barState[key] === an.barT) return; // bu barda islendi
        SpotEngine.barState[key] = an.barT;
        logPos('[SELL] ' + p.pair.replace('_USDT','') + ' sellCond (S↓M + stack↓) — satılıyor', 'info');
        Execution.close(p.id, 'SELL_SIGNAL');
      });

    var sigEl = document.getElementById('eSig');

    // 2) ENTRY taramasi
    if (focusModeOn && positions.length > 0) {
      if (sigEl) {
        sigEl.textContent = '🔒 FOCUS: ' + positions.map(function(p) { return p.pair.replace('_USDT',''); }).join(',');
        sigEl.style.color = 'var(--warn)';
      }
      return;
    }
    var best = null, bestScore = -1;
    for (var i = 0; i < pairs.length; i++) {
      var s = pairs[i];
      var an = pData[s] && pData[s].an;
      if (!an || an.signal !== 'LONG' || an.score < minScore) continue;
      if (SpotEngine.barState['buy:' + s] === an.barT) continue; // ayni barda tekrar alma
      if (positions.some(function(p) { return p.pair === s && p.state !== POSITION_STATE.CLOSED; })) continue;
      if (an.score > bestScore) { bestScore = an.score; best = {sym: s, an: an}; }
    }
    if (sigEl) sigEl.style.color = 'var(--acc)';
    if (!best) {
      if (sigEl) {
        var L = spotEffLengths();
        sigEl.textContent = 'Scanning (EMA ' + L.s + '/' + L.m + '/' + L.l + ')...';
      }
      return;
    }
    if (sigEl) sigEl.textContent = best.sym.replace('_USDT','') + ' BUY (' + best.an.score + '%)';

    if (autonomousMode && autoTrade && positions.length < 4) {
      SpotEngine.barState['buy:' + best.sym] = best.an.barT;
      Execution.open(best.sym, 'LONG', true);
    }
    updateAutoStats();
  },

  /* Manuel SELL: currentPair icin yerel pozisyon varsa kapat;
     yoksa (canlida) cuzdandaki coin'i dogrudan /spot/close ile sat. */
  sellCurrent: async function() {
    var pos = positions.find(function(p) { return p.pair === currentPair && p.state !== POSITION_STATE.CLOSED; });
    if (pos) { Execution.close(pos.id, 'MANUAL_SELL'); return; }
    if (appMode !== 'live' || !WORKER) { notify('Satılacak pozisyon yok', 'error'); return; }
    try {
      var r = await Http.post('/spot/close', {symbol: currentPair});
      if (!r || !r.success) throw new Error((r && r.error) || 'Satış reddedildi');
      var got = Number(r.filledQuote) || 0;
      notify(currentPair.replace('_USDT','') + ' satıldı' + (got ? ' (+$' + got.toFixed(2) + ')' : ''), 'success');
      sendTelegram('💱 SPOT SELL\n' + currentPair + (r.fillPrice ? '\nFiyat: $' + fp(Number(r.fillPrice)) : ''));
      SpotEngine.syncBalance(true).catch(function() {});
    } catch(e) {
      notify('Satış hatası: ' + e.message, 'error');
    }
  }
};

/* ── Mod anahtari (FUTURES/SPOT) ── */
function setMarketMode(mode) {
  mode = mode === 'SPOT' ? 'SPOT' : 'FUTURES';
  if (mode === marketMode) { applyMarketModeUI(); return; }
  var openPos = positions.filter(function(p) { return p.state !== POSITION_STATE.CLOSED; });
  if (openPos.length) { notify('Önce açık pozisyonları kapatın (' + openPos.length + ' açık)', 'error'); return; }
  if (mode === 'SPOT' && appMode === 'live' && Runtime.capabilities.spot === false) {
    notify('Bağlı worker SPOT desteklemiyor (v17.0+ gerekli)', 'error'); return;
  }
  marketMode = mode;
  SpotEngine.barState = {};
  saveMarketMode();
  applyMarketModeUI();
  analyzeAll();
  updateSignalUI(); updateCoinScoreTable();
  var L = spotEffLengths();
  log('[MODE] Piyasa modu: ' + marketMode + (marketMode === 'SPOT' ? ' (Pine EMA stack ' + L.s + '/' + L.m + '/' + L.l + ', 1x, long-only)' : ''), 'ok');
  notify('Mod: ' + marketMode, 'success');
  if (appMode === 'live') {
    if (marketMode === 'SPOT') SpotEngine.syncBalance(true).catch(function(e) { notify('Spot bakiye: ' + e.message, 'error'); });
    else Execution.reconcile(true);
    MarketData.fetchLive().catch(function() {});
  }
}

function applyMarketModeUI() {
  var isSpot = marketMode === 'SPOT';
  var bF = document.getElementById('btnModeFut');
  var bS = document.getElementById('btnModeSpot');
  if (bF) bF.className = 'btn btn-sm ' + (isSpot ? 'btn-out' : 'btn-gold');
  if (bS) bS.className = 'btn btn-sm ' + (isSpot ? 'btn-gold' : 'btn-out');
  var bdg = document.getElementById('bdgMarket');
  if (bdg) { bdg.textContent = isSpot ? 'SPOT' : 'FUT'; bdg.className = 'bdg' + (isSpot ? ' gold' : ''); }
  var btnL = document.getElementById('btnL');
  var btnS = document.getElementById('btnS');
  if (btnL) btnL.textContent = isSpot ? 'BUY' : 'LONG';
  if (btnS) btnS.textContent = isSpot ? 'SELL' : 'SHORT';
  var note = document.getElementById('manNote');
  if (note) note.textContent = isSpot ? 'SPOT: BUY alır, SELL eldeki coini satar (1x, short yok)' : 'Emergency only';
  var lev = document.getElementById('showLev');
  if (lev) lev.textContent = isSpot ? '1x (SPOT)' : 'Auto';
  var spotCfgCard = document.getElementById('spotCfgCard');
  if (spotCfgCard) spotCfgCard.style.display = isSpot ? 'block' : 'none';
  SpotEngine.renderHoldings();
}

function readSpotSettings() {
  function gv(id, fb, lo, hi) {
    var e = document.getElementById(id); if (!e) return fb;
    var n = num(e.value, fb); return clampNum(n, lo, hi);
  }
  // Pine input siniri yok ama mantiksal sira: short < mid < long
  var s = Math.round(gv('spotEmaShort', 9,  1, 200));
  var m = Math.round(gv('spotEmaMid',  21,  2, 400));
  var l = Math.round(gv('spotEmaLong', 55,  3, 600));
  if (!(s < m && m < l)) {
    notify('EMA sırası short < mid < long olmalı', 'error');
    if (m <= s) m = s + 1;
    if (l <= m) l = m + 1;
    var em = document.getElementById('spotEmaMid');  if (em) em.value = m;
    var el = document.getElementById('spotEmaLong'); if (el) el.value = l;
  }
  SPOT_CFG.emaShort = s;
  SPOT_CFG.emaMid = m;
  SPOT_CFG.emaLong = l;
  SPOT_CFG.lenMult = gv('spotLenMult', 1.0, 0.1, 10);
  SPOT_CFG.slPct  = gv('spotSlPct', 1.5, 0.1, 50);
  SPOT_CFG.tpPct  = gv('spotTpPct', 3.0, 0.1, 200);
  SPOT_CFG.buyUsd = gv('spotBuyUsd', 10, 0.1, 100000);
  var tfEl = document.getElementById('spotTf');
  if (tfEl && ['5m','15m','1h'].indexOf(tfEl.value) !== -1) SPOT_CFG.tf = tfEl.value;
  SpotEngine.barState = {};
  saveMarketMode();
  if (marketMode === 'SPOT') { analyzeAll(); updateSignalUI(); }
}

function saveMarketMode() {
  try {
    window.__apexStorage.setItem('apex-market-mode-v82', JSON.stringify({
      marketMode: marketMode, spotCfg: SPOT_CFG, updatedAt: Date.now()
    }));
  } catch(e) {}
}

function loadMarketMode() {
  try {
    var raw = window.__apexStorage.getItem('apex-market-mode-v82');
    if (!raw) return;
    var data = JSON.parse(raw);
    if (data.marketMode === 'SPOT' || data.marketMode === 'FUTURES') marketMode = data.marketMode;
    if (data.spotCfg && typeof data.spotCfg === 'object') {
      Object.keys(SPOT_CFG).forEach(function(k) {
        if (data.spotCfg[k] != null) SPOT_CFG[k] = data.spotCfg[k];
      });
    }
  } catch(e) {}
}

function bindSpotUI() {
  var ids = {spotEmaShort: SPOT_CFG.emaShort, spotEmaMid: SPOT_CFG.emaMid,
             spotEmaLong: SPOT_CFG.emaLong, spotLenMult: SPOT_CFG.lenMult,
             spotSlPct: SPOT_CFG.slPct, spotTpPct: SPOT_CFG.tpPct, spotBuyUsd: SPOT_CFG.buyUsd};
  Object.keys(ids).forEach(function(id) {
    var e = document.getElementById(id);
    if (e) { e.value = ids[id]; e.onchange = readSpotSettings; }
  });
  var tfEl = document.getElementById('spotTf');
  if (tfEl) { tfEl.value = SPOT_CFG.tf; tfEl.onchange = readSpotSettings; }
  applyMarketModeUI();
}

/* ── Mevcut (uygulama dışında alınmış) coin'i izlemeye alma ──
   Worker /spot/balance'ta gorunen ama positions[]'ta karsiligi
   olmayan bir bakiyeyi, normal bir SPOT pozisyonu gibi sisteme
   dahil eder. Bundan sonra sellCond (S↓M + trend dönüşü) ve
   SL/TP onu da normal pozisyon gibi izler/kapatir. Gercek alis
   fiyatini bilmiyoruz — kullanicidan sorulur, bos birakilirsa
   güncel fiyat entry olarak kullanilir (PnL o zaman sifirdan baslar,
   ama cikis mantigi ayni sekilde calisir). */
async function adoptSpotHoldingPrompt(sym) {
  var label = sym.replace('_USDT', '');
  var input = window.prompt(
    label + ' için gerçek alış fiyatınızı girin (bilmiyorsanız boş bırakın, güncel fiyat kullanılır):', ''
  );
  if (input === null) return; // iptal
  var entryOverride = input.trim() ? parseFloat(input.trim()) : 0;
  await adoptSpotHolding(sym, entryOverride);
}

async function adoptSpotHolding(sym, entryOverride) {
  if (positions.some(function(p) { return p.pair === sym && p.state !== POSITION_STATE.CLOSED; })) {
    notify(sym.replace('_USDT', '') + ' zaten izleniyor', 'info');
    return;
  }
  var baseCoin = sym.split('_')[0];
  var h = SpotEngine.holdings.find(function(x) { return x.currency === baseCoin; });
  var amount = h ? Number(h.available) + Number(h.locked || 0) : 0;
  if (!amount || amount <= 0) {
    notify(baseCoin + ' bakiyesi bulunamadı — önce Spot balance senkronize olsun', 'error');
    return;
  }

  var price = Number(pData[sym] && pData[sym].price);
  if (!price) {
    try { await spotFetchLiveSingle(sym); price = Number(pData[sym] && pData[sym].price); } catch(e) {}
  }
  if (!price) { notify(baseCoin + ' için fiyat alınamadı', 'error'); return; }

  var entry = (Number.isFinite(entryOverride) && entryOverride > 0) ? entryOverride : price;
  var sl = entry * (1 - num(SPOT_CFG.slPct, 1.5) / 100);
  var tp = entry * (1 + num(SPOT_CFG.tpPct, 3.0) / 100);

  var pos = Execution.makePosition(sym, 'LONG', entry, amount * entry, amount, sl, tp,
    false, orderId('adopt', sym), 0, 0, 1);
  pos.market = 'SPOT';
  pos.entryFee = 0; // zaten daha once alinmis, tekrar komisyon dusmuyoruz
  try { StateMachine.transition(pos, POSITION_STATE.OPEN); } catch(e) { pos.state = POSITION_STATE.OPEN; }
  positions.push(pos);
  Store.save();
  startTracker();
  updatePosUI(); updateSignalUI();
  logPos('[ADOPT] ' + baseCoin + ' izlemeye alındı — giriş: $' + fp(entry) + ' miktar: ' + amount.toFixed(6), 'ok');
  notify(baseCoin + ' izlemeye alındı (giriş: $' + fp(entry) + ')', 'success');
  sendTelegram('👁 İZLEMEYE ALINDI\n' + sym + '\nMiktar: ' + amount.toFixed(6) + '\nGiriş: $' + fp(entry) + '\nSL: $' + fp(sl) + '  TP: $' + fp(tp));
}

/* Tek coin icin hizli fiyat/mum cekimi — adoptSpotHolding fiyati
   bulamadiginda kullanilan yedek yol (SpotEngine.fetchMarket tum
   pairs'i birden ceker, burada sadece tek sembol gerekiyor). */
async function spotFetchLiveSingle(sym) {
  if (!WORKER) return;
  if (!pData[sym]) pData[sym] = {};
  var d = await Http.get('/spot/price?symbol=' + encodeURIComponent(sym));
  var src = d && (d.data || d);
  var pr = Number(src && (src.lastPrice != null ? src.lastPrice : src.price));
  if (pr > 0) { pData[sym].price = pr; pData[sym].dataUpdatedAt = Date.now(); }
}
