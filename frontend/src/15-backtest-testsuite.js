/* ============================================================
   BACKTEST & TEST SUITE
   ============================================================ */
var Backtester = {
  run: function(sym) {
    var pd = pData[sym]; if (!pd || !pd.masterKlines || pd.masterKlines.length < 100) throw new Error('Not enough history');
    var one = pd.masterKlines.slice(), full5 = aggregateKlines(one, 5);
    var original = pData[sym], equity = START_BAL, peak = START_BAL, maxDD = 0;
    var start = Math.max(60, full5.length - 200), trades_count = 0, wins = 0;
    for (var i = start; i < full5.length - 2; i++) {
      var t = full5[i].t;
      pData[sym] = {price: full5[i].c, kl5m: full5.slice(0, i + 1), kl15m: aggregateKlines(one, 15).filter(function(k) { return k.t <= t; }), kl1h: aggregateKlines(one, 60).filter(function(k) { return k.t <= t; }), dataUpdatedAt: Date.now()};
      var an = null; try { an = analyze(sym); } catch(e) {}
      if (!an || an.signal === 'WAIT') continue;
      var entry = full5[i + 1].o, side = an.signal;
      entry *= 1 + (side === 'LONG' ? 1 : -1) * (CFG.spreadBps / 2 + CFG.slippageBps) / 10000;
      var qty = an.posVal / entry, exit = full5[i + 1].c, exitIndex = i + 1;
      var sl = side === 'LONG' ? entry - Math.abs(an.price - an.sl) : entry + Math.abs(an.price - an.sl);
      var tp = side === 'LONG' ? entry + Math.abs(an.tp - an.price) : entry - Math.abs(an.tp - an.price);
      for (var j = i + 1; j < Math.min(full5.length, i + 25); j++) {
        var k = full5[j], hitSL = side === 'LONG' ? k.l <= sl : k.h >= sl, hitTP = side === 'LONG' ? k.h >= tp : k.l <= tp;
        if (hitSL && hitTP) { exit = sl; exitIndex = j; break; }
        if (hitSL) { exit = sl; exitIndex = j; break; }
        if (hitTP) { exit = tp; exitIndex = j; break; }
        exit = k.c; exitIndex = j;
      }
      exit *= 1 - (side === 'LONG' ? 1 : -1) * (CFG.spreadBps / 2 + CFG.slippageBps) / 10000;
      var gross = Accounting.grossPnl(side, entry, exit, qty), fees = Accounting.entryFee(an.posVal) + Accounting.exitFee(qty, exit), net = gross - fees;
      equity += net; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak * 100);
      trades_count++; if (net > 0) wins++;
      i = exitIndex;
    }
    pData[sym] = original;
    return {trades: trades_count, wins: wins, winRate: trades_count ? wins / trades_count * 100 : 0, net: equity - START_BAL, maxDD: maxDD};
  }
};

var TestSuite = {
  assert: function(name, fn) {
    try { fn(); Runtime.tests.push({name: name, ok: true}); }
    catch(e) { Runtime.tests.push({name: name, ok: false, error: e.message}); }
  },
  near: function(a, b, eps) { if (Math.abs(a - b) > (eps || 1e-9)) throw new Error(a + ' != ' + b); },
  run: function() {
    Runtime.tests = [];
    TestSuite.assert('Flat trade loses two fees', function() {
      var p = {side: 'LONG', entry: 100, qty: 0.1, posVal: 10, feeRate: 0.0004, entryFee: 0.004};
      var b = Accounting.closeBreakdown(p, 100, 0);
      TestSuite.near(b.tradeNet, -0.008, 1e-10);
    });
    TestSuite.assert('PnL signs correct', function() {
      TestSuite.near(Accounting.grossPnl('LONG', 100, 101, 1), 1);
      TestSuite.near(Accounting.grossPnl('SHORT', 100, 99, 1), 1);
    });
    TestSuite.assert('Min pos size > 0', function() {
      if (MIN_POS_VAL <= 0) throw new Error('MIN_POS_VAL must be positive');
    });
    return Runtime.tests;
  }
};
