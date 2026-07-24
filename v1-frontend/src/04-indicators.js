/* ============================================================
   MATH / INDICATORS
   ============================================================ */
function calcEMA(arr, p) {
  if (!arr || arr.length < p) return arr ? arr.map(function(){return null;}) : [];
  var k = 2/(p+1), out = [], e = 0, i;
  for (i = 0; i < p - 1; i++) out.push(null);
  for (i = 0; i < p; i++) e += arr[i];
  e /= p;
  out.push(e);
  for (i = p; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function calcRSI(closes, p) {
  p = p || 14;
  if (closes.length < p + 2) return 50;
  var g = 0, l = 0, i, d;
  for (i = 1; i <= p; i++) { d = closes[i] - closes[i-1]; if (d > 0) g += d; else l -= d; }
  var ag = g / p, al = l / p;
  for (i = p + 1; i < closes.length; i++) {
    d = closes[i] - closes[i-1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
}

function calcMACD(closes) {
  var e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26), ml = [], i;
  for (i = 0; i < closes.length; i++) if (e12[i] && e26[i]) ml.push(e12[i] - e26[i]);
  if (ml.length < 3) return {hist: 0, prev: 0, cross: null, aligned: false};
  var sg = calcEMA(ml, 9);
  var n = ml.length - 1;
  var h = ml[n] - (sg[sg.length - 1] || 0);
  var ph = ml[n - 1] - (sg[sg.length - 2] || 0);
  var cross = (ph < 0 && h > 0) ? 'UP' : (ph > 0 && h < 0) ? 'DN' : null;
  var aligned = (h > 0 && h > ph) || (h < 0 && h < ph);
  return {hist: h, prev: ph, cross: cross, aligned: aligned};
}

function calcATR(kl, p) {
  p = p || 14;
  if (!kl || kl.length < p + 1) return kl && kl.length ? kl[kl.length - 1].h - kl[kl.length - 1].l : 0.001;
  var trs = [], i, pc, sum = 0;
  for (i = 1; i < kl.length; i++) {
    pc = kl[i - 1].c;
    trs.push(Math.max(kl[i].h - kl[i].l, Math.abs(kl[i].h - pc), Math.abs(kl[i].l - pc)));
  }
  for (i = trs.length - p; i < trs.length; i++) sum += trs[i];
  return sum / p;
}

function calcADX(kl, p) {
  p = p || 14;
  if (!kl || kl.length < p + 2) return 20;
  var dmPlus = [], dmMinus = [], tr = [], i;
  for (i = 1; i < kl.length; i++) {
    var up = kl[i].h - kl[i - 1].h;
    var dn = kl[i - 1].l - kl[i].l;
    dmPlus.push(up > dn && up > 0 ? up : 0);
    dmMinus.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(kl[i].h - kl[i].l, Math.abs(kl[i].h - kl[i - 1].c), Math.abs(kl[i].l - kl[i - 1].c)));
  }
  if (tr.length < p) return 20;
  var atr = 0;
  for (i = 0; i < p; i++) atr += tr[i];
  atr /= p;
  var plus = 0, minus = 0;
  for (i = 0; i < p; i++) { plus += dmPlus[i]; minus += dmMinus[i]; }
  plus /= p; minus /= p;
  if (plus === 0 && minus === 0) return 20;
  var pdi = plus / (plus + minus) * 100;
  var mdi = minus / (plus + minus) * 100;
  var dx = Math.abs(pdi - mdi) / (pdi + mdi) * 100;
  return dx;
}

function calcVolRatio(kl) {
  var p = 20, i;
  if (!kl || kl.length < p + 1) return 1;
  var sl = kl.slice(-p), sum = 0;
  for (i = 0; i < sl.length - 1; i++) sum += sl[i].v;
  var avg = sum / (sl.length - 1);
  return avg > 0 ? sl[sl.length - 1].v / avg : 1;
}

function calcBB(closes, p, mult) {
  p = p || 20; mult = mult || 2;
  if (closes.length < p) return {upper: 0, lower: 0, mid: 0, squeeze: false};
  var slice = closes.slice(-p), sum = 0, i;
  for (i = 0; i < p; i++) sum += slice[i];
  var mid = sum / p, vsum = 0;
  for (i = 0; i < p; i++) vsum += (slice[i] - mid) * (slice[i] - mid);
  var std = Math.sqrt(vsum / p);
  return {upper: mid + mult * std, lower: mid - mult * std, mid: mid, squeeze: (std / mid) < 0.008};
}

function maxHighOf(kl, fromEnd, count) {
  var end = Math.max(0, kl.length - fromEnd), start = Math.max(0, end - count), x = -Infinity;
  for (var i = start; i < end; i++) if (kl[i].h > x) x = kl[i].h;
  return x;
}
function minLowOf(kl, fromEnd, count) {
  var end = Math.max(0, kl.length - fromEnd), start = Math.max(0, end - count), x = Infinity;
  for (var i = start; i < end; i++) if (kl[i].l < x) x = kl[i].l;
  return x;
}

function emaSlope(emaArr, lb) {
  lb = lb || 4;
  if (!emaArr || emaArr.length < lb + 1) return 0;
  var last = null, prev = null, i;
  for (i = emaArr.length - 1; i >= 0 && last === null; i--) if (emaArr[i] !== null) last = emaArr[i];
  for (i = emaArr.length - lb - 1; i >= 0 && prev === null; i--) if (emaArr[i] !== null) prev = emaArr[i];
  if (last === null || prev === null || prev === 0) return 0;
  return (last - prev) / prev;
}

function calcStochRSI(closes, p) {
  p = p || 14;
  if (closes.length < p * 2) return 50;
  var rsiArr = [];
  for (var i = p; i < closes.length; i++) rsiArr.push(calcRSI(closes.slice(0, i + 1), p));
  if (rsiArr.length < p) return 50;
  var sl = rsiArr.slice(-p);
  var mn = Math.min.apply(null, sl), mx = Math.max.apply(null, sl);
  return (mx - mn) < 0.01 ? 50 : (sl[sl.length - 1] - mn) / (mx - mn) * 100;
}

function detectVolumeSpike(kl, threshold) {
  threshold = threshold || 2.0;
  if (!kl || kl.length < 22) return {spike: false, ratio: 1};
  var lastVol = kl[kl.length - 1].v;
  var sum = 0, cnt = 0;
  for (var i = kl.length - 21; i < kl.length - 1; i++) { sum += kl[i].v; cnt++; }
  var avg = cnt > 0 ? sum / cnt : lastVol;
  var ratio = avg > 0 ? lastVol / avg : 1;
  return {spike: ratio >= threshold, ratio: ratio};
}

function calcROC(closes, p) {
  p = p || 10;
  if (closes.length < p + 1) return 0;
  var now = closes[closes.length - 1];
  var prev = closes[closes.length - 1 - p];
  return prev > 0 ? (now - prev) / prev * 100 : 0;
}

function detectPattern(kl) {
  if (!kl || kl.length < 5) return 'NONE';
  var last = kl[kl.length - 1], prev = kl[kl.length - 2], prev2 = kl[kl.length - 3];
  if (last.h <= prev.h && last.l >= prev.l) return 'INSIDE_BAR';
  if (last.h > prev.h && last.l < prev.l) {
    if (last.c > last.o && prev.c < prev.o) return 'BULLISH_ENGULFING';
    if (last.c < last.o && prev.c > prev.o) return 'BEARISH_ENGULFING';
  }
  var body = Math.abs(last.c - last.o);
  var upperWick = last.h - Math.max(last.c, last.o);
  var lowerWick = Math.min(last.c, last.o) - last.l;
  if (body > 0 && lowerWick > body * 2 && upperWick < body * 0.5) return 'HAMMER';
  if (body > 0 && upperWick > body * 2 && lowerWick < body * 0.5) return 'SHOOTING_STAR';
  if (last.c > last.o && prev.c > prev.o && prev2.c > prev2.o &&
      last.c > prev.c && prev.c > prev2.c) return 'THREE_WHITE';
  if (last.c < last.o && prev.c < prev.o && prev2.c < prev2.o &&
      last.c < prev.c && prev.c < prev2.c) return 'THREE_BLACK';
  if (prev2.c > prev2.o && Math.abs(prev.c - prev.o) < body * 0.3 && last.c < last.o && last.c < prev2.o) return 'EVENING_STAR';
  if (prev2.c < prev2.o && Math.abs(prev.c - prev.o) < body * 0.3 && last.c > last.o && last.c > prev2.o) return 'MORNING_STAR';
  return 'NONE';
}

function detectRegime(kl5, kl15, kl1h) {
  if (!kl5 || kl5.length < 50 || !kl15 || kl15.length < 30) {
    return {trend: 'UNKNOWN', volatility: 'UNKNOWN', adx: 0, regime: 'UNKNOWN', strength: 0};
  }
  var adx = calcADX(kl5, 14);
  var atr = calcATR(kl5, 14);
  var price = kl5[kl5.length - 1].c;
  var volPct = (atr / price) * 100;
  var c5 = kl5.map(function(k) { return k.c; });
  var e9 = calcEMA(c5, 9);
  var e21 = calcEMA(c5, 21);
  var lastE9 = e9[e9.length - 1];
  var lastE21 = e21[e21.length - 1];
  var slope = e9.length > 10 ? (lastE9 - e9[e9.length - 5]) / (e9[e9.length - 5] || 1) : 0;
  
  var trendStrength = 0;
  var trendDir = 'NEUTRAL';
  
  if (adx >= 25 && lastE9 > lastE21 && slope > 0.00005) {
    trendStrength = Math.min(100, adx + (slope * 100000));
    trendDir = 'STRONG_UP';
  } else if (adx >= 25 && lastE9 < lastE21 && slope < -0.00005) {
    trendStrength = Math.min(100, adx + Math.abs(slope * 100000));
    trendDir = 'STRONG_DOWN';
  } else if (adx >= 20) {
    trendStrength = adx;
    trendDir = lastE9 > lastE21 ? 'WEAK_UP' : 'WEAK_DOWN';
  } else if (adx >= 15) {
    trendStrength = adx;
    trendDir = slope > 0 ? 'WEAK_UP' : slope < 0 ? 'WEAK_DOWN' : 'NEUTRAL';
  } else {
    trendStrength = adx;
    trendDir = 'RANGE';
  }
  
  var volLevel = volPct < 0.05 ? 'LOW' : volPct < 0.15 ? 'MEDIUM' : 'HIGH';
  var regime;
  if (adx >= 25 && Math.abs(slope) > 0.0001) regime = 'TRENDING';
  else if (adx < 20 && volPct < 0.12) regime = 'RANGING';
  else if (volPct >= 0.2) regime = 'VOLATILE';
  else regime = 'MIXED';
  
  return {trend: trendDir, volatility: volLevel, adx: adx, regime: regime, strength: trendStrength, slope: slope, volPct: volPct};
}
