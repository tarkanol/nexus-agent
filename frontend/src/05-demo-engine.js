/* ============================================================
   DEMO PRICE ENGINE
   ============================================================ */
function initTrendState(sym) {
  trendState[sym] = {
    trend: Math.random() > 0.5 ? 1 : -1,
    trendStrength: 0.3 + Math.random() * 0.5,
    trendDuration: 0,
    trendMaxDur: 20 + Math.floor(Math.random() * 60),
    volPhase: Math.random() * Math.PI * 2,
    volCycle: 30 + Math.floor(Math.random() * 50),
    noiseAmp: 0.0003 + Math.random() * 0.0008
  };
}

function demoTick(sym) {
  var s = pxState[sym];
  var ts = trendState[sym];
  if (!ts) { initTrendState(sym); ts = trendState[sym]; }
  ts.trendDuration++;
  if (ts.trendDuration >= ts.trendMaxDur) {
    ts.trend = -ts.trend;
    ts.trendStrength = 0.25 + Math.random() * 0.55;
    ts.trendDuration = 0;
    ts.trendMaxDur = 15 + Math.floor(Math.random() * 70);
  }
  ts.volPhase += (2 * Math.PI) / ts.volCycle;
  var volMult = 0.6 + 1.0 * Math.abs(Math.sin(ts.volPhase));
  var base = DEMO_BASE[sym] || 1;
  var meanRev = (base - s.price) * 0.00015;
  var drift = ts.trend * ts.trendStrength * s.price * 0.00035;
  var noise = (Math.random() - 0.5) * ts.noiseAmp * s.price;
  var momentum = s.vel * 0.55;
  s.vel = momentum + drift + noise;
  s.price = Math.max(s.price * 0.5, s.price + s.vel);
  s.volMult = volMult;
}

function seedKlines(sym, count) {
  count = count || 3000;
  var base = DEMO_BASE[sym] || 1;
  var nowBucket = Math.floor(Date.now() / 60000) * 60000;
  var out = [], p = base * (0.92 + Math.random() * 0.16), vel = 0;
  var trend = Math.random() > 0.5 ? 1 : -1, phase = Math.random() * 6.28;
  for (var i = count; i > 0; i--) {
    if (i % (70 + Math.floor(Math.random() * 200)) === 0) trend *= -1;
    phase += 0.08;
    var drift = trend * p * (0.00004 + Math.random() * 0.00006);
    var cyc = Math.sin(phase) * p * 0.00012;
    var noise = (Math.random() - 0.5) * p * 0.0006;
    vel = vel * 0.5 + drift + cyc + noise;
    var o = p;
    p = Math.max(base * 0.2, p + vel);
    var range = Math.abs(vel) + p * (0.0004 + Math.random() * 0.001);
    out.push({
      t: nowBucket - i * 60000,
      o: o,
      h: Math.max(o, p) + range * Math.random(),
      l: Math.min(o, p) - range * Math.random(),
      c: p,
      v: (500 + Math.random() * 15000) * (0.6 + Math.abs(Math.sin(phase)))
    });
  }
  return out;
}

function aggregateKlines(oneMinute, minutes) {
  if (!Array.isArray(oneMinute)) return [];
  var bucketMs = minutes * 60000, map = {};
  oneMinute.forEach(function(k) {
    var bt = Math.floor(Number(k.t) / bucketMs) * bucketMs;
    var x = map[bt];
    if (!x) map[bt] = {t: bt, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v};
    else { x.h = Math.max(x.h, +k.h); x.l = Math.min(x.l, +k.l); x.c = +k.c; x.v += +k.v; }
  });
  var arr = Object.keys(map).map(function(k) { return map[k]; }).sort(function(a, b) { return a.t - b.t; });
  var current = Math.floor(Date.now() / bucketMs) * bucketMs;
  return arr.filter(function(k) { return k.t < current; });
}

function tickPriceOnly(sym) {
  if (!pData[sym]) pData[sym] = {};
  if (!pData[sym].masterKlines || pData[sym].masterKlines.length < 100) {
    pData[sym].masterKlines = seedKlines(sym, 3000);
  }
  if (!pxState[sym]) {
    var lastSeed = pData[sym].masterKlines[pData[sym].masterKlines.length - 1];
    pxState[sym] = {price: lastSeed.c, vel: 0, volMult: 1};
  }
  if (!trendState[sym]) initTrendState(sym);
  prevPx[sym] = pxState[sym].price;
  demoTick(sym);
  var now = Date.now(), bucket = Math.floor(now / 60000) * 60000;
  var mk = pData[sym].masterKlines, last = mk[mk.length - 1], price = pxState[sym].price;
  if (!last || last.t < bucket) {
    mk.push({t: bucket, o: last ? last.c : price, h: price, l: price, c: price, v: 100 + Math.random() * 2000});
    if (mk.length > 3000) mk.splice(0, mk.length - 3000);
  } else {
    last.c = price;
    if (price > last.h) last.h = price;
    if (price < last.l) last.l = price;
    last.v += 20 + Math.random() * 500;
  }
  pData[sym].price = price;
  pData[sym].dataUpdatedAt = now;
  pData[sym].source = 'demo';
}

function tickFull(sym) {
  tickPriceOnly(sym);
  var mk = pData[sym].masterKlines;
  pData[sym].kl1m = aggregateKlines(mk, 1).slice(-600);
  pData[sym].kl5m = aggregateKlines(mk, 5).slice(-600);
  pData[sym].kl15m = aggregateKlines(mk, 15).slice(-300);
  pData[sym].kl1h = aggregateKlines(mk, 60).slice(-200);
  pData[sym].kl4h = aggregateKlines(mk, 240).slice(-100);
}

function demoRefresh() {
  pairs.forEach(function(s) { tickFull(s); });
  analyzeAll();
}
