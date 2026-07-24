/* ============================================================
   ACCOUNTING
   ============================================================ */
var Accounting = {
  entryFee: function(notional, rate) { return Math.abs(notional) * num(rate, CFG.feeRate); },
  exitFee: function(qty, exitPrice, rate) { return Math.abs(qty * exitPrice) * num(rate, CFG.feeRate); },
  grossPnl: function(side, entry, exit, qty) {
    return (num(exit) - num(entry)) * (side === 'LONG' ? 1 : -1) * Math.abs(num(qty));
  },
  marginRequired: function(notional, lev) { return Math.abs(notional) / Math.max(1, num(lev, 1)); },
  closeBreakdown: function(pos, exitPrice, funding) {
    var gross = Accounting.grossPnl(pos.side, pos.entry, exitPrice, pos.qty);
    var exitFee = Accounting.exitFee(pos.qty, exitPrice, pos.feeRate);
    var fundingCost = num(funding, 0);
    return {
      gross: gross,
      entryFee: num(pos.entryFee, Accounting.entryFee(pos.posVal, pos.feeRate)),
      exitFee: exitFee,
      funding: fundingCost,
      tradeNet: gross - num(pos.entryFee, 0) - exitFee - fundingCost
    };
  },
  pnlTargetToDistance: function(usd, qty) {
    qty = Math.abs(num(qty));
    if (!qty) throw new Error('Quantity is zero');
    return Math.abs(num(usd)) / qty;
  },
  roundTripCost: function(posVal, feeRate) {
    return (posVal || 0) * (num(feeRate, CFG.feeRate) * 2 + (CFG.spreadBps + CFG.slippageBps) / 10000);
  },
  minProfitableSize: function(price, slDist, tpDist) {
    var cRate = (2 * CFG.feeRate) + (CFG.spreadBps + CFG.slippageBps) / 10000;
    var minNotional = Math.max(MIN_POS_VAL, (cRate * price * 2) / (tpDist/slDist - cRate));
    return Math.max(MIN_POS_VAL, minNotional);
  }
};

/* ============================================================
   ANALYZE
   ============================================================ */
function costRate() {
  return (2 * CFG.feeRate) + (CFG.spreadBps + CFG.slippageBps) / 10000;
}

function tierOf(score) {
  score = num(score, 0);
  return score >= 80 ? 'A' : score >= 60 ? 'B' : 'C';
}

function resultBase(ctx) {
  return {
    price: ctx.price,
    score: ctx.score,
    reasons: ctx.reasons,
    atrPct: ctx.atrPct,
    vr: ctx.vr,
    adx: ctx.adx || 0,
    filters: {
      atr: ctx.atrPct.toFixed(3) + '%',
      vol: ctx.vr.toFixed(2) + 'x',
      trend: ctx.tfCount + '/3',
      rsi: ctx.rsi5.toFixed(1),
      macd: ctx.macdLabel,
      adx: (ctx.adx || 0).toFixed(0),
      regime: ctx.regime || '--',
      score: ctx.score + '%'
    },
    indicators: {
      rsi5: ctx.rsi5,
      rsi15: ctx.rsi15,
      macd: ctx.macd5,
      vr: ctx.vr,
      atrPct: ctx.atrPct,
      atrVal: ctx.atrVal || 0,
      adx: ctx.adx || 0,
      goldenX: ctx.goldenX,
      deathX: ctx.deathX,
      aboveEMA: ctx.aboveEMA,
      bbSqueeze: ctx.bbSqueeze,
      sl5: ctx.sl5,
      stochRsi5: ctx.stochRsi5
    },
    mtf: {'5m': ctx.trend5, '15m': ctx.trend15, '1h': ctx.bias1h, '4h': ctx.trend4h || 'WAIT'}
  };
}

function waitResult(ctx, reason) {
  var out = resultBase(ctx);
  out.signal = 'WAIT';
  out.failReason = reason;
  return out;
}

function analyze(sym) {
  var pd = pData[sym];
  if (!pd) return null;
  var kl5 = pd.kl5m || [], kl15 = pd.kl15m || [], kl1h = pd.kl1h || [], kl4h = pd.kl4h || [];
  
  var price = Number(pd.price || (kl5.length ? kl5[kl5.length - 1].c : 0));
  if (!price || kl5.length < 15 || kl15.length < 8 || kl1h.length < 4) {
    return {
      signal: 'WAIT', score: 0, price: price || 0,
      failReason: 'DATA_WARMUP',
      filters: {atr: '--', vol: '--', trend: '--', rsi: '--', macd: '--', adx: '--', regime: '--', score: '0%'},
      reasons: []
    };
  }
  
  var c5 = [], c15 = [], c1h = [], c4h = [], i;
  for (i = 0; i < kl5.length; i++) c5.push(Number(kl5[i].c));
  for (i = 0; i < kl15.length; i++) c15.push(Number(kl15[i].c));
  for (i = 0; i < kl1h.length; i++) c1h.push(Number(kl1h[i].c));
  for (i = 0; i < kl4h.length; i++) c4h.push(Number(kl4h[i].c));
  
  var atr5 = calcATR(kl5, 14), atrPct = atr5 / price * 100;
  var adx = calcADX(kl5, 14);
  var regime = detectRegime(kl5, kl15, kl1h);
  
  if (!pData[sym].atrAvg) pData[sym].atrAvg = atr5;
  else pData[sym].atrAvg = pData[sym].atrAvg * 0.9 + atr5 * 0.1;
  
  var e9_5 = calcEMA(c5, 9), e21_5 = calcEMA(c5, 21);
  var e9_15 = calcEMA(c15, 9), e21_15 = calcEMA(c15, 21);
  var e20h = calcEMA(c1h, 20), e50h = calcEMA(c1h, Math.min(50, c1h.length));
  var e9_4h = calcEMA(c4h, 9), e21_4h = calcEMA(c4h, Math.min(21, c4h.length));
  
  var l9_5 = e9_5[e9_5.length - 1], l21_5 = e21_5[e21_5.length - 1];
  var p9_5 = e9_5[e9_5.length - 2], p21_5 = e21_5[e21_5.length - 2];
  var l9_15 = e9_15[e9_15.length - 1], l21_15 = e21_15[e21_15.length - 1];
  var l20h = e20h[e20h.length - 1], l50h = e50h[e50h.length - 1];
  var l9_4h = e9_4h[e9_4h.length - 1], l21_4h = e21_4h[e21_4h.length - 1];
  
  if (!l9_5 || !l21_5 || !l9_15 || !l21_15 || !l20h || !l50h) return null;
  
  var sl5 = emaSlope(e9_5, 4), sl15 = emaSlope(e9_15, 4), sl1h = emaSlope(e20h, 5);
  var aboveEMA = l9_5 > l21_5, belowEMA = l9_5 < l21_5;
  var goldenX = p9_5 <= p21_5 && l9_5 > l21_5;
  var deathX = p9_5 >= p21_5 && l9_5 < l21_5;
  
  var trend5 = aboveEMA && sl5 > 0.00001 ? 'LONG' : belowEMA && sl5 < -0.00001 ? 'SHORT' : 'WAIT';
  var trend15 = l9_15 > l21_15 && sl15 > 0.000005 ? 'LONG' : l9_15 < l21_15 && sl15 < -0.000005 ? 'SHORT' : 'WAIT';
  var trend4h = l9_4h && l21_4h ? (l9_4h > l21_4h ? 'LONG' : 'SHORT') : 'WAIT';
  
  var bias1h;
  if (l20h > l50h && sl1h > 0.00002) bias1h = 'LONG';
  else if (l20h < l50h && sl1h < -0.00002) bias1h = 'SHORT';
  else if (sl1h < -0.0003) bias1h = 'SHORT';
  else if (sl1h > 0.0003) bias1h = 'LONG';
  else bias1h = 'WAIT';
  
  var macd5 = calcMACD(c5), macd15 = calcMACD(c15);
  var rsi5 = calcRSI(c5, 14), rsi15 = calcRSI(c15, 9);
  var prevRsi5 = calcRSI(c5.slice(0, -1), 14);
  var stochRsi5 = calcStochRSI(c5, 14);
  var vr = calcVolRatio(kl5);
  var bb5 = calcBB(c5, 20, 2);
  
  var volSpike = detectVolumeSpike(kl5, 1.8);
  var roc10 = calcROC(c5, 10);
  var pattern = detectPattern(kl5);
  
  var last = kl5[kl5.length - 1], prev = kl5[kl5.length - 2];
  var bull2 = last.c > last.o && prev.c > prev.o;
  var bear2 = last.c < last.o && prev.c < prev.o;
  var breakoutLong = last.c > maxHighOf(kl5, 1, 8);
  var breakoutShort = last.c < minLowOf(kl5, 1, 8);
  
  var longVotes = 0, shortVotes = 0;
  
  if (aboveEMA && sl5 > 0.00001) longVotes += 2; else if (aboveEMA) longVotes++;
  if (belowEMA && sl5 < -0.00001) shortVotes += 2; else if (belowEMA) shortVotes++;
  
  if (macd5.hist > 0 && macd5.aligned) longVotes += 2;
  else if (macd5.hist > 0) longVotes++;
  if (macd5.hist < 0 && macd5.aligned) shortVotes += 2;
  else if (macd5.hist < 0) shortVotes++;
  
  if (macd5.cross === 'UP') longVotes += 3;
  if (macd5.cross === 'DN') shortVotes += 3;
  
  if (rsi5 > 50 && rsi5 > prevRsi5) longVotes += 2;
  else if (rsi5 > 50) longVotes++;
  if (rsi5 < 50 && rsi5 < prevRsi5) shortVotes += 2;
  else if (rsi5 < 50) shortVotes++;
  
  if (last.c > prev.c && last.c > last.o) longVotes++;
  if (last.c < prev.c && last.c < last.o) shortVotes++;
  if (breakoutLong) longVotes += 2;
  if (breakoutShort) shortVotes += 2;
  
  if (volSpike.spike) {
    if (last.c > prev.c) longVotes += 2;
    else shortVotes += 2;
  }
  
  if (roc10 > 2) longVotes += 2;
  else if (roc10 > 1) longVotes++;
  if (roc10 < -2) shortVotes += 2;
  else if (roc10 < -1) shortVotes++;
  
  if (pattern === 'BULLISH_ENGULFING' || pattern === 'MORNING_STAR' || pattern === 'THREE_WHITE' || pattern === 'HAMMER') longVotes += 3;
  if (pattern === 'BEARISH_ENGULFING' || pattern === 'EVENING_STAR' || pattern === 'THREE_BLACK' || pattern === 'SHOOTING_STAR') shortVotes += 3;
  if (pattern === 'INSIDE_BAR') { if (aboveEMA) longVotes++; else shortVotes++; }
  
  if (trend15 === 'LONG') longVotes += 1;
  if (trend15 === 'SHORT') shortVotes += 1;
  if (bias1h === 'LONG') longVotes += 1;
  if (bias1h === 'SHORT') shortVotes += 1;
  
  if (stochRsi5 < 25 && rsi5 < 45) longVotes++;
  if (stochRsi5 > 75 && rsi5 > 55) shortVotes++;
  
  if (adx < 15) { longVotes = Math.max(0, longVotes - 2); shortVotes = Math.max(0, shortVotes - 2); }
  
  var rawSig = 'WAIT', strategy = 'TREND';
  
  if (longVotes >= 5 && longVotes > shortVotes + 1) rawSig = 'LONG';
  else if (longVotes >= 4 && longVotes >= shortVotes + 3) rawSig = 'LONG';
  
  if (shortVotes >= 5 && shortVotes > longVotes + 1) rawSig = 'SHORT';
  else if (shortVotes >= 4 && shortVotes >= longVotes + 3) rawSig = 'SHORT';
  
  var isChoppy = (regime.regime === 'RANGING' || (regime.regime === 'MIXED' && adx < 20));
  if (rawSig === 'WAIT' && isChoppy && bb5.mid > 0) {
    var nearLower = price <= bb5.lower * 1.002;
    var nearUpper = price >= bb5.upper * 0.998;
    if (nearLower && rsi5 <= 40 && stochRsi5 <= 30) { rawSig = 'LONG'; strategy = 'RANGE'; }
    else if (nearUpper && rsi5 >= 60 && stochRsi5 >= 70) { rawSig = 'SHORT'; strategy = 'RANGE'; }
  }
  
  if (rawSig === 'WAIT' && volSpike.spike && volSpike.ratio >= 2.5) {
    if (last.c > prev.c && sl5 > 0) { rawSig = 'LONG'; strategy = 'BREAKOUT'; }
    else if (last.c < prev.c && sl5 < 0) { rawSig = 'SHORT'; strategy = 'BREAKOUT'; }
  }
  
  if (rawSig === 'WAIT') {
    if ((pattern === 'BULLISH_ENGULFING' || pattern === 'MORNING_STAR') && vr >= 0.8 && adx >= 15) {
      rawSig = 'LONG'; strategy = 'PATTERN';
    }
    if ((pattern === 'BEARISH_ENGULFING' || pattern === 'EVENING_STAR') && vr >= 0.8 && adx >= 15) {
      rawSig = 'SHORT'; strategy = 'PATTERN';
    }
  }
  
  var tfCount = rawSig === 'WAIT' ? 0 : 1;
  if (trend15 === rawSig) tfCount++;
  if (bias1h === rawSig) tfCount++;
  if (trend4h === rawSig) tfCount++;
  
  var reasons = [], score = 0;
  
  if (rawSig !== 'WAIT' && strategy === 'TREND') {
    score += 8;
    reasons.push({t: '5M_' + rawSig, cls: rawSig.toLowerCase()});
    if (trend15 === rawSig) { score += 12; reasons.push({t: '15M_ALIGN', cls: rawSig.toLowerCase()}); }
    else if (trend15 !== 'WAIT') { score += 4; reasons.push({t: '15M_' + trend15, cls: 'neut'}); }
    if (bias1h === rawSig) { score += 14; reasons.push({t: '1H_ALIGN', cls: rawSig.toLowerCase()}); }
    else if (bias1h !== 'WAIT') { score += 5; reasons.push({t: '1H_' + bias1h, cls: 'neut'}); }
    if (trend4h === rawSig) { score += 10; reasons.push({t: '4H_ALIGN', cls: rawSig.toLowerCase()}); }
    
    var macdDir = rawSig === 'LONG' ? macd5.hist > 0 : macd5.hist < 0;
    var macdExpand = rawSig === 'LONG' ? macd5.hist > macd5.prev : macd5.hist < macd5.prev;
    if (macdDir) { score += macdExpand ? 10 : 6; reasons.push({t: macdExpand ? 'MACD_EXP' : 'MACD_DIR', cls: rawSig.toLowerCase()}); }
    
    if (adx >= 30) { score += 10; reasons.push({t: 'ADX_HIGH', cls: 'strong'}); }
    else if (adx >= 20) { score += 6; reasons.push({t: 'ADX_OK', cls: 'neut'}); }
    
    if (vr >= 1.8) score += 12;
    else if (vr >= 1.25) score += 9;
    else if (vr >= 0.90) score += 6;
    else if (vr >= 0.65) score += 3;
    else score += 1;
    reasons.push({t: 'VOL:' + vr.toFixed(2) + 'x', cls: vr >= 1.25 ? 'long' : vr >= 0.65 ? 'neut' : 'warn'});
    
    if (bull2 || bear2) { score += 3; reasons.push({t: '2_CANDLE', cls: rawSig.toLowerCase()}); }
    if (breakoutLong || breakoutShort) { score += 6; reasons.push({t: 'BREAKOUT', cls: rawSig.toLowerCase()}); }
    if ((goldenX && rawSig === 'LONG') || (deathX && rawSig === 'SHORT')) { score += 8; reasons.push({t: 'FRESH_X', cls: 'strong'}); }
    if (roc10 > 1.5 || roc10 < -1.5) { score += 5; reasons.push({t: 'MOM:' + roc10.toFixed(1), cls: rawSig.toLowerCase()}); }
    
  } else if (rawSig !== 'WAIT' && strategy === 'RANGE') {
    reasons.push({t: 'RANGE_FADE', cls: rawSig.toLowerCase()});
    score += 18;
    if (vr >= 0.8) { score += 6; reasons.push({t: 'VOL_OK', cls: 'neut'}); }
    reasons.push({t: 'REGIME:RANGE', cls: 'warn'});
    
  } else if (rawSig !== 'WAIT' && strategy === 'BREAKOUT') {
    reasons.push({t: 'VOL_BREAKOUT', cls: 'strong'});
    score += 25;
    reasons.push({t: 'VOL:' + volSpike.ratio.toFixed(2) + 'x', cls: 'strong'});
    if (adx >= 20) { score += 5; reasons.push({t: 'ADX_OK', cls: 'neut'}); }
    
  } else if (rawSig !== 'WAIT' && strategy === 'PATTERN') {
    reasons.push({t: 'PATTERN:' + pattern, cls: 'strong'});
    score += 22;
    if (vr >= 1.0) { score += 5; reasons.push({t: 'VOL_OK', cls: 'neut'}); }
  }
  
  var rsiIdeal = rawSig === 'LONG' ? (rsi5 >= 35 && rsi5 <= 68) : (rsi5 >= 25 && rsi5 <= 58);
  score += rsiIdeal ? 5 : 2;
  reasons.push({t: 'RSI:' + rsi5.toFixed(0), cls: rsiIdeal ? rawSig.toLowerCase() : 'neut'});
  
  if ((rawSig === 'LONG' && stochRsi5 < 50) || (rawSig === 'SHORT' && stochRsi5 > 50)) {
    score += 3;
    reasons.push({t: 'StRSI_OK', cls: rawSig.toLowerCase()});
  }
  
  score = clampNum(Math.round(score), 0, 100);
  
  var ctx = {
    price: price, score: score, reasons: reasons, atrPct: atrPct, atrVal: atr5, vr: vr, adx: adx,
    tfCount: tfCount, rsi5: rsi5, rsi15: rsi15, macd5: macd5,
    macdLabel: (macd5.hist >= 0 ? '+' : '') + macd5.hist.toFixed(5),
    goldenX: goldenX, deathX: deathX, aboveEMA: aboveEMA,
    bbSqueeze: bb5.squeeze, sl5: sl5, stochRsi5: stochRsi5,
    trend5: trend5, trend15: trend15, bias1h: bias1h, trend4h: trend4h,
    regime: regime.regime, strategy: strategy, volSpike: volSpike,
    roc10: roc10, pattern: pattern
  };
  
  if (rawSig === 'WAIT') return waitResult(ctx, 'NO_DIR');
  
  var minScoreThreshold = strategy === 'RANGE' ? Math.max(20, Math.min(minScore, 60)) : 
                         strategy === 'BREAKOUT' ? Math.max(30, Math.min(minScore, 70)) : 
                         strategy === 'PATTERN' ? Math.max(25, Math.min(minScore, 65)) :
                         Math.max(25, minScore);
  
  if (score < minScoreThreshold) return waitResult(ctx, 'SCORE:' + score);
  if (strategy === 'TREND' && vr < 0.55) return waitResult(ctx, 'VOL_LOW');
  if (strategy !== 'BREAKOUT' && vr < 0.35) return waitResult(ctx, 'VOL_LOW');
  if (strategy === 'TREND' && tfCount < 1) return waitResult(ctx, 'TF_ALIGN');
  
  var atrMult = atrPct < 0.08 ? 1.6 : atrPct < 0.18 ? 1.4 : atrPct < 0.40 ? 1.2 : 1.0;
  var slDist = Math.max(atr5 * atrMult * riskMult, price * 0.0015);
  slDist = Math.min(slDist, price * 0.025);
  
  if (strategy === 'RANGE') {
    slDist = Math.max(rawSig === 'LONG' ? (price - bb5.lower) * 0.85 : (bb5.upper - price) * 0.85, price * 0.001);
    slDist = Math.min(slDist, price * 0.015);
  }
  
  var recoveryMult = CFG.recoveryMode ? 0.5 : 1;
  var cRate = costRate();
  var stats = getScoreStats(score);
  var kelly = kellyRisk(stats.winRate, stats.avgWin, stats.avgLoss);
  var volMult = volatilityMultiplier(atr5, pData[sym].atrAvg);
  var lossMult = lossMultiplier();
  var regimeMult = regime.regime === 'VOLATILE' ? 0.55 : regime.regime === 'RANGING' ? 0.75 : 1.0;
  var adxMult = strategy === 'RANGE' ? 0.8 : (adx >= 30 ? 1.25 : adx >= 20 ? 1.0 : 0.65);
  
  var dynamicRiskRatio = Math.min(kelly * volMult * lossMult * regimeMult * adxMult * recoveryMult, 0.03);
  var dynamicRiskAmount = Math.max(0, balance * dynamicRiskRatio);
  var finalRiskAmount = Math.max(dynamicRiskAmount, 0.01);
  var riskNotional = finalRiskAmount / Math.max((slDist / price) + cRate, 0.00005);
  
  var baseCap = maxPosSize > 0 ? maxPosSize : 999999;
  var marginCap = Math.max(0, balance) * 0.55 * Math.max(1, Math.min(15, (typeof leverage !== 'undefined' ? leverage : 3)));
  var posVal = Math.max(MIN_POS_VAL, Math.min(riskNotional, baseCap, marginCap));
  var qty = posVal / price;
  var estimatedCosts = posVal * cRate;
  
  var targetMultFinal = num(targetMult, 1.5);
  var tpDist = strategy === 'RANGE' ? Math.max(Math.abs(bb5.mid - price) * 0.85, slDist * 1.1) : 
               Math.max(slDist * 1.5, atr5 * targetMultFinal);
  tpDist = Math.min(tpDist, price * 0.06);
  
  var autoLeverage = maxLeverage > 0 ? Math.min(maxLeverage, 15) : 
                     (strategy === 'RANGE' ? 2 : strategy === 'BREAKOUT' ? 5 : (adx >= 30 ? 5 : adx >= 20 ? 3 : 2));
  if (atrPct < 0.05) autoLeverage = Math.min(autoLeverage * 2, 20);
  if (atrPct > 0.5) autoLeverage = Math.max(1, Math.floor(autoLeverage / 2));
  var finalLeverage = clampNum(autoLeverage, 1, 25);
  
  var sl = rawSig === 'LONG' ? price - slDist : price + slDist;
  var tp = rawSig === 'LONG' ? price + tpDist : price - tpDist;
  
  var out = resultBase(ctx);
  out.signal = rawSig;
  out.tier = tierOf(score);
  out.strategy = strategy;
  out.sl = sl; out.tp = tp; out.slDist = slDist; out.tpDist = tpDist;
  out.posVal = posVal; out.qty = qty; out.comm = posVal * CFG.feeRate * 2;
  out.marginUsed = posVal / Math.max(1, finalLeverage);
  out.rrActual = tpDist / slDist;
  out.estProfit = (tpDist * qty) - estimatedCosts;
  out.estRisk = (slDist * qty) + estimatedCosts;
  out.estimatedCosts = estimatedCosts;
  out.regime = regime;
  out.adx = adx;
  out.recoveryMode = CFG.recoveryMode;
  out.leverage = finalLeverage;
  return out;
}

function getScoreStats(score) {
  var filtered = trades.filter(function(t) {
    if (!t.score) return false;
    return t.score >= score - 20 && t.score < score + 20;
  });
  if (filtered.length < 8) {
    if (score >= 75) return { winRate: 0.60, avgWin: 2.0, avgLoss: 1.0 };
    if (score >= 55) return { winRate: 0.48, avgWin: 1.5, avgLoss: 1.2 };
    return { winRate: 0.38, avgWin: 1.0, avgLoss: 1.5 };
  }
  var wins = filtered.filter(function(t) { return t.pnl > 0; });
  var losses = filtered.filter(function(t) { return t.pnl <= 0; });
  var winRate = wins.length / filtered.length;
  var avgWin = wins.reduce(function(s, t) { return s + t.pnl; }, 0) / (wins.length || 1);
  var avgLoss = Math.abs(losses.reduce(function(s, t) { return s + t.pnl; }, 0) / (losses.length || 1));
  return { winRate: winRate, avgWin: avgWin, avgLoss: avgLoss };
}

function kellyRisk(winRate, avgWin, avgLoss) {
  if (avgWin <= 0 || avgLoss <= 0) return 0.005;
  var k = winRate - ((1 - winRate) / (avgWin / avgLoss));
  return Math.max(0.003, k * 0.5);
}

function volatilityMultiplier(currentAtr, avgAtr) {
  if (avgAtr <= 0) return 1;
  var ratio = currentAtr / avgAtr;
  if (ratio > 1.5) return 0.45;
  if (ratio > 1.2) return 0.65;
  if (ratio < 0.8) return 1.0;
  return 0.8;
}

function lossMultiplier() {
  var consecutive = 0;
  for (var i = trades.length - 1; i >= 0; i--) {
    if (trades[i].pnl < 0) consecutive++;
    else break;
  }
  if (consecutive >= 3) { CFG.recoveryMode = true; return 0.25; }
  if (consecutive === 2) return 0.45;
  if (consecutive === 1) return 0.7;
  CFG.recoveryMode = false;
  return 1.0;
}
