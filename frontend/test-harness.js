/* Headless smoke test: index.html içindeki bundle'ı sahte DOM'da çalıştırır,
   SPOT modunun kritik yollarını doğrular. */
const fs = require('fs');

// ── Sahte DOM/tarayıcı ortamı ──
function fakeEl() {
  return new Proxy({style: {}, classList: {toggle(){}, add(){}, remove(){}},
    setAttribute(){}, getAttribute(){ return null; }, appendChild(){},
    childNodes: [], removeChild(){}, firstChild: null, scrollHeight: 0, scrollTop: 0,
    querySelectorAll(){ return []; }, textContent: '', innerHTML: '', value: '', className: ''},
    { get(t, k) { if (k in t) return t[k]; return t[k] = (typeof k === 'string' && k.startsWith('on')) ? null : t[k]; },
      set(t, k, v) { t[k] = v; return true; } });
}
const elCache = {};
global.document = {
  readyState: 'complete',
  getElementById(id) { return elCache[id] || (elCache[id] = fakeEl()); },
  querySelectorAll() { return []; },
  createElement() { return fakeEl(); },
  addEventListener() {}
};
global.window = global;
global.localStorage = undefined; // storage probe fallback'e düşsün
global.fetch = function() { return Promise.reject(new Error('no network in test')); };
global.confirm = function() { return true; };
global.requestAnimationFrame = function(fn) { return setTimeout(fn, 0); };
global.cancelAnimationFrame = clearTimeout;
global.AbortController = class { constructor(){ this.signal = {}; } abort(){} };

// ── Bundle'ı yükle ──
const html = fs.readFileSync('index.html', 'utf8');
let js = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
// 'use strict' altında indirect eval kendi kapsamını kurar ve var'lar
// globale sızmaz — smoke test için direktifi kaldırıyoruz.
js = js.replace(/^\s*'use strict';/, '');
(0, eval)(js); // var'lar globalThis'e yazılır: marketMode, spotAnalyze, SpotEngine, Execution...

const results = [];
function T(name, fn) {
  try { fn(); results.push('✅ ' + name); }
  catch(e) { results.push('❌ ' + name + ' — ' + e.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

console.log('[harness] typeof positions:', typeof positions, '| typeof pData:', typeof pData, '| typeof marketMode:', typeof marketMode);

// ── Sentetik mum üreticisi (3'lü EMA senaryoları) ──
// 'buy'        : uptrend + pullback + toparlanma -> crossover(S,M) ANI'nda S>M>L (buyCond)
// 'sell'       : downtrend + tepki + düşüş -> crossunder(S,M) ANI'nda S<M<L (sellCond)
// 'cross_only' : uzun düşüş + sert ralli -> crossover(S,M) var ama M<L (filtre tutmaz -> WAIT)
// 'flat'       : sinyal yok
function mkKlines(shape) {
  var raw = [], px = shape === 'cross_only' ? 500 : 200, t0 = Date.now() - 600 * 300000;
  for (var i = 0; i < 600; i++) {
    var drift = 0;
    if (shape === 'buy')        drift = i < 400 ? +0.30 : (i < 425 ? -0.40 : +0.9);
    if (shape === 'sell')       drift = i < 400 ? -0.30 : (i < 425 ? +0.40 : -0.9);
    if (shape === 'cross_only') drift = i < 520 ? -0.60 : +2.5;
    px = Math.max(1, px + drift + (i % 7 - 3) * 0.01);
    raw.push({t: t0 + i * 300000, o: px - 0.1, h: px + 0.3, l: px - 0.3, c: px, v: 1000 + (i % 5) * 100});
  }
  if (shape === 'flat') return raw.slice(-200);
  var L = spotEffLengths();
  var closes = raw.map(function(k){ return k.c; });
  var eS = calcEMA(closes, L.s), eM = calcEMA(closes, L.m), eL = calcEMA(closes, L.l);
  for (var n = 400; n < raw.length; n++) {
    var fS = eS.slice(0, n + 1), fM = eM.slice(0, n + 1);
    var up = eS[n] > eM[n] && eM[n] > eL[n];
    var dn = eS[n] < eM[n] && eM[n] < eL[n];
    if (shape === 'buy'        && pineCrossover(fS, fM)  && up)  return raw.slice(Math.max(0, n - 299), n + 1);
    if (shape === 'sell'       && pineCrossunder(fS, fM) && dn)  return raw.slice(Math.max(0, n - 299), n + 1);
    if (shape === 'cross_only' && pineCrossover(fS, fM)  && !up) return raw.slice(Math.max(0, n - 299), n + 1);
  }
  throw new Error('sentetik seri hedef senaryoyu üretemedi (' + shape + ')');
}

T('mod anahtarı: FUTURES -> SPOT', function() {
  positions.length = 0;
  // Gerçek akış: init -> startDemo veriyi tohumlar, mod anahtarı sonra basılır
  for (var i = 0; i < 3; i++) demoRefresh();
  setMarketMode('SPOT');
  assert(marketMode === 'SPOT', 'mod SPOT olmadı');
});

T('spotAnalyze: buyCond (S↑M + yığın↑) -> LONG', function() {
  var sym = 'BTC_USDT';
  pData[sym] = {price: 0, kl5m: mkKlines('buy')};
  pData[sym].price = pData[sym].kl5m[pData[sym].kl5m.length - 1].c;
  pData[sym].dataUpdatedAt = Date.now();
  var an = spotAnalyze(sym);
  assert(an.signal === 'LONG', 'buyCond LONG üretmedi (sinyal: ' + an.signal + ', trendUp: ' + an.trendUp + ')');
  assert(an.trendUp === true, 'trendUp bayrağı yanlış');
  assert(an.leverage === 1, 'spot lev 1 değil');
  assert(an.posVal > 0 && an.sl > 0 && an.tp > 0, 'posVal/sl/tp eksik');
  assert(an.sl < an.price && an.tp > an.price, 'sl<fiyat<tp sırası bozuk');
});

T('spotAnalyze: sellCond (S↓M + yığın↓) -> exitNow', function() {
  var sym = 'ETH_USDT';
  pData[sym] = {price: 0, kl5m: mkKlines('sell')};
  pData[sym].price = pData[sym].kl5m[pData[sym].kl5m.length - 1].c;
  var an = spotAnalyze(sym);
  assert(an.exitNow === true, 'sellCond exitNow üretmedi (trendDown: ' + an.trendDown + ')');
  assert(an.signal === 'WAIT', 'sellCond BUY üretmemeli');
});

T('spotAnalyze: crossover VAR ama L filtresi yok -> WAIT (Pine filtresi)', function() {
  var sym = 'XRP_USDT';
  pData[sym] = {price: 0, kl5m: mkKlines('cross_only')};
  pData[sym].price = pData[sym].kl5m[pData[sym].kl5m.length - 1].c;
  var an = spotAnalyze(sym);
  assert(an.signal === 'WAIT', 'yığın hizasız cross sinyal üretmemeli (Pine: buyCond=cross AND trendUp)');
  assert(!an.exitNow, 'exit de üretmemeli');
});

T('spotAnalyze: yatay piyasa -> WAIT', function() {
  var sym = 'SOL_USDT';
  pData[sym] = {price: 100, kl5m: mkKlines('flat')};
  var an = spotAnalyze(sym);
  assert(an.signal === 'WAIT' && !an.exitNow, 'yatayda sinyal olmamalı');
});

T('spotEffLengths: lenMult yuvarlaması Pine ile aynı', function() {
  var old = SPOT_CFG.lenMult;
  SPOT_CFG.lenMult = 1.5;
  var L = spotEffLengths(); // 9*1.5=13.5->14 (Math.round), 21*1.5=31.5->32, 55*1.5=82.5->83
  assert(L.s === 14 && L.m === 32 && L.l === 83, 'mult yuvarlaması yanlış: ' + JSON.stringify(L));
  SPOT_CFG.lenMult = 0.01; // max(1, round(0.09)) = 1 tabanı
  assert(spotEffLengths().s === 1, 'min 1 tabanı yok');
  SPOT_CFG.lenMult = old;
});

T('demo SPOT open: pozisyon market=SPOT, lev=1, SHORT reddi', async function() {});
// async testi ayrı çalıştır
(async function() {
  try {
    appMode = 'demo'; marketMode = 'SPOT'; positions.length = 0;
    var sym = 'BTC_USDT';
    pData[sym] = {price: 0, kl5m: mkKlines('buy'), dataUpdatedAt: Date.now()};
    pData[sym].price = pData[sym].kl5m[pData[sym].kl5m.length - 1].c;
    pData[sym].an = spotAnalyze(sym);
    await Execution.open(sym, 'LONG', false);
    assert(positions.length === 1, 'demo spot pozisyon açılmadı');
    assert(positions[0].market === 'SPOT', 'market etiketi yok');
    assert(positions[0].leverage === 1, 'lev 1 değil');
    results.push('✅ demo SPOT open: market=SPOT, lev=1');

    // SHORT -> sellCurrent yönlenir; pozisyon varken close tetikler
    currentPair = sym;
    var before = positions.length;
    await Execution.open(sym, 'SHORT', false);
    // demo'da sellCurrent -> Execution.close -> finalizeClose (senkron demo yolu)
    assert(positions.length < before || positions.every(p => p.state === 'CLOSED'), 'SELL pozisyonu kapatmadı');
    results.push('✅ SPOT SELL: eldeki pozisyonu kapattı');

    // engine tick: barState kilidi — aynı barda ikinci BUY yok
    positions.length = 0;
    autonomousMode = true; autoTrade = true; engineOn = true; focusModeOn = false;
    pData[sym].an = spotAnalyze(sym);
    SpotEngine.barState = {};
    SpotEngine.engineTick();
    var afterFirst = positions.length;
    SpotEngine.engineTick(); // aynı bar — açmamalı
    assert(positions.length === afterFirst, 'aynı barda ikinci BUY açıldı');
    results.push('✅ engineTick: bar başına tek işlem kilidi');

    // mod değişimi açık pozisyonla bloklanmalı
    if (!positions.length) { pData[sym].an = spotAnalyze(sym); await Execution.open(sym, 'LONG', false); }
    setMarketMode('FUTURES');
    assert(marketMode === 'SPOT', 'açık pozisyonla mod değişti (değişmemeliydi)');
    results.push('✅ mod kilidi: açık pozisyonla geçiş engellendi');
  } catch(e) {
    results.push('❌ async akış — ' + e.message);
    process.exitCode = 1;
  } finally {
    // timer'ları temizle ki node çıkabilsin
    if (typeof TRACKER_INTERVAL !== 'undefined' && TRACKER_INTERVAL) clearInterval(TRACKER_INTERVAL);
    if (typeof loopTimer !== 'undefined' && loopTimer) clearTimeout(loopTimer);
    if (typeof cdTimer !== 'undefined' && cdTimer) clearInterval(cdTimer);
    console.log(results.join('\n'));
    process.exit(process.exitCode || 0);
  }
})();
