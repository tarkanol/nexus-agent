/* ============================================================
   HTTP / API COMPAT / MARKET DATA
   ============================================================ */
var Http = {
  request: function(url, options, timeoutMs) {
    options = options || {};
    timeoutMs = timeoutMs || 10000;
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (controller) options.signal = controller.signal;
    var timer = setTimeout(function() { if (controller) controller.abort(); }, timeoutMs);
    return fetch(url, options).then(function(res) {
      return res.text().then(function(txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : {}; } catch(e) { data = {raw: txt}; }
        if (!res.ok) {
          var err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
          err.status = res.status; err.data = data; throw err;
        }
        return data;
      });
    }).finally(function() { clearTimeout(timer); });
  },
  get: function(path) { return Http.request(WORKER + path); },
  post: function(path, body) {
    return Http.request(WORKER + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
  }
};

function isNotFound(e) {
  return !!e && (e.status === 404 || /not\s*found|endpoint/i.test(String(e.message || '')));
}

var ApiCompat = {
  setLegacy: function(reason) {
    Runtime.apiMode = 'legacy';
    Runtime.capabilities.state = false;
    Runtime.capabilities.riskUpdate = false;
    Runtime.capabilities.kill = false;
    if (!Runtime.compatNotified) {
      Runtime.compatNotified = true;
      log('[COMPAT] Legacy Worker', 'info');
    }
  },
  applyPing: function(ping) {
    var f = ping && (ping.features || ping.capabilities);
    if (f) {
      Runtime.capabilities.snapshot = !!f.snapshot;
      Runtime.capabilities.state = !!(f.state || f.reconcile);
      Runtime.capabilities.riskUpdate = !!f.riskUpdate;
      Runtime.capabilities.kill = !!f.kill;
      Runtime.capabilities.spot = !!f.spot; // v17.0+ worker
      Runtime.apiMode = Runtime.capabilities.snapshot ? 'modern' : 'legacy';
      return;
    }
    Runtime.capabilities.snapshot = false;
    ApiCompat.setLegacy('no capability flags');
  },
  extractBalance: function(payload) {
    var seen = [];
    function numeric(v) {
      if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string') { var n = Number(v.replace(/,/g, '').trim()); return Number.isFinite(n) ? n : null; }
      return null;
    }
    function walk(obj, depth) {
      if (depth > 5 || obj === null || obj === undefined) return null;
      var direct = numeric(obj);
      if (direct !== null) return direct;
      if (typeof obj !== 'object') return null;
      if (seen.indexOf(obj) >= 0) return null;
      seen.push(obj);
      if (Array.isArray(obj)) {
        var usdtRow = obj.find(function(x) { return x && /^(USDT|USD)$/i.test(String(x.currency || x.asset || x.coin || x.settle || '')); });
        if (usdtRow) { var uv = walk(usdtRow, depth + 1); if (uv !== null) return uv; }
        for (var ai = 0; ai < obj.length; ai++) { var av = walk(obj[ai], depth + 1); if (av !== null) return av; }
        return null;
      }
      var priority = ['balance','total','equity','marginBalance','margin_balance','accountBalance','account_balance',
        'walletBalance','wallet_balance','available','available_balance','availableBalance','cross_available','total_available_margin','amount'];
      for (var i = 0; i < priority.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(obj, priority[i])) continue;
        var n = numeric(obj[priority[i]]);
        if (n !== null) return n;
      }
      var wrappers = ['data','result','account','wallet','futures','details','payload'];
      for (var j = 0; j < wrappers.length; j++) {
        if (!Object.prototype.hasOwnProperty.call(obj, wrappers[j])) continue;
        var w = walk(obj[wrappers[j]], depth + 1);
        if (w !== null) return w;
      }
      return null;
    }
    return walk(payload, 0);
  },
  syncLegacyBalance: async function(force) {
    var now = Date.now();
    if (!force && now - ApiCompat._lastBalSync < 2500) return {success: true, skipped: true};
    ApiCompat._lastBalSync = now;
    var d = await Http.get('/balance');
    if (d && d.success === false) throw new Error(ApiCompat.responseError(d, 'Balance request failed'));
    var b = ApiCompat.extractBalance(d);
    if (!Number.isFinite(b)) {
      Runtime.lastReconcileAt = Date.now();
      return {success: true, balanceUnavailable: true, raw: d};
    }
    futBal = b; balance = b; peakBal = Math.max(peakBal, balance);
    Runtime.lastReconcileAt = Date.now();
    updateBalUI();
    return d;
  },
  responseError: function(payload, fallback) {
    return String(payload.error || payload.message || payload.label || payload.detail || fallback || 'Worker request failed');
  },
  _lastBalSync: 0,
  statusText: function() {
    return Runtime.capabilities.snapshot !== false
      ? 'Live connection active'
      : 'Live connection active — legacy';
  },
  normalizeCandle: function(k) {
    var out;
    if (Array.isArray(k)) {
      out = {t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]};
    } else {
      var t = k.t != null ? k.t : (k.time != null ? k.time : (k.timestamp != null ? k.timestamp : k.T));
      var o = k.o != null ? k.o : (k.open != null ? k.open : k.O);
      var h = k.h != null ? k.h : (k.high != null ? k.high : k.H);
      var l = k.l != null ? k.l : (k.low != null ? k.low : k.L);
      var c = k.c != null ? k.c : (k.close != null ? k.close : k.C);
      var v = k.v != null ? k.v : (k.volume != null ? k.volume : (k.vol != null ? k.vol : k.sum));
      out = {t: +t, o: +o, h: +h, l: +l, c: +c, v: +v};
    }
    if (out.t > 0 && out.t < 1000000000000) out.t *= 1000;
    return out;
  },
  _lastBalSync: 0
};

var MarketData = {
  applySnapshot: function(snap) {
    var now = Date.now();
    Object.keys(snap.market || {}).forEach(function(sym) {
      var m = snap.market[sym];
      if (!pData[sym]) pData[sym] = {};
      var priceVal = Number(m.price != null ? m.price : (m.lastPrice != null ? m.lastPrice : m.last));
      prevPx[sym] = pData[sym].price || priceVal;
      pData[sym].price = priceVal;
      if (!pxState[sym]) pxState[sym] = {price: priceVal, vel: 0};
      pxState[sym].price = priceVal;
      var tfList = ['1m','5m','15m','1h','4h'];
      var candleOk = false;
      tfList.forEach(function(tf) {
        var key = tf === '1m' ? 'kl1m' : tf === '5m' ? 'kl5m' : tf === '15m' ? 'kl15m' : tf === '1h' ? 'kl1h' : 'kl4h';
        var raw = Array.isArray(m[tf]) ? m[tf]
          : Array.isArray(m['candles_' + tf]) ? m['candles_' + tf]
          : Array.isArray(m.klines && m.klines[tf]) ? m.klines[tf]
          : Array.isArray(m.candles && m.candles[tf]) ? m.candles[tf]
          : [];
        if (raw.length) {
          pData[sym][key] = closedCandles(raw.map(ApiCompat.normalizeCandle), tf, now);
          if (pData[sym][key].length > 0) candleOk = true;
        }
      });
      if (!candleOk && Number.isFinite(priceVal) && priceVal > 0) {
        DEMO_BASE[sym] = DEMO_BASE[sym] || priceVal;
        if (!pData[sym].masterKlines || pData[sym].masterKlines.length < 100) {
          pData[sym].masterKlines = seedKlines(sym, 500);
          var lastK = pData[sym].masterKlines[pData[sym].masterKlines.length - 1];
          var shift = priceVal - lastK.c;
          pData[sym].masterKlines.forEach(function(k) { k.o += shift; k.h += shift; k.l += shift; k.c += shift; });
        }
        tickFull(sym);
        pData[sym].price = priceVal;
      }
      pData[sym].dataUpdatedAt = Number(m.serverTime || snap.serverTime || now);
      pData[sym].source = candleOk ? 'live' : 'live-nocandles';
    });
    analyzeAll();
    if (snap.account) Execution.reconcilePayload(snap.account);
  },
  fetchLive: async function() {
    if (!WORKER) return;
    // v8.2: SPOT modunda /snapshot futures verisi doner; spot fiyat ve
    // mumlar /spot/price + /spot/klines'tan gelir.
    if (marketMode === 'SPOT') return SpotEngine.fetchMarket();
    if (Runtime.capabilities.snapshot !== false) {
      try {
        var qs = encodeURIComponent(pairs.join(','));
        var snap = await Http.get('/snapshot?symbols=' + qs);
        if (!snap || !snap.success || !snap.market) throw new Error('Invalid snapshot response');
        Runtime.capabilities.snapshot = true;
        MarketData.applySnapshot(snap);
        return snap;
      } catch(e) {
        if (isNotFound(e)) Runtime.capabilities.snapshot = false;
      }
    }
    return ApiCompat.fetchLegacyMarket(pairs.slice());
  },
  refreshOpenPrices: function() {
    if (appMode !== 'live' || !WORKER || !positions.length) return Promise.resolve(false);
    if (Runtime.livePriceBusy) return Promise.resolve(false);
    var now = Date.now();
    if (now - Runtime.lastLivePriceAt < CFG.livePriceMs) return Promise.resolve(false);
    
    var symbols = [];
    positions.forEach(function(p) { if (p && p.pair && symbols.indexOf(p.pair) === -1) symbols.push(p.pair); });
    if (!symbols.length) return Promise.resolve(false);
    
    Runtime.livePriceBusy = true;
    Runtime.lastLivePriceAt = now;
    
    function applyPrice(sym, value) {
      var price = Number(value);
      if (!Number.isFinite(price) || price <= 0) return false;
      if (!pData[sym]) pData[sym] = {};
      prevPx[sym] = Number(pData[sym].price) || price;
      pData[sym].price = price;
      pData[sym].priceUpdatedAt = Date.now();
      pData[sym].dataUpdatedAt = Date.now();
      pData[sym].source = 'live';
      return true;
    }
    function legacyPrices() {
      return Promise.all(symbols.map(function(sym) {
        return Http.request(WORKER + '/price?symbol=' + encodeURIComponent(sym), {}, 1800)
          .then(function(d) {
            var raw = d && d.data ? d.data : (d || {});
            return applyPrice(sym, raw.lastPrice || raw.price || raw.markPrice || raw.indexPrice);
          })
          .catch(function() { return false; });
      }));
    }
    var request;
    if (marketMode === 'SPOT') {
      // v8.2: spot icin batch endpoint yok; pair basina /spot/price.
      request = SpotEngine.refreshOpenPrices(symbols)
        .then(function(results) { return results.some(Boolean); });
    } else if (Runtime.capabilities.snapshot !== false) {
      request = Http.request(WORKER + '/batch-prices?symbols=' + encodeURIComponent(symbols.join(',')), {}, 1800)
        .then(function(res) {
          if (!res || !res.success || !res.prices) throw new Error('batch-prices unavailable');
          Runtime.capabilities.snapshot = true;
          var changed = false;
          symbols.forEach(function(sym) {
            if (res.prices[sym] != null) changed = applyPrice(sym, res.prices[sym]) || changed;
          });
          return changed;
        })
        .catch(function(e) {
          if (isNotFound(e)) Runtime.capabilities.snapshot = false;
          return legacyPrices();
        });
    } else request = legacyPrices();
    return Promise.resolve(request).finally(function() { Runtime.livePriceBusy = false; });
  }
};

ApiCompat.fetchLegacyMarket = async function(symbols) {
  var okCount = 0;
  var validSymbols = symbols.filter(function(sym) { return /^[A-Z0-9]{2,20}_USDT$/.test(sym); });
  if (!validSymbols.length) throw new Error('No valid symbols');
  
  await Promise.all(validSymbols.map(async function(sym) {
    if (!pData[sym]) pData[sym] = {};
    var priceOk = false, candleOk = false;
    try {
      var d = await Http.get('/price?symbol=' + encodeURIComponent(sym));
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
    
    var specs = [{tf: '5m', limit: 150, key: 'kl5m'}, {tf: '15m', limit: 100, key: 'kl15m'}, {tf: '1h', limit: 60, key: 'kl1h'}, {tf: '4h', limit: 60, key: 'kl4h'}];
    await Promise.all(specs.map(async function(s) {
      try {
        var d = await Http.get('/klines?symbol=' + encodeURIComponent(sym) + '&interval=' + s.tf + '&limit=' + s.limit);
        var rows = d && (Array.isArray(d.data) ? d.data : Array.isArray(d.klines) ? d.klines : null);
        if (rows && rows.length) {
          pData[sym][s.key] = closedCandles(rows.map(ApiCompat.normalizeCandle).filter(function(k) { return k.t && k.c; }), s.tf, Date.now());
          if (pData[sym][s.key].length > 0) candleOk = true;
        }
      } catch(e) {}
    }));
    
    if (!candleOk) {
      var anchor = priceOk ? pData[sym].price : (DEMO_BASE[sym] || 1);
      DEMO_BASE[sym] = DEMO_BASE[sym] || anchor;
      if (!pData[sym].masterKlines || pData[sym].masterKlines.length < 100) {
        pData[sym].masterKlines = seedKlines(sym, 500);
        var lastK = pData[sym].masterKlines[pData[sym].masterKlines.length - 1];
        var shift = anchor - lastK.c;
        pData[sym].masterKlines.forEach(function(k) { k.o += shift; k.h += shift; k.l += shift; k.c += shift; });
      }
      tickFull(sym);
      if (priceOk) pData[sym].price = anchor;
      candleOk = true;
    }
    
    if (priceOk || candleOk) {
      pData[sym].dataUpdatedAt = Date.now();
      pData[sym].source = (priceOk && candleOk) ? 'live-legacy' : (priceOk ? 'live-nocandles' : 'demo');
      okCount++;
    }
  }));
  
  if (okCount === 0) throw new Error('No usable data');
  analyzeAll();
  return {success: true, legacy: true, count: okCount};
};
