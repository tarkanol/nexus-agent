/* ============================================================
   TARKAN MODE
   ─────────────────────────────────────────────────────────────
   Kullanicinin gonderdigi "Dynamic Volatility Filter [QuantAlgo]"
   Pine indikatorunun (bkz. calcDVF, 04-indicators.js) trend-flip
   sinyaline sadik kalarak, EKRANDA SEcILI TEK PAIR (currentPair)
   uzerinde secilen zaman diliminde (1m/5m/15m) scalp acar/kapatir.

   - turned_bullish -> LONG ac (varsa acik SHORT'u kapatip don)
   - turned_bearish -> FUTURES'ta SHORT ac; SPOT'ta (short yok)
     sadece acik LONG'u kapatir.
   - SL/TP kullanicinin girdigi SABIT DOLAR tutarlaridir
     (Execution.open'in manualTargetUsd/manualRiskUsd parametreleri
     - mevcut "manuel islem" panelindeki mantigin ayni sekilde
     kullanimidir).
   - Bir bar'da bir sinyal sadece BIR KEZ islenir (tarkanBarState
     kilidi) — Pine'in "bar close'da bir kez tetiklenir" davranisi.

   NOT (Gate.io API kisiti): Gate.io futures/spot candlesticks
   endpoint'i "10m" araligini desteklemiyor (10s/30s/1m/5m/15m/30m/
   1h/... enum'unda 10m yok). Bu yuzden dropdown 1m/5m/15m sunar;
   tam "10dk" istenirse 5m mumlari 2'ser gruplayip sentetik 10m
   uretmek gerekir (su an YAPILMADI, gerekirse ek is).
   ============================================================ */

var TarkanEngine = {
  klKey: function(tf) { return tf === '1m' ? 'kl1m' : tf === '15m' ? 'kl15m' : 'kl5m'; },

  openTarkanPos: async function(sym, side) {
    if (Runtime.openingLocks[sym]) return; // ac. islem zaten devam ediyor
    await Execution.open(sym, side, true, TARKAN_CFG.tpUsd, TARKAN_CFG.slUsd);
    // Execution.open kendi clientOrderId'sini icerde uretiyor; yeni eklenen
    // pozisyonu (bu pair, henuz etiketlenmemis, en yeni openTime) bulup
    // TARKAN olarak isaretliyoruz ki UI'da ve loglarda ayirt edilebilsin.
    var mine = positions.filter(function(p) {
      return p.pair === sym && p.state !== POSITION_STATE.CLOSED && !p.tarkan;
    }).sort(function(a, b) { return b.openTime - a.openTime; })[0];
    if (mine) {
      mine.tarkan = true;
      logPos('[TARKAN] ' + side + ' ' + sym.replace('_USDT', '') + ' açıldı (TF:' + TARKAN_CFG.tf + ')', 'ok');
    }
  },

  closeTarkanPos: function(pos, reason) {
    if (!pos || closingNow[pos.id]) return;
    Execution.close(pos.id, reason || 'TARKAN FLIP');
  },

  findOpenPos: function(sym) {
    return positions.find(function(p) { return p.pair === sym && p.tarkan && p.state !== POSITION_STATE.CLOSED; });
  },

  tick: function() {
    if (!tarkanMode) return;
    var sym = currentPair;
    var pd = pData[sym];
    if (!pd) return;
    var key = TarkanEngine.klKey(TARKAN_CFG.tf);
    var kl = pd[key] || [];
    if (kl.length < TARKAN_CFG.lookback + 3) {
      var sigEl = document.getElementById('eSig');
      if (sigEl) sigEl.textContent = 'TARKAN: ' + sym.replace('_USDT', '') + ' veri ısınıyor (' + kl.length + ')';
      return;
    }

    var dvf = calcDVF(kl, TARKAN_CFG.noiseMult, TARKAN_CFG.lookback, TARKAN_CFG.snapSpeed);
    if (!dvf) return;

    var lockKey = sym + ':' + TARKAN_CFG.tf;
    var alreadyProcessed = tarkanBarState[lockKey] === dvf.barT;

    var sigEl2 = document.getElementById('eSig');
    if (sigEl2) {
      var dirTxt = dvf.trend === 1 ? 'BULLISH' : dvf.trend === -1 ? 'BEARISH' : 'FLAT';
      sigEl2.textContent = 'TARKAN ' + sym.replace('_USDT', '') + ' ' + TARKAN_CFG.tf + ': ' + dirTxt;
      sigEl2.style.color = dvf.trend === 1 ? 'var(--long)' : dvf.trend === -1 ? 'var(--short)' : 'var(--dim2)';
    }

    if (alreadyProcessed) return;
    tarkanBarState[lockKey] = dvf.barT;

    var pos = TarkanEngine.findOpenPos(sym);

    if (dvf.turnedBullish) {
      if (pos && pos.side === 'SHORT') {
        TarkanEngine.closeTarkanPos(pos, 'TARKAN FLIP → LONG');
        setTimeout(function() { TarkanEngine.openTarkanPos(sym, 'LONG'); }, 400);
      } else if (!pos) {
        TarkanEngine.openTarkanPos(sym, 'LONG');
      }
    } else if (dvf.turnedBearish) {
      if (marketMode === 'SPOT') {
        // Spot'ta short yok; sadece elde acik LONG varsa kapat (sat).
        if (pos && pos.side === 'LONG') TarkanEngine.closeTarkanPos(pos, 'TARKAN FLIP → EXIT (SPOT)');
      } else {
        if (pos && pos.side === 'LONG') {
          TarkanEngine.closeTarkanPos(pos, 'TARKAN FLIP → SHORT');
          setTimeout(function() { TarkanEngine.openTarkanPos(sym, 'SHORT'); }, 400);
        } else if (!pos) {
          TarkanEngine.openTarkanPos(sym, 'SHORT');
        }
      }
    }
    updateAutoStats();
  }
};

function toggleTarkan() {
  tarkanMode = !tarkanMode;
  if (tarkanMode) {
    readTarkanSettings();
    tarkanBarState = {};
    if (!engineOn) toggleEng(); // TARKAN, mevcut engine tarama dongusune (runEngine) binerek calisir
    logPos('[TARKAN] Aktif — ' + currentPair.replace('_USDT', '') + ' / ' + TARKAN_CFG.tf, 'ok');
    notify('🎯 TARKAN AKTİF (' + currentPair.replace('_USDT', '') + ', ' + TARKAN_CFG.tf + ')', 'success');
  } else {
    logPos('[TARKAN] Durduruldu', 'info');
    notify('⏹ TARKAN durduruldu', 'info');
  }
  applyTarkanUI();
  updateSignalUI();
}

function readTarkanSettings() {
  var tfEl = document.getElementById('tarkanTf');
  if (tfEl && ['1m', '5m', '15m'].indexOf(tfEl.value) !== -1 && tfEl.value !== TARKAN_CFG.tf) {
    TARKAN_CFG.tf = tfEl.value;
    tarkanBarState = {}; // TF degisti -> bar kilidini sifirla
  }
  var tpEl = document.getElementById('tarkanTP'), slEl = document.getElementById('tarkanSL');
  var tp = tpEl ? parseFloat(tpEl.value) : NaN;
  var sl = slEl ? parseFloat(slEl.value) : NaN;
  if (Number.isFinite(tp) && tp > 0) TARKAN_CFG.tpUsd = tp;
  if (Number.isFinite(sl) && sl > 0) TARKAN_CFG.slUsd = sl;
  applyTarkanUI();
}

function applyTarkanUI() {
  var btn = document.getElementById('btnTarkan');
  if (btn) {
    btn.textContent = tarkanMode ? '⏹ TARKAN DURDUR' : '🎯 TARKAN BAŞLAT';
    btn.className = 'btn btn-sm ' + (tarkanMode ? 'btn-danger' : 'btn-gold');
  }
  var status = document.getElementById('tarkanStatus');
  if (status) {
    status.textContent = tarkanMode
      ? ('AKTİF • ' + currentPair.replace('_USDT', '') + ' • TF:' + TARKAN_CFG.tf + ' • TP:$' + TARKAN_CFG.tpUsd.toFixed(2) + ' SL:$' + TARKAN_CFG.slUsd.toFixed(2))
      : 'Kapalı';
    status.style.color = tarkanMode ? 'var(--long)' : 'var(--dim2)';
  }
}

function bindTarkanUI() {
  var tfEl = document.getElementById('tarkanTf');
  if (tfEl) { tfEl.value = TARKAN_CFG.tf; tfEl.onchange = readTarkanSettings; }
  var tpEl = document.getElementById('tarkanTP');
  if (tpEl) { tpEl.value = TARKAN_CFG.tpUsd; tpEl.onchange = readTarkanSettings; }
  var slEl = document.getElementById('tarkanSL');
  if (slEl) { slEl.value = TARKAN_CFG.slUsd; slEl.onchange = readTarkanSettings; }
  var lbl = document.getElementById('tarkanPairLabel');
  if (lbl) lbl.textContent = currentPair.replace('_USDT', '');
  applyTarkanUI();
}
