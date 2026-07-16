// ═══════════════════════════════════════════════════════════════
// APEX Worker v16.3 — Gate.io Futures USDT
//
// v16.3 FIX:
//   /order hata yanitinda minNotionalUsd alani kayboluyordu (err() helper
//   sadece {success:false, error} donduruyordu, executeOrder'in hesapladigi
//   minNotionalUsd sessizce atiliyordu). Artik frontend, "pozisyon cok kucuk"
//   hatasi aldiginda bu coin icin gercek minimum nominal degeri gorebiliyor
//   ve MIN_POS_VAL'i buna gore kendini otomatik kalibre edebiliyor.
//
// v16.2 FIX (bu surumde duzeltilen 2 gercek bug):
// ─────────────────────────────────────────────────────────────
// BUG 1 — fillPrice eksikligi (KRITIK, her canli islemi etkiliyor):
//   Frontend /order yanitinda `r.fillPrice` bekliyordu:
//     if (r.fillPrice) pos.entry = Number(r.fillPrice);
//   Worker ise sadece `price` alaniyla donuyordu, `fillPrice` hic
//   yoktu. Sonuc: pozisyonun gercek giris fiyati hicbir zaman
//   guncellenmiyordu, uygulama sinyal anindaki tahmini fiyati
//   "entry" saniyordu. Her canli islemde PnL ve SL/TP mesafesi
//   hafif kayikti. v16.2'de hem /order hem /close yanitina
//   `fillPrice` (ve /close icin `trade.exitPrice`) eklendi.
//
// BUG 2 — /gateio_tickers endpoint'i hic yoktu:
//   Frontend'deki "TOP VOLUME" butonu bu endpoint'i cagiriyordu,
//   worker'da karsiligi olmadigi icin surekli 404 donuyordu.
//   v16.2'de eklendi (Gate.io'nun public /tickers'ini frontend'in
//   bekledigi alan adlariyla — last_price, volume_24h_quote —
//   normalize ederek donuyor).
// ═══════════════════════════════════════════════════════════════
//
// v16.1 ozellikleri (korundu): /ping features objesi
// v16.0 ozellikleri (korundu): /batch-prices, /snapshot, KV cache
// v15.8 ozellikleri (korundu): executeOrder, closePosition, partialClose,
//                               update_tpsl, sync-positions
// ═══════════════════════════════════════════════════════════════

const GATE_BASE   = "https://api.gateio.ws/api/v4/futures/usdt";
const SPOT_BASE   = "https://api.gateio.ws/api/v4/spot";
const SPOT_API_V4 = "/api/v4/spot";
const GATE_API_V4 = "/api/v4/futures/usdt";

const TICKER_CACHE_TTL = 3;

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const p    = url.pathname;
    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };
    const ok  = d => new Response(JSON.stringify({ success: true,  ...d }), { headers: cors });
    const err = (m, extra) => new Response(JSON.stringify({ success: false, error: m, ...(extra || {}) }), { headers: cors });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // ── /ping ─────────────────────────────────────────────────
    if (p === "/ping" || p === "/health") {
      return ok({
        status: "APEX Worker v17.0 (Gate.io Futures + Spot)",
        version: "17.0",
        features: {
          snapshot: true,
          batchPrices: true,
          gateioTickers: true,
          spot: true,   // v17.0: yeni — spot piyasa destegi
          state: false,
          riskUpdate: false,
          kill: false
        },
        endpoints: [
          "/ping","/health","/price","/klines","/scan",
          "/snapshot","/batch-prices","/gateio_tickers",
          "/balance","/open_positions","/order","/close",
          "/partial-close","/update_tpsl","/sync-positions",
          "/spot/price","/spot/klines","/spot/tickers",
          "/spot/balance","/spot/order","/spot/close"
        ]
      });
    }

    // ── /price ───────────────────────────────────────────────
    if (p === "/price") {
      const sym = toGate(url.searchParams.get("symbol") || "BTCUSDT");
      try {
        const price = await fetchPrice(sym, env);
        return ok({ data: { symbol: sym, lastPrice: price, price, markPrice: price } });
      } catch(e) { return err(e.message); }
    }

    // ── /klines ──────────────────────────────────────────────
    if (p === "/klines") {
      const sym      = toGate(url.searchParams.get("symbol") || "BTCUSDT");
      const interval = url.searchParams.get("interval") || "5m";
      const limit    = url.searchParams.get("limit") || "200";
      try {
        const res  = await fetch(`${GATE_BASE}/candlesticks?contract=${sym}&interval=${interval}&limit=${limit}`);
        const raw  = await safeJson(res, "klines");
        const data = raw.map(k => [k.t * 1000, k.o, k.h, k.l, k.c, k.v]);
        return ok({ data });
      } catch(e) { return err(e.message); }
    }

    // ── /gateio_tickers ──────────────────────────────────────
    // v16.2: yeni. Frontend'deki fetchTopCoins() bu endpoint'i cagirir
    // ve her eleman icin c.contract, c.last_price, c.volume_24h_quote
    // alanlarini okur. Gate.io'nun ham /tickers yaniti "last" alanini
    // kullaniyor (last_price degil) — burada normalize ediyoruz.
    if (p === "/gateio_tickers") {
      try {
        const res = await fetch(`${GATE_BASE}/tickers`);
        const raw = await safeJson(res, "gateio_tickers");
        const data = raw.map(t => ({
          contract: t.contract,
          symbol: t.contract,
          last_price: parseFloat(t.last || 0),
          last: t.last,
          volume_24h_quote: parseFloat(t.volume_24h_quote || 0),
          volume_24h_base: parseFloat(t.volume_24h_base || 0),
          change_percentage: parseFloat(t.change_percentage || 0)
        }));
        return ok({ data });
      } catch(e) { return err(e.message); }
    }

    // ── /spot/price ──────────────────────────────────────────
    // v17.0: Spot ticker fiyati. Futures'tan farkli endpoint (/spot/tickers).
    if (p === "/spot/price") {
      const sym = toGate(url.searchParams.get("symbol") || "BTC_USDT");
      try {
        const res = await fetch(`${SPOT_BASE}/tickers?currency_pair=${sym}`);
        const raw = await safeJson(res, "spot/price");
        const row = Array.isArray(raw) ? raw[0] : null;
        if (!row) return err("Fiyat alınamadı: " + sym);
        const price = parseFloat(row.last);
        return ok({ data: { symbol: sym, lastPrice: price, price } });
      } catch(e) { return err(e.message); }
    }

    // ── /spot/klines ─────────────────────────────────────────
    // v17.0: ONEMLI — Gate.io spot candlesticks futures'tan FARKLI dizi
    // sirasinda doner: [timestamp, volume, close, high, low, open].
    // Futures'ta oldugu gibi {t,o,h,l,c,v} objeye burada normalize ediyoruz
    // ki frontend hangi piyasadan geldigini bilmeden ayni sekilde kullansin.
    if (p === "/spot/klines") {
      const sym      = toGate(url.searchParams.get("symbol") || "BTC_USDT");
      const interval = url.searchParams.get("interval") || "5m";
      const limit    = url.searchParams.get("limit") || "200";
      try {
        const res = await fetch(`${SPOT_BASE}/candlesticks?currency_pair=${sym}&interval=${interval}&limit=${limit}`);
        const raw = await safeJson(res, "spot/klines");
        const data = raw.map(arr => {
          const t = parseInt(arr[0]) * 1000;
          const v = parseFloat(arr[1]);
          const c = parseFloat(arr[2]);
          const h = parseFloat(arr[3]);
          const l = parseFloat(arr[4]);
          const o = parseFloat(arr[5]);
          return [t, o, h, l, c, v];
        });
        return ok({ data });
      } catch(e) { return err(e.message); }
    }

    // ── /spot/tickers ────────────────────────────────────────
    if (p === "/spot/tickers") {
      try {
        const res = await fetch(`${SPOT_BASE}/tickers`);
        const raw = await safeJson(res, "spot/tickers");
        const data = raw.map(t => ({
          contract: t.currency_pair,
          symbol: t.currency_pair,
          last_price: parseFloat(t.last || 0),
          last: t.last,
          volume_24h_quote: parseFloat(t.quote_volume || 0),
          volume_24h_base: parseFloat(t.base_volume || 0),
          change_percentage: parseFloat(t.change_percentage || 0)
        }));
        return ok({ data });
      } catch(e) { return err(e.message); }
    }

    // ── /batch-prices ────────────────────────────────────────
    if (p === "/batch-prices") {
      const rawSyms  = url.searchParams.get("symbols") || "";
      const symList  = rawSyms.split(",").map(s => toGate(s.trim())).filter(Boolean);
      if (!symList.length) return err("symbols parametresi gerekli");
      try {
        const results = await Promise.allSettled(
          symList.map(sym => fetchPrice(sym, env).then(price => ({ sym, price })))
        );
        const prices = {};
        for (const r of results) {
          if (r.status === "fulfilled") prices[r.value.sym] = r.value.price;
        }
        return ok({ prices });
      } catch(e) { return err(e.message); }
    }

    // ── /snapshot ────────────────────────────────────────────
    if (p === "/snapshot") {
      const rawSyms  = url.searchParams.get("symbols") || "BTC_USDT";
      const rawTfs   = url.searchParams.get("tfs") || "5m,15m,1h";
      const limit    = parseInt(url.searchParams.get("limit") || "200");
      const symList  = rawSyms.split(",").map(s => toGate(s.trim())).filter(Boolean).slice(0, 20);
      const tfList   = rawTfs.split(",").map(s => s.trim()).filter(Boolean);

      const tasks = [];
      for (const sym of symList) {
        tasks.push(fetchPrice(sym, env).then(price => ({ sym, field: "price", value: price })));
        for (const tf of tfList) {
          tasks.push(
            fetch(`${GATE_BASE}/candlesticks?contract=${sym}&interval=${tf}&limit=${limit}`)
              .then(r => safeJson(r, `${sym}/${tf}`))
              .then(raw => ({ sym, field: tf, value: raw.map(k => [k.t * 1000, k.o, k.h, k.l, k.c, k.v]) }))
              .catch(() => ({ sym, field: tf, value: [] }))
          );
        }
      }

      const settled = await Promise.allSettled(tasks);
      const market  = {};
      for (const r of settled) {
        if (r.status !== "fulfilled") continue;
        const { sym, field, value } = r.value;
        if (!market[sym]) market[sym] = {};
        market[sym][field] = value;
      }

      return ok({ serverTime: Date.now(), market });
    }

    // ── /scan ────────────────────────────────────────────────
    if (p === "/scan") {
      const pairsParam = url.searchParams.get("pairs");
      const pairs = pairsParam
        ? pairsParam.split(",")
        : ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"];
      try {
        const results = await scanPairs(pairs);
        return ok({ results, count: results.length });
      } catch(e) { return err(e.message); }
    }

    // ── Auth gerektiren endpoint'ler ─────────────────────────
    if (!env.GATE_API_KEY || !env.GATE_SECRET) return err("API key eksik");

    // ── /balance ─────────────────────────────────────────────
    if (p === "/balance") {
      try {
        const acc   = await callGate(env, "GET", "/accounts", {});
        const avail = parseFloat(acc.available || 0);
        const total = parseFloat(acc.total || 0);
        return ok({
          balance: avail > 0 ? avail : total,
          data: { availableBalance: avail, totalWalletBalance: total, walletBalance: total, asset: "USDT" }
        });
      } catch(e) { return err("Balance hatası: " + e.message); }
    }

    // ── /spot/balance ────────────────────────────────────────
    // v17.0: futures /balance'tan farkli — spot'ta "bakiye" tek bir
    // sayı değil, elinizdeki TUM coin'lerin toplami. USDT + varsa
    // elde tutulan coin'leri (holdings) ayri ayri donuyoruz.
    if (p === "/spot/balance") {
      try {
        const accounts = await callGateSpot(env, "GET", "/accounts", {});
        const nonZero = (Array.isArray(accounts) ? accounts : [])
          .filter(a => parseFloat(a.available) > 0 || parseFloat(a.locked) > 0)
          .map(a => ({ currency: a.currency, available: parseFloat(a.available), locked: parseFloat(a.locked) }));
        const usdt = nonZero.find(a => a.currency === "USDT");
        return ok({
          balance: usdt ? usdt.available : 0,
          holdings: nonZero,
          data: { availableBalance: usdt ? usdt.available : 0, asset: "USDT" }
        });
      } catch(e) { return err("Spot balance hatası: " + e.message); }
    }

    // ── /spot/order ──────────────────────────────────────────
    if (p === "/spot/order" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return err("JSON hatası"); }
      try {
        const result = await executeSpotOrder(env, body);
        if (!result.success) return err(result.error, { minNotionalUsd: result.minNotionalUsd });
        return ok(result);
      } catch(e) { return err(e.message); }
    }

    // ── /spot/close ──────────────────────────────────────────
    // Spot'ta "pozisyon kapatma" kavramı yok — elinizdeki coin'i geri
    // USDT'ye satmak demektir. Elde tuttugunuz TUM miktari satar.
    if (p === "/spot/close" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return err("JSON hatası"); }
      try {
        const result = await closeSpotPosition(env, body.symbol);
        if (!result.success) return err(result.error);
        return ok(result);
      } catch(e) { return err(e.message); }
    }

    // ── /open_positions ──────────────────────────────────────
    if (p === "/open_positions") {
      try {
        const [posList, acc] = await Promise.all([
          callGate(env, "GET", "/positions", {}),
          callGate(env, "GET", "/accounts", {})
        ]);
        const open     = Array.isArray(posList) ? posList.filter(x => parseFloat(x.size) !== 0) : [];
        const enriched = open.map(pos => ({
          symbol:          fromGate(pos.contract),
          side:            parseFloat(pos.size) > 0 ? "LONG" : "SHORT",
          positionAmt:     String(pos.size),
          entryPrice:      pos.entry_price,
          markPrice:       pos.mark_price,
          unrealizedProfit:pos.unrealised_pnl,
          leverage:        pos.leverage,
          liquidationPrice:pos.liq_price
        }));
        const walletBal = parseFloat(acc.available || acc.total || 0);
        return ok({ data: enriched, count: enriched.length, walletBalance: walletBal });
      } catch(e) { return err("open_positions hatası: " + e.message); }
    }

    // ── /update_tpsl ─────────────────────────────────────────
    if (p === "/update_tpsl" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return err("JSON hatası"); }
      const { symbol, side, tp, sl } = body;
      if (!symbol || !side) return err("symbol/side eksik");
      const gSym  = toGate(symbol);
      const xSide = side === "LONG" ? -1 : 1;
      const errors = [], updated = [];

      try { await callGate(env, "DELETE", "/orders", { contract: gSym, side: "all" }); } catch(e) { errors.push("Emirler iptal edilemedi"); }
      await sleep(120);

      let posAmt = 0;
      try {
        const posList = await callGate(env, "GET", "/positions", {});
        const pos = Array.isArray(posList)
          ? posList.find(x => x.contract === gSym && parseFloat(x.size) !== 0)
          : null;
        if (pos) posAmt = Math.abs(parseFloat(pos.size));
      } catch(e) { errors.push("Pozisyon miktarı alınamadı"); }

      if (sl && posAmt > 0) {
        try {
          const slResult = await callGate(env, "POST", "/price_orders", {}, {
            initial: { contract: gSym, size: xSide * posAmt, price: "0", tif: "ioc", reduce_only: true },
            trigger: { strategy_type: 0, price_type: 1, price: String(parseFloat(sl).toFixed(8)), rule: side === "LONG" ? 2 : 1 },
            order_type: "close-long-order"
          });
          if (slResult.id) updated.push({ type: "SL", price: sl, orderId: slResult.id });
          else errors.push("SL: " + JSON.stringify(slResult));
        } catch(e) { errors.push("SL hata: " + e.message); }
        await sleep(80);
      }

      if (tp && posAmt > 0) {
        try {
          const tpResult = await callGate(env, "POST", "/price_orders", {}, {
            initial: { contract: gSym, size: xSide * posAmt, price: "0", tif: "ioc", reduce_only: true },
            trigger: { strategy_type: 0, price_type: 1, price: String(parseFloat(tp).toFixed(8)), rule: side === "LONG" ? 1 : 2 },
            order_type: "close-long-order"
          });
          if (tpResult.id) updated.push({ type: "TP", price: tp, orderId: tpResult.id });
          else errors.push("TP: " + JSON.stringify(tpResult));
        } catch(e) { errors.push("TP hata: " + e.message); }
      }
      return ok({ updated, errors });
    }

    // ── /order ───────────────────────────────────────────────
    if (p === "/order" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return err("JSON hatası"); }
      try {
        const result = await executeOrder(env, body);
        if (!result.success) return err(result.error, { minNotionalUsd: result.minNotionalUsd });
        return ok(result);
      } catch(e) { return err(e.message); }
    }

    // ── /close ───────────────────────────────────────────────
    if (p === "/close" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return err("JSON hatası"); }
      try {
        const result = await closePosition(env, body.symbol, body.side);
        if (!result.success) return err(result.error);
        return ok(result);
      } catch(e) { return err(e.message); }
    }

    // ── /partial-close ───────────────────────────────────────
    if (p === "/partial-close" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return err("JSON hatası"); }
      try {
        const result = await partialClose(env, body.symbol, body.side, body.pct || 0.5);
        if (!result.success) return err(result.error);
        return ok(result);
      } catch(e) { return err(e.message); }
    }

    // ── /sync-positions ──────────────────────────────────────
    if (p === "/sync-positions") {
      try {
        const pos  = await callGate(env, "GET", "/positions", {});
        const open = Array.isArray(pos) ? pos.filter(x => parseFloat(x.size) !== 0) : [];
        return ok({ positions: open, count: open.length });
      } catch(e) { return err(e.message); }
    }

    return new Response(
      JSON.stringify({ error: "endpoint bulunamadı: " + p }),
      { status: 404, headers: cors }
    );
  }
};

// ─────────────────────────────────────────────────────────────
async function fetchPrice(gSym, env) {
  const cacheKey = "px:" + gSym;
  if (env && env.APEX_KV) {
    try {
      const cached = await env.APEX_KV.get(cacheKey, { type: "json" });
      if (cached && cached.price && (Date.now() - cached.ts) < TICKER_CACHE_TTL * 1000) {
        return cached.price;
      }
    } catch (_) {}
  }
  const res   = await fetch(`${GATE_BASE}/contracts/${gSym}`);
  const data  = await safeJson(res, "contract/" + gSym);
  const price = parseFloat(data.mark_price || data.last || 0);
  if (!price) throw new Error("Fiyat alınamadı: " + gSym);
  if (env && env.APEX_KV) {
    env.APEX_KV.put(cacheKey, JSON.stringify({ price, ts: Date.now() }), {
      expirationTtl: TICKER_CACHE_TTL * 2
    }).catch(() => {});
  }
  return price;
}

// ─────────────────────────────────────────────────────────────
// executeSpotOrder — v17.0 (yeni)
// ─────────────────────────────────────────────────────────────
// KRITIK: Gate.io spot market emirlerinde "amount" alaninin anlami
// side'a gore DEGISIR:
//   side=buy  -> amount = QUOTE para birimi miktari (BTC_USDT icin USDT)
//   side=sell -> amount = BASE para birimi miktari (BTC_USDT icin BTC)
// Bu, futures'taki (her zaman kontrat/coin miktari) mantigindan farkli.
// Yanlis yorumlanirsa ya cok fazla ya da cok az emir verilir.
async function executeSpotOrder(env, body) {
  const { symbol, side, usdAmount } = body || {};
  if (!symbol || !side) return { success: false, error: "symbol/side eksik" };
  if (!usdAmount) return { success: false, error: "usdAmount gerekli" };

  const gSym = toGate(symbol);
  const sideLower = String(side).toLowerCase();
  if (sideLower !== "buy" && sideLower !== "sell") {
    return { success: false, error: "side BUY veya SELL olmalı" };
  }

  let pairInfo;
  try { pairInfo = await callGateSpot(env, "GET", `/currency_pairs/${gSym}`, {}); }
  catch(e) { return { success: false, error: `Sembol bulunamadı: ${gSym} — ${e.message}` }; }

  if (pairInfo.trade_status && pairInfo.trade_status !== "tradable") {
    return { success: false, error: `${gSym} şu an işlem görmüyor (${pairInfo.trade_status})` };
  }

  const minBase          = parseFloat(pairInfo.min_base_amount  || 0);
  const minQuote         = parseFloat(pairInfo.min_quote_amount || 0);
  const amountPrecision  = Number.isFinite(parseInt(pairInfo.amount_precision)) ? parseInt(pairInfo.amount_precision) : 6;

  let currentPrice = 0;
  try {
    const tkRes = await fetch(`${SPOT_BASE}/tickers?currency_pair=${gSym}`);
    const tk    = await safeJson(tkRes, "spot ticker");
    currentPrice = parseFloat(tk?.[0]?.last || 0);
  } catch(e) {}
  if (!currentPrice) return { success: false, error: "Fiyat alınamadı" };

  let orderAmount;
  if (sideLower === "buy") {
    orderAmount = parseFloat(usdAmount);
    if (minQuote && orderAmount < minQuote) {
      return {
        success: false,
        error: `Minimum işlem tutarı $${minQuote} (girilen: $${orderAmount.toFixed(2)})`,
        minNotionalUsd: minQuote
      };
    }
  } else {
    const rawAmount = parseFloat(usdAmount) / currentPrice;
    const step = Math.pow(10, -amountPrecision);
    orderAmount = Math.floor(rawAmount / step) * step;
    const minFromQuote  = minQuote ? minQuote / currentPrice : 0;
    const effectiveMin  = Math.max(minBase, minFromQuote);
    if (orderAmount < effectiveMin) {
      const minUsd = effectiveMin * currentPrice;
      return {
        success: false,
        error: `Minimum satış miktarı ${effectiveMin} ${gSym.split("_")[0]} (~$${minUsd.toFixed(2)})`,
        minNotionalUsd: minUsd
      };
    }
  }

  let order;
  try {
    order = await callGateSpot(env, "POST", "/orders", {}, {
      currency_pair: gSym, type: "market", account: "spot",
      side: sideLower, amount: String(orderAmount), time_in_force: "ioc"
    });
  } catch(e) { return { success: false, error: `Order gönderilemedi: ${e.message}` }; }

  if (order.label) return { success: false, error: "Order hatası: " + (order.message || order.label) };

  const fillPrice   = parseFloat(order.avg_deal_price || 0) || currentPrice;
  const filledBase  = parseFloat(order.filled_amount || (sideLower === "sell" ? orderAmount : 0)) || 0;
  const filledQuote = parseFloat(order.filled_total  || (sideLower === "buy"  ? orderAmount : 0)) || 0;

  return {
    success: true, order, orderId: order.id || null,
    side: sideLower.toUpperCase(), symbol: gSym,
    fillPrice, price: fillPrice, filledBase, filledQuote
  };
}

// closeSpotPosition — spot'ta "kapatma" = elde tutulan coin'i geri
// USDT'ye satmak. Futures'taki gibi ayri bir "pozisyon" kaydı yok,
// gercek kaynak her zaman Gate.io'daki gercek bakiyedir.
async function closeSpotPosition(env, symbol) {
  const gSym = toGate(symbol);
  const base = gSym.split("_")[0];

  let accounts;
  try { accounts = await callGateSpot(env, "GET", "/accounts", { currency: base }); }
  catch(e) { return { success: false, error: `Bakiye alınamadı: ${e.message}` }; }

  const acct = Array.isArray(accounts) ? accounts.find(a => a.currency === base) : null;
  const available = acct ? parseFloat(acct.available) : 0;
  if (!available || available <= 0) return { success: false, error: `Elinizde ${base} bulunmuyor` };

  let pairInfo = {};
  try { pairInfo = await callGateSpot(env, "GET", `/currency_pairs/${gSym}`, {}); } catch(e) {}
  const amountPrecision = Number.isFinite(parseInt(pairInfo.amount_precision)) ? parseInt(pairInfo.amount_precision) : 6;
  const step = Math.pow(10, -amountPrecision);
  const sellAmount = Math.floor(available / step) * step;

  if (sellAmount <= 0) return { success: false, error: "Satılabilir miktar çok küçük" };

  let order;
  try {
    order = await callGateSpot(env, "POST", "/orders", {}, {
      currency_pair: gSym, type: "market", account: "spot",
      side: "sell", amount: String(sellAmount), time_in_force: "ioc"
    });
  } catch(e) { return { success: false, error: `Satış emri başarısız: ${e.message}` }; }

  if (order.label) return { success: false, error: "Order hatası: " + (order.message || order.label) };

  const fillPrice   = parseFloat(order.avg_deal_price || 0) || null;
  const filledQuote = parseFloat(order.filled_total || 0) || 0;

  return {
    success: true, order, closedAmount: sellAmount,
    fillPrice, price: fillPrice, filledQuote, currency: base
  };
}

// ─────────────────────────────────────────────────────────────
// executeOrder — v16.2: fillPrice alani eklendi
// ─────────────────────────────────────────────────────────────
async function executeOrder(env, body) {
  let { symbol, side, leverage, usdAmount, quantity, tp, sl, tpPcts } = body;
  if (!symbol || !side) return { success: false, error: "symbol/side eksik" };
  if (!usdAmount && !quantity) return { success: false, error: "usdAmount gerekli" };

  const gSym  = toGate(symbol);
  const oSign = side === "LONG" ? 1 : -1;
  const xSign = side === "LONG" ? -1 : 1;

  let info;
  try { info = await callGate(env, "GET", `/contracts/${gSym}`, {}); }
  catch(e) { return { success: false, error: `Sembol bulunamadı: ${gSym} — ${e.message}` }; }

  const currentPrice   = parseFloat(info.mark_price);
  if (!currentPrice || currentPrice <= 0) return { success: false, error: "Fiyat alınamadı" };

  const rawMultiplier  = parseFloat(info.quanto_multiplier);
  const multiplier     = (isNaN(rawMultiplier) || rawMultiplier <= 0) ? 1 : rawMultiplier;
  const stepSize       = parseFloat(info.order_size_round || 1);
  const minQty         = parseFloat(info.order_size_min   || 1);
  const contractValue  = currentPrice * multiplier;

  if (contractValue <= 0) return {
    success: false,
    error: `contractValue hesaplanamadı: price=${currentPrice}, multiplier=${multiplier}`
  };

  let totalQty;
  if (usdAmount) {
    const rawQty = parseFloat(usdAmount) / contractValue;
    totalQty = Math.floor(rawQty / stepSize) * stepSize;
  } else {
    totalQty = Math.floor(parseFloat(quantity) / stepSize) * stepSize;
  }

  if (totalQty < minQty) {
    const minUsd = (minQty * contractValue).toFixed(2);
    return {
      success: false,
      error: `Pozisyon çok küçük: ${totalQty} kontrat (min ${minQty}). ` +
             `Bu coin için min $${minUsd} nominal gerekli. ` +
             `(1 kontrat = $${contractValue.toFixed(4)}, multiplier=${multiplier})`,
      minNotionalUsd: parseFloat(minUsd)   // v16.2: frontend ileride bunu MIN_POS_VAL yerine kullanabilir
    };
  }

  if (leverage) {
    const levNum = parseInt(leverage);
    if (isNaN(levNum) || levNum < 1 || levNum > 100) {
      return { success: false, error: `Geçersiz kaldıraç değeri: ${leverage}` };
    }
    try {
      await setLeverage(env, gSym, levNum);
    } catch(e) {
      return { success: false, error: `Kaldıraç ayarlanamadı (${levNum}x): ${e.message}` };
    }
    await sleep(150);
    try {
      const posCheck   = await callGate(env, "GET", "/positions", {});
      const thisPosArr = Array.isArray(posCheck)
        ? posCheck.filter(x => x.contract === gSym)
        : [];
      if (thisPosArr.length > 0) {
        const actualLev = parseInt(thisPosArr[0].leverage);
        if (!isNaN(actualLev) && actualLev !== levNum) {
          return {
            success: false,
            error: `Kaldıraç doğrulanamadı: istenen ${levNum}x, Gate'de ${actualLev}x. ` +
                   `Bu coin için ${levNum}x desteklenmiyor olabilir.`
          };
        }
      }
    } catch(e) {
      return { success: false, error: `Kaldıraç doğrulaması başarısız: ${e.message}` };
    }
  }

  let order;
  try {
    order = await callGate(env, "POST", "/orders", {}, {
      contract: gSym, size: oSign * totalQty, price: "0", tif: "ioc"
    });
  } catch(e) {
    return { success: false, error: `Order gönderilemedi: ${e.message}` };
  }

  if (order.label || order.code) {
    return { success: false, error: "Market order hatası: " + (order.message || order.label || order.code) };
  }

  const fillPrice = parseFloat(order.fill_price || order.avg_deal_price || currentPrice);
  const results   = {
    success: true, order,
    orderId: order.id || null,          // v16.2: frontend'in r.orderId fallback'i icin acik alan
    quantity: totalQty,
    price: fillPrice,
    fillPrice: fillPrice,               // v16.2 FIX: frontend tam olarak bunu okuyordu, eksikti
    usdNominal: (totalQty * contractValue).toFixed(2),
    contractValue: contractValue.toFixed(4),
    multiplier, leverage: leverage || "değiştirilmedi",
    tpOrders: [], slOrder: null, errors: []
  };

  let tpList = [];
  if (Array.isArray(tp)) tpList = tp.filter(Boolean).map(v => parseFloat(v));
  else if (tp) tpList = [parseFloat(tp)];
  tpList = tpList.filter(tpVal =>
    side === "LONG" ? tpVal > fillPrice * 1.001 : tpVal < fillPrice * 0.999
  );

  for (let i = 0; i < tpList.length; i++) {
    const tpVal = tpList[i];
    const pct   = tpPcts?.[i] || (1 / tpList.length);
    const tpQty = Math.floor(totalQty * pct / stepSize) * stepSize;
    if (tpQty < minQty) { results.errors.push(`TP${i+1} qty çok küçük (${tpQty} < ${minQty})`); continue; }
    try {
      const tpResult = await callGate(env, "POST", "/orders", {}, {
        contract: gSym, size: xSign * tpQty, price: String(tpVal.toFixed(8)),
        tif: "gtc", reduce_only: true, text: `t-tp${i+1}`
      });
      if (tpResult.id) {
        results.tpOrders.push({ level: `TP${i+1}`, price: tpVal, qty: tpQty, pct: Math.round(pct*100)+"%", orderId: tpResult.id });
      } else {
        results.errors.push(`TP${i+1}: ${tpResult.message || tpResult.label || JSON.stringify(tpResult)}`);
      }
    } catch(e) { results.errors.push(`TP${i+1} hata: ${e.message}`); }
    await sleep(80);
  }

  if (sl) {
    const slVal   = parseFloat(sl);
    const slValid = side === "LONG" ? slVal < fillPrice * 0.999 : slVal > fillPrice * 1.001;
    if (!slValid) {
      results.errors.push(`SL (${slVal}) geçersiz: giriş fiyatının yanlış tarafında (fill=${fillPrice})`);
    } else {
      try {
        const slResult = await callGate(env, "POST", "/price_orders", {}, {
          initial:  { contract: gSym, size: xSign * totalQty, price: "0", tif: "ioc", reduce_only: true, text: "t-sl" },
          trigger:  { strategy_type: 0, price_type: 1, price: String(slVal.toFixed(8)), rule: side === "LONG" ? 2 : 1 }
        });
        if (slResult.id) {
          results.slOrder = { price: slVal, orderId: slResult.id };
        } else {
          results.errors.push(`SL hata: ${slResult.message || JSON.stringify(slResult)}`);
        }
      } catch(e) { results.errors.push("SL hata: " + e.message); }
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// closePosition — v16.2: fillPrice + trade.exitPrice eklendi
// ─────────────────────────────────────────────────────────────
async function closePosition(env, symbol, side) {
  const gSym = toGate(symbol);
  try { await callGate(env, "DELETE", "/orders", { contract: gSym, side: "all" }); } catch(_) {}
  try { await callGate(env, "DELETE", "/price_orders", { contract: gSym }); } catch(_) {}
  await sleep(150);

  const posList = await callGate(env, "GET", "/positions", {});
  const pos     = Array.isArray(posList)
    ? posList.find(x => x.contract === gSym && parseFloat(x.size) !== 0)
    : null;
  if (!pos) return { success: false, error: `Açık pozisyon yok: ${symbol}` };

  const posAmt = Math.abs(parseFloat(pos.size));
  const xSign  = parseFloat(pos.size) > 0 ? -1 : 1;
  const closed = await callGate(env, "POST", "/orders", {}, {
    contract: gSym, size: xSign * posAmt, price: "0", tif: "ioc", reduce_only: true
  });

  if (closed.label || closed.code) return { success: false, error: closed.message || closed.label };

  // v16.2 FIX: gercek kapanis fiyatini frontend'in bekledigi alanlarla don.
  // Frontend fallback zinciri: r.fillPrice -> r.trade.exitPrice -> pData.price -> pos.entry
  const fillPrice = parseFloat(closed.fill_price || closed.avg_deal_price || pos.mark_price || pos.entry_price || 0) || null;

  return {
    success: true, order: closed, closedQty: posAmt,
    fillPrice: fillPrice,
    trade: fillPrice ? { exitPrice: fillPrice } : null
  };
}

async function partialClose(env, symbol, side, pct) {
  pct = parseFloat(pct) || 0.5;
  const gSym    = toGate(symbol);
  const posList = await callGate(env, "GET", "/positions", {});
  const pos     = Array.isArray(posList)
    ? posList.find(x => x.contract === gSym && parseFloat(x.size) !== 0)
    : null;
  if (!pos) return { success: false, error: `Açık pozisyon yok: ${symbol}` };

  const posAmt   = Math.abs(parseFloat(pos.size));
  const xSign    = parseFloat(pos.size) > 0 ? -1 : 1;
  const closeAmt = Math.floor(posAmt * pct);
  if (closeAmt < 1) return { success: false, error: "Miktar çok küçük" };

  const closed = await callGate(env, "POST", "/orders", {}, {
    contract: gSym, size: xSign * closeAmt, price: "0", tif: "ioc", reduce_only: true
  });

  if (closed.label || closed.code) return { success: false, error: closed.message || closed.label };
  const fillPrice = parseFloat(closed.fill_price || closed.avg_deal_price || pos.mark_price || 0) || null;
  return { success: true, order: closed, closedQty: closeAmt, pct, fillPrice };
}

// ─────────────────────────────────────────────────────────────
async function scanPairs(pairs) {
  const BATCH = 5, results = [];
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch    = pairs.slice(i, i + BATCH);
    const batchRes = await Promise.allSettled(batch.map(sym => analyzePairSimple(sym)));
    for (const r of batchRes) if (r.status === "fulfilled" && r.value) results.push(r.value);
    if (i + BATCH < pairs.length) await sleep(150);
  }
  return results.sort((a, b) => b.score - a.score);
}

async function analyzePairSimple(symbol) {
  try {
    const gSym = toGate(symbol);
    const res  = await fetch(`${GATE_BASE}/candlesticks?contract=${gSym}&interval=15m&limit=120`);
    const raw  = await safeJson(res, "klines");
    if (!raw || raw.length < 30) return null;
    const closes = raw.map(k => parseFloat(k.c));
    const price  = closes[closes.length - 1];
    const rsiVal = rsiCalc(closes, 14);
    const e9     = emaCalc(closes, 9), e21 = emaCalc(closes, 21);
    const le9    = e9[e9.length - 1],  le21 = e21[e21.length - 1];
    let bull = 0, bear = 0;
    if (le9 > le21 && price > le9)    bull += 3; else if (le9 < le21 && price < le9) bear += 3;
    if (rsiVal > 50 && rsiVal < 70)   bull += 2; else if (rsiVal < 50 && rsiVal > 30) bear += 2;
    if (rsiVal < 30) bull += 3; else if (rsiVal > 70) bear += 3;
    const total = bull + bear || 1;
    const conf  = Math.round(Math.max(bull, bear) / total * 100);
    let signal  = "WAIT";
    if      (bull > bear && bull >= 3 && conf >= 55) signal = "LONG";
    else if (bear > bull && bear >= 3 && conf >= 55) signal = "SHORT";
    return { symbol, price, signal, score: Math.max(bull, bear) * conf / 100 };
  } catch(_) { return null; }
}

// ─────────────────────────────────────────────────────────────
async function setLeverage(env, gSym, levNum) {
  const timestamp       = Math.floor(Date.now() / 1000).toString();
  const path            = `/positions/${gSym}/leverage`;
  const fullPath        = GATE_API_V4 + path;
  const queryString     = `leverage=${levNum}`;
  const bodyStr         = "";
  const hashedBody      = await sha512hex(bodyStr);
  const signatureString = ["POST", fullPath, queryString, hashedBody, timestamp].join("\n");
  const signature       = await hmacSha512(env.GATE_SECRET, signatureString);
  const headers = {
    "Accept":    "application/json",
    "KEY":       env.GATE_API_KEY,
    "SIGN":      signature,
    "Timestamp": timestamp
  };
  const requestUrl = `${GATE_BASE}${path}?${queryString}`;
  const res = await fetch(requestUrl, { method: "POST", headers });
  return safeJson(res, `setLeverage(${gSym},${levNum}x)`);
}

async function callGate(env, method, path, params = {}, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const fullPath  = GATE_API_V4 + path;
  let queryString = "";
  if ((method === "GET" || method === "DELETE") && params && Object.keys(params).length) {
    queryString = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  }
  const bodyStr         = body ? JSON.stringify(body) : "";
  const hashedBody      = await sha512hex(bodyStr);
  const signatureString = [method.toUpperCase(), fullPath, queryString, hashedBody, timestamp].join("\n");
  const signature       = await hmacSha512(env.GATE_SECRET, signatureString);
  const headers = {
    "Accept":    "application/json",
    "KEY":       env.GATE_API_KEY,
    "SIGN":      signature,
    "Timestamp": timestamp
  };
  if (bodyStr) headers["Content-Type"] = "application/json";
  const requestUrl = GATE_BASE + path + (queryString ? "?" + queryString : "");
  const res        = await fetch(requestUrl, { method, headers, body: bodyStr || undefined });
  return safeJson(res, path);
}

// v17.0: callGate'in spot piyasa karsiligi. Imzalama semasi (HMAC-SHA512)
// futures ile birebir ayni, sadece path prefix'i (SPOT_API_V4) ve base URL
// (SPOT_BASE) farkli. Ayni GATE_API_KEY/GATE_SECRET kullanilir — ANCAK
// Gate.io'daki API key'inizde "Spot Trading" izninin de acik olmasi
// gerekir (futures-only izinli bir key spot'ta 401/403 doner).
async function callGateSpot(env, method, path, params = {}, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const fullPath  = SPOT_API_V4 + path;
  let queryString = "";
  if ((method === "GET" || method === "DELETE") && params && Object.keys(params).length) {
    queryString = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  }
  const bodyStr         = body ? JSON.stringify(body) : "";
  const hashedBody      = await sha512hex(bodyStr);
  const signatureString = [method.toUpperCase(), fullPath, queryString, hashedBody, timestamp].join("\n");
  const signature       = await hmacSha512(env.GATE_SECRET, signatureString);
  const headers = {
    "Accept":    "application/json",
    "KEY":       env.GATE_API_KEY,
    "SIGN":      signature,
    "Timestamp": timestamp
  };
  if (bodyStr) headers["Content-Type"] = "application/json";
  const requestUrl = SPOT_BASE + path + (queryString ? "?" + queryString : "");
  const res        = await fetch(requestUrl, { method, headers, body: bodyStr || undefined });
  return safeJson(res, "spot" + path);
}

async function sha512hex(message) {
  const enc  = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-512", enc.encode(message));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hmacSha512(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function safeJson(res, label) {
  const text = await res.text();
  if (text.trim().startsWith("<")) throw new Error(`HTML yanıt (${res.status}) — ${label}`);
  let json;
  try { json = JSON.parse(text); } catch(e) { throw new Error(`JSON parse hatası (${label}): ${text.slice(0, 100)}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status} (${label}): ${text.slice(0, 300)}`);
  return json;
}

function toGate(symbol)   { return symbol.includes("_") ? symbol : symbol.replace("USDT", "_USDT"); }
function fromGate(symbol) { return symbol ? symbol.replace("_USDT", "USDT") : symbol; }
function sleep(ms)        { return new Promise(r => setTimeout(r, ms)); }

function emaCalc(arr, p) {
  if (arr.length < p) return arr.slice();
  const k = 2 / (p + 1), out = new Array(p - 1).fill(null);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out.push(e);
  for (let i = p; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function rsiCalc(closes, p = 14) {
  if (closes.length < p + 2) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? g += d : l -= d; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
}
