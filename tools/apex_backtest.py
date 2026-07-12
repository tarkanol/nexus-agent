#!/usr/bin/env python3
"""
APEX SCALP - GERCEK VERI BACKTEST
===================================
Uygulamanin analyze() mantigini (EMA/RSI/MACD/ADX/regime/pattern oylama sistemi)
birebir Python'a tasir ve Gate.io'nun GERCEK gecmis mum verisiyle test eder.

ONEMLI TASARIM KARARLARI:
- LOOKAHEAD YOK: her bar'da sadece o ana kadar bilinen veri kullanilir.
  Sinyal bar[i]'nin kapanisinda hesaplanir, giris bar[i+1]'in acilisinda olur.
- MTF (15m/1h/4h) hizalamasi da ayni sekilde: sadece o anda "kapanmis" olan
  ust zaman dilimi mumlari kullanilir.
- Maliyet modeli: fee (taker, iki yonlu) + slippage + spread, uygulamadaki
  CFG degerleriyle ayni (feeRate=0.0004, slippageBps=2, spreadBps=1).
- Pozisyon boyutu: sabit-fraksiyonel risk (varsayilan %1 sermaye/islem),
  boylece sonuc "R-multiple" (risk birimi) cinsinden de raporlanir. Bu,
  orijinal koddaki Kelly/dinamik boyutlamadan bagimsiz, saf sinyal kalitesini
  olcer. Istersen --risk-pct ile degistir.
- Cikis: SL/TP hangisi once vurulursa. Kontrol penceresi genis tutuldu
  (orijinal koddaki 25 bar / ~2 saatlik sinir kaldirildi) cunku bu, trendi
  zamanindan once kesip performansi yapay dusuruyordu.

KULLANIM:
    pip install requests
    python3 apex_backtest.py --symbol BTC_USDT --days 60
    python3 apex_backtest.py --symbol ETH_USDT --days 30 --min-score 55
"""

import argparse
import math
import time
import sys
import statistics
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    print("pip install requests --break-system-packages  (veya venv icinde) calistirip tekrar dene")
    sys.exit(1)

BASE_URL = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks"

FEE_RATE = 0.0004
SLIPPAGE_BPS = 2
SPREAD_BPS = 1


# ============================================================
# VERI CEKME
# ============================================================
def fetch_candles(symbol, interval, total_needed, verbose=True):
    """Gate.io public futures API'den mum verisi ceker (auth gerektirmez)."""
    out = []
    to_ts = int(time.time())
    per_req = 2000
    while len(out) < total_needed:
        params = {"contract": symbol, "interval": interval, "limit": per_req, "to": to_ts}
        r = requests.get(BASE_URL, params=params, timeout=15)
        if r.status_code != 200:
            raise RuntimeError(f"Gate.io API hata {r.status_code}: {r.text[:200]}")
        data = r.json()
        if not data:
            break
        # Gate.io alanlari: t (unix sec), o, h, l, c, v
        batch = [
            {
                "t": int(k["t"]) * 1000,
                "o": float(k["o"]),
                "h": float(k["h"]),
                "l": float(k["l"]),
                "c": float(k["c"]),
                "v": float(k.get("v", 0)),
            }
            for k in data
        ]
        batch.sort(key=lambda x: x["t"])
        out = batch + out
        oldest = batch[0]["t"] // 1000
        if oldest >= to_ts:
            break
        to_ts = oldest - 1
        if verbose:
            print(f"  [{interval}] {len(out)}/{total_needed} mum cekildi...", end="\r")
        time.sleep(0.15)  # rate-limit nezaketi
        if len(batch) < per_req:
            break
    if verbose:
        print(f"  [{interval}] {len(out)} mum cekildi.           ")
    # dedup + sirala
    seen = {}
    for k in out:
        seen[k["t"]] = k
    return sorted(seen.values(), key=lambda x: x["t"])[-total_needed:]


# ============================================================
# INDIKATORLER (uygulamadaki calc* fonksiyonlarinin birebir portu)
# ============================================================
def ema(values, period):
    if len(values) < period:
        return [None] * len(values)
    k = 2 / (period + 1)
    out = [None] * (period - 1)
    e = sum(values[:period]) / period
    out.append(e)
    for v in values[period:]:
        e = v * k + e * (1 - k)
        out.append(e)
    return out


def rsi(closes, period=14):
    if len(closes) < period + 2:
        return 50.0
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    ag, al = gains / period, losses / period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (period - 1) + max(d, 0)) / period
        al = (al * (period - 1) + max(-d, 0)) / period
    if al == 0:
        return 100.0
    return 100 - (100 / (1 + ag / al))


def macd(closes):
    e12, e26 = ema(closes, 12), ema(closes, 26)
    ml = [a - b for a, b in zip(e12, e26) if a is not None and b is not None]
    if len(ml) < 3:
        return {"hist": 0.0, "prev": 0.0, "cross": None, "aligned": False}
    sg = ema(ml, 9)
    n = len(ml) - 1
    h = ml[n] - (sg[-1] or 0)
    ph = ml[n - 1] - (sg[-2] or 0)
    cross = "UP" if (ph < 0 and h > 0) else "DN" if (ph > 0 and h < 0) else None
    aligned = (h > 0 and h > ph) or (h < 0 and h < ph)
    return {"hist": h, "prev": ph, "cross": cross, "aligned": aligned}


def atr(kl, period=14):
    if len(kl) < period + 1:
        return (kl[-1]["h"] - kl[-1]["l"]) if kl else 0.001
    trs = []
    for i in range(1, len(kl)):
        pc = kl[i - 1]["c"]
        trs.append(max(kl[i]["h"] - kl[i]["l"], abs(kl[i]["h"] - pc), abs(kl[i]["l"] - pc)))
    return sum(trs[-period:]) / period


def adx(kl, period=14):
    if len(kl) < period + 2:
        return 20.0
    dm_p, dm_m, tr = [], [], []
    for i in range(1, len(kl)):
        up = kl[i]["h"] - kl[i - 1]["h"]
        dn = kl[i - 1]["l"] - kl[i]["l"]
        dm_p.append(up if (up > dn and up > 0) else 0)
        dm_m.append(dn if (dn > up and dn > 0) else 0)
        tr.append(max(kl[i]["h"] - kl[i]["l"], abs(kl[i]["h"] - kl[i - 1]["c"]), abs(kl[i]["l"] - kl[i - 1]["c"])))
    if len(tr) < period:
        return 20.0
    plus = sum(dm_p[:period]) / period
    minus = sum(dm_m[:period]) / period
    if plus == 0 and minus == 0:
        return 20.0
    pdi = plus / (plus + minus) * 100
    mdi = minus / (plus + minus) * 100
    return abs(pdi - mdi) / (pdi + mdi) * 100


def vol_ratio(kl, period=20):
    if len(kl) < period + 1:
        return 1.0
    sl = kl[-period:]
    avg = sum(x["v"] for x in sl[:-1]) / max(1, len(sl) - 1)
    return sl[-1]["v"] / avg if avg > 0 else 1.0


def bbands(closes, period=20, mult=2):
    if len(closes) < period:
        return {"upper": 0, "lower": 0, "mid": 0, "squeeze": False}
    sl = closes[-period:]
    mid = sum(sl) / period
    std = math.sqrt(sum((x - mid) ** 2 for x in sl) / period)
    return {"upper": mid + mult * std, "lower": mid - mult * std, "mid": mid, "squeeze": (std / mid) < 0.008 if mid else False}


def ema_slope(e_arr, lb=4):
    vals = [x for x in e_arr if x is not None]
    if len(vals) < lb + 1:
        return 0.0
    last, prev = vals[-1], vals[-1 - lb]
    return (last - prev) / prev if prev else 0.0


def stoch_rsi(closes, period=14):
    if len(closes) < period * 2:
        return 50.0
    rsis = [rsi(closes[: i + 1], period) for i in range(period, len(closes))]
    if len(rsis) < period:
        return 50.0
    sl = rsis[-period:]
    mn, mx = min(sl), max(sl)
    return 50.0 if (mx - mn) < 0.01 else (sl[-1] - mn) / (mx - mn) * 100


def roc(closes, period=10):
    if len(closes) < period + 1:
        return 0.0
    now, prev = closes[-1], closes[-1 - period]
    return (now - prev) / prev * 100 if prev else 0.0


def vol_spike(kl, threshold=1.8):
    if len(kl) < 22:
        return {"spike": False, "ratio": 1.0}
    last_v = kl[-1]["v"]
    avg = sum(x["v"] for x in kl[-21:-1]) / 20
    ratio = last_v / avg if avg > 0 else 1.0
    return {"spike": ratio >= threshold, "ratio": ratio}


def detect_pattern(kl):
    if len(kl) < 5:
        return "NONE"
    last, prev, prev2 = kl[-1], kl[-2], kl[-3]
    if last["h"] <= prev["h"] and last["l"] >= prev["l"]:
        return "INSIDE_BAR"
    if last["h"] > prev["h"] and last["l"] < prev["l"]:
        if last["c"] > last["o"] and prev["c"] < prev["o"]:
            return "BULLISH_ENGULFING"
        if last["c"] < last["o"] and prev["c"] > prev["o"]:
            return "BEARISH_ENGULFING"
    body = abs(last["c"] - last["o"])
    up_w = last["h"] - max(last["c"], last["o"])
    dn_w = min(last["c"], last["o"]) - last["l"]
    if body > 0 and dn_w > body * 2 and up_w < body * 0.5:
        return "HAMMER"
    if body > 0 and up_w > body * 2 and dn_w < body * 0.5:
        return "SHOOTING_STAR"
    if last["c"] > last["o"] and prev["c"] > prev["o"] and prev2["c"] > prev2["o"] and last["c"] > prev["c"] > prev2["c"]:
        return "THREE_WHITE"
    if last["c"] < last["o"] and prev["c"] < prev["o"] and prev2["c"] < prev2["o"] and last["c"] < prev["c"] < prev2["c"]:
        return "THREE_BLACK"
    if prev2["c"] > prev2["o"] and abs(prev["c"] - prev["o"]) < body * 0.3 and last["c"] < last["o"] and last["c"] < prev2["o"]:
        return "EVENING_STAR"
    if prev2["c"] < prev2["o"] and abs(prev["c"] - prev["o"]) < body * 0.3 and last["c"] > last["o"] and last["c"] > prev2["o"]:
        return "MORNING_STAR"
    return "NONE"


def detect_regime(kl5, kl15):
    if len(kl5) < 50 or len(kl15) < 30:
        return {"regime": "UNKNOWN", "adx": 0}
    a = adx(kl5, 14)
    a5 = atr(kl5, 14)
    price = kl5[-1]["c"]
    vol_pct = (a5 / price) * 100 if price else 0
    closes = [k["c"] for k in kl5]
    e9, e21 = ema(closes, 9), ema(closes, 21)
    slope = (e9[-1] - e9[-5]) / e9[-5] if len(e9) > 10 and e9[-5] else 0
    if a >= 25 and abs(slope) > 0.0001:
        regime = "TRENDING"
    elif a < 20 and vol_pct < 0.12:
        regime = "RANGING"
    elif vol_pct >= 0.2:
        regime = "VOLATILE"
    else:
        regime = "MIXED"
    return {"regime": regime, "adx": a, "vol_pct": vol_pct}


def max_high_of(kl, from_end, count):
    end = max(0, len(kl) - from_end)
    start = max(0, end - count)
    return max((k["h"] for k in kl[start:end]), default=-math.inf)


def min_low_of(kl, from_end, count):
    end = max(0, len(kl) - from_end)
    start = max(0, end - count)
    return min((k["l"] for k in kl[start:end]), default=math.inf)


# ============================================================
# SINYAL MOTORU (analyze() portu - oylama sistemi birebir)
# ============================================================
def analyze_bar(kl5, kl15, kl1h, kl4h, min_score=50, target_mult=1.5, risk_mult=1.0):
    """kl5/kl15/kl1h/kl4h: SADECE o ana kadar bilinen (kapanmis) mumlar."""
    if len(kl5) < 60 or len(kl15) < 30 or len(kl1h) < 20:
        return None

    price = kl5[-1]["c"]
    c5 = [k["c"] for k in kl5]
    c15 = [k["c"] for k in kl15]
    c1h = [k["c"] for k in kl1h]
    c4h = [k["c"] for k in kl4h] if len(kl4h) >= 10 else []

    a5 = atr(kl5, 14)
    atr_pct = a5 / price * 100 if price else 0
    adx5 = adx(kl5, 14)
    regime = detect_regime(kl5, kl15)

    e9_5, e21_5 = ema(c5, 9), ema(c5, 21)
    e9_15, e21_15 = ema(c15, 9), ema(c15, 21)
    e20h, e50h = ema(c1h, 20), ema(c1h, min(50, len(c1h)))
    if not all([e9_5[-1], e21_5[-1], e9_15[-1], e21_15[-1], e20h[-1], e50h[-1]]):
        return None

    l9_5, l21_5 = e9_5[-1], e21_5[-1]
    p9_5, p21_5 = e9_5[-2], e21_5[-2]
    l9_15, l21_15 = e9_15[-1], e21_15[-1]
    l20h, l50h = e20h[-1], e50h[-1]

    sl5, sl15, sl1h = ema_slope(e9_5, 4), ema_slope(e9_15, 4), ema_slope(e20h, 5)
    above, below = l9_5 > l21_5, l9_5 < l21_5
    golden_x = p9_5 <= p21_5 and l9_5 > l21_5
    death_x = p9_5 >= p21_5 and l9_5 < l21_5

    trend15 = "LONG" if (l9_15 > l21_15 and sl15 > 0.000005) else "SHORT" if (l9_15 < l21_15 and sl15 < -0.000005) else "WAIT"
    trend4h = "WAIT"
    if len(c4h) >= 21:
        e9_4h, e21_4h = ema(c4h, 9), ema(c4h, 21)
        if e9_4h[-1] and e21_4h[-1]:
            trend4h = "LONG" if e9_4h[-1] > e21_4h[-1] else "SHORT"

    if l20h > l50h and sl1h > 0.00002:
        bias1h = "LONG"
    elif l20h < l50h and sl1h < -0.00002:
        bias1h = "SHORT"
    elif sl1h < -0.0003:
        bias1h = "SHORT"
    elif sl1h > 0.0003:
        bias1h = "LONG"
    else:
        bias1h = "WAIT"

    macd5 = macd(c5)
    rsi5 = rsi(c5, 14)
    prev_rsi5 = rsi(c5[:-1], 14)
    stoch5 = stoch_rsi(c5, 14)
    vr = vol_ratio(kl5)
    bb5 = bbands(c5, 20, 2)
    vspike = vol_spike(kl5, 1.8)
    roc10 = roc(c5, 10)
    pattern = detect_pattern(kl5)

    last, prev = kl5[-1], kl5[-2]
    bull2 = last["c"] > last["o"] and prev["c"] > prev["o"]
    bear2 = last["c"] < last["o"] and prev["c"] < prev["o"]
    breakout_long = last["c"] > max_high_of(kl5, 1, 8)
    breakout_short = last["c"] < min_low_of(kl5, 1, 8)

    long_v = short_v = 0
    if above and sl5 > 0.00001:
        long_v += 2
    elif above:
        long_v += 1
    if below and sl5 < -0.00001:
        short_v += 2
    elif below:
        short_v += 1

    if macd5["hist"] > 0 and macd5["aligned"]:
        long_v += 2
    elif macd5["hist"] > 0:
        long_v += 1
    if macd5["hist"] < 0 and macd5["aligned"]:
        short_v += 2
    elif macd5["hist"] < 0:
        short_v += 1
    if macd5["cross"] == "UP":
        long_v += 3
    if macd5["cross"] == "DN":
        short_v += 3

    if rsi5 > 50 and rsi5 > prev_rsi5:
        long_v += 2
    elif rsi5 > 50:
        long_v += 1
    if rsi5 < 50 and rsi5 < prev_rsi5:
        short_v += 2
    elif rsi5 < 50:
        short_v += 1

    if last["c"] > prev["c"] and last["c"] > last["o"]:
        long_v += 1
    if last["c"] < prev["c"] and last["c"] < last["o"]:
        short_v += 1
    if breakout_long:
        long_v += 2
    if breakout_short:
        short_v += 2
    if vspike["spike"]:
        if last["c"] > prev["c"]:
            long_v += 2
        else:
            short_v += 2
    if roc10 > 2:
        long_v += 2
    elif roc10 > 1:
        long_v += 1
    if roc10 < -2:
        short_v += 2
    elif roc10 < -1:
        short_v += 1
    if pattern in ("BULLISH_ENGULFING", "MORNING_STAR", "THREE_WHITE", "HAMMER"):
        long_v += 3
    if pattern in ("BEARISH_ENGULFING", "EVENING_STAR", "THREE_BLACK", "SHOOTING_STAR"):
        short_v += 3
    if pattern == "INSIDE_BAR":
        long_v += 1 if above else 0
        short_v += 1 if below else 0
    if trend15 == "LONG":
        long_v += 1
    if trend15 == "SHORT":
        short_v += 1
    if bias1h == "LONG":
        long_v += 1
    if bias1h == "SHORT":
        short_v += 1
    if stoch5 < 25 and rsi5 < 45:
        long_v += 1
    if stoch5 > 75 and rsi5 > 55:
        short_v += 1
    if adx5 < 15:
        long_v = max(0, long_v - 2)
        short_v = max(0, short_v - 2)

    raw_sig, strategy = "WAIT", "TREND"
    if long_v >= 5 and long_v > short_v + 1:
        raw_sig = "LONG"
    elif long_v >= 4 and long_v >= short_v + 3:
        raw_sig = "LONG"
    if short_v >= 5 and short_v > long_v + 1:
        raw_sig = "SHORT"
    elif short_v >= 4 and short_v >= long_v + 3:
        raw_sig = "SHORT"

    is_choppy = regime["regime"] == "RANGING" or (regime["regime"] == "MIXED" and adx5 < 20)
    if raw_sig == "WAIT" and is_choppy and bb5["mid"] > 0:
        near_lower = price <= bb5["lower"] * 1.002
        near_upper = price >= bb5["upper"] * 0.998
        if near_lower and rsi5 <= 40 and stoch5 <= 30:
            raw_sig, strategy = "LONG", "RANGE"
        elif near_upper and rsi5 >= 60 and stoch5 >= 70:
            raw_sig, strategy = "SHORT", "RANGE"

    if raw_sig == "WAIT" and vspike["spike"] and vspike["ratio"] >= 2.5:
        if last["c"] > prev["c"] and sl5 > 0:
            raw_sig, strategy = "LONG", "BREAKOUT"
        elif last["c"] < prev["c"] and sl5 < 0:
            raw_sig, strategy = "SHORT", "BREAKOUT"

    if raw_sig == "WAIT":
        if pattern in ("BULLISH_ENGULFING", "MORNING_STAR") and vr >= 0.8 and adx5 >= 15:
            raw_sig, strategy = "LONG", "PATTERN"
        if pattern in ("BEARISH_ENGULFING", "EVENING_STAR") and vr >= 0.8 and adx5 >= 15:
            raw_sig, strategy = "SHORT", "PATTERN"

    if raw_sig == "WAIT":
        return {"signal": "WAIT"}

    tf_count = 1
    if trend15 == raw_sig:
        tf_count += 1
    if bias1h == raw_sig:
        tf_count += 1
    if trend4h == raw_sig:
        tf_count += 1

    score = 0
    if strategy == "TREND":
        score += 8
        if trend15 == raw_sig:
            score += 12
        elif trend15 != "WAIT":
            score += 4
        if bias1h == raw_sig:
            score += 14
        elif bias1h != "WAIT":
            score += 5
        if trend4h == raw_sig:
            score += 10
        macd_dir = macd5["hist"] > 0 if raw_sig == "LONG" else macd5["hist"] < 0
        macd_exp = macd5["hist"] > macd5["prev"] if raw_sig == "LONG" else macd5["hist"] < macd5["prev"]
        if macd_dir:
            score += 10 if macd_exp else 6
        if adx5 >= 30:
            score += 10
        elif adx5 >= 20:
            score += 6
        if vr >= 1.8:
            score += 12
        elif vr >= 1.25:
            score += 9
        elif vr >= 0.9:
            score += 6
        elif vr >= 0.65:
            score += 3
        else:
            score += 1
        if bull2 or bear2:
            score += 3
        if breakout_long or breakout_short:
            score += 6
        if (golden_x and raw_sig == "LONG") or (death_x and raw_sig == "SHORT"):
            score += 8
        if roc10 > 1.5 or roc10 < -1.5:
            score += 5
    elif strategy == "RANGE":
        score += 18
        if vr >= 0.8:
            score += 6
    elif strategy == "BREAKOUT":
        score += 25
        if adx5 >= 20:
            score += 5
    elif strategy == "PATTERN":
        score += 22
        if vr >= 1.0:
            score += 5

    rsi_ideal = (35 <= rsi5 <= 68) if raw_sig == "LONG" else (25 <= rsi5 <= 58)
    score += 5 if rsi_ideal else 2
    if (raw_sig == "LONG" and stoch5 < 50) or (raw_sig == "SHORT" and stoch5 > 50):
        score += 3
    score = max(0, min(100, round(score)))

    thresh = {
        "RANGE": max(20, min(min_score, 60)),
        "BREAKOUT": max(30, min(min_score, 70)),
        "PATTERN": max(25, min(min_score, 65)),
        "TREND": max(25, min_score),
    }[strategy]
    if score < thresh:
        return {"signal": "WAIT"}
    if strategy == "TREND" and vr < 0.55:
        return {"signal": "WAIT"}
    if strategy != "BREAKOUT" and vr < 0.35:
        return {"signal": "WAIT"}
    if strategy == "TREND" and tf_count < 1:
        return {"signal": "WAIT"}

    atr_mult = 1.6 if atr_pct < 0.08 else 1.4 if atr_pct < 0.18 else 1.2 if atr_pct < 0.40 else 1.0
    sl_dist = max(a5 * atr_mult * risk_mult, price * 0.0015)
    sl_dist = min(sl_dist, price * 0.025)
    if strategy == "RANGE":
        sl_dist = max((price - bb5["lower"]) * 0.85 if raw_sig == "LONG" else (bb5["upper"] - price) * 0.85, price * 0.001)
        sl_dist = min(sl_dist, price * 0.015)

    tp_dist = max(sl_dist * 1.5, a5 * target_mult) if strategy != "RANGE" else max(abs(bb5["mid"] - price) * 0.85, sl_dist * 1.1)
    tp_dist = min(tp_dist, price * 0.06)

    sl = price - sl_dist if raw_sig == "LONG" else price + sl_dist
    tp = price + tp_dist if raw_sig == "LONG" else price - tp_dist

    return {
        "signal": raw_sig, "strategy": strategy, "score": score, "price": price,
        "sl": sl, "tp": tp, "sl_dist": sl_dist, "tp_dist": tp_dist,
        "rr": tp_dist / sl_dist if sl_dist else 0,
    }


# ============================================================
# BACKTEST (lookahead-free walk-forward)
# ============================================================
def align_htf(htf_klines, htf_idx, current_open_time):
    """current_open_time'dan once KAPANMIS olan en son htf mumlarina kadar ilerlet."""
    while htf_idx + 1 < len(htf_klines) and htf_klines[htf_idx + 1]["t"] < current_open_time:
        htf_idx += 1
    return htf_idx


def run_backtest(symbol, kl5, kl15, kl1h, kl4h, min_score, target_mult, risk_mult, risk_pct, max_hold_bars):
    cost_rate = 2 * FEE_RATE + (SLIPPAGE_BPS + SPREAD_BPS) / 10000
    equity = 1.0  # birim sermaye (1.0 = %100), R-multiple ve % olarak raporlanacak
    peak = 1.0
    max_dd = 0.0
    trades = []

    i15 = i1h = i4h = 30
    warmup = 60
    n = len(kl5)
    idx = warmup

    while idx < n - 2:
        bar = kl5[idx]
        i15 = align_htf(kl15, i15, bar["t"])
        i1h = align_htf(kl1h, i1h, bar["t"])
        i4h = align_htf(kl4h, i4h, bar["t"]) if kl4h else i4h

        window5 = kl5[: idx + 1]
        window15 = kl15[: i15 + 1]
        window1h = kl1h[: i1h + 1]
        window4h = kl4h[: i4h + 1] if kl4h else []

        sig = analyze_bar(window5, window15, window1h, window4h, min_score, target_mult, risk_mult)
        if not sig or sig["signal"] == "WAIT":
            idx += 1
            continue

        side = sig["signal"]
        entry_bar = kl5[idx + 1]
        raw_entry = entry_bar["o"]
        entry = raw_entry * (1 + (1 if side == "LONG" else -1) * (SPREAD_BPS / 2 + SLIPPAGE_BPS) / 10000)
        sl_dist_ratio = sig["sl_dist"] / sig["price"]
        tp_dist_ratio = sig["tp_dist"] / sig["price"]
        sl = entry - entry * sl_dist_ratio if side == "LONG" else entry + entry * sl_dist_ratio
        tp = entry + entry * tp_dist_ratio if side == "LONG" else entry - entry * tp_dist_ratio

        exit_price, exit_idx, exit_reason = None, None, "TIMEOUT"
        end = min(n, idx + 2 + max_hold_bars)
        for j in range(idx + 1, end):
            k = kl5[j]
            hit_sl = (side == "LONG" and k["l"] <= sl) or (side == "SHORT" and k["h"] >= sl)
            hit_tp = (side == "LONG" and k["h"] >= tp) or (side == "SHORT" and k["l"] <= tp)
            if hit_sl and hit_tp:
                exit_price, exit_idx, exit_reason = sl, j, "SL(amb)"
                break
            if hit_sl:
                exit_price, exit_idx, exit_reason = sl, j, "SL"
                break
            if hit_tp:
                exit_price, exit_idx, exit_reason = tp, j, "TP"
                break
            exit_price, exit_idx = k["c"], j
        if exit_price is None:
            exit_price, exit_idx = kl5[end - 1]["c"], end - 1

        exit_price *= 1 - (1 if side == "LONG" else -1) * (SPREAD_BPS / 2 + SLIPPAGE_BPS) / 10000
        gross_ratio = (exit_price - entry) / entry * (1 if side == "LONG" else -1)
        net_ratio = gross_ratio - cost_rate
        r_multiple = net_ratio / sl_dist_ratio if sl_dist_ratio else 0

        risk_amount = equity * risk_pct
        pnl_equity = risk_amount * r_multiple
        equity += pnl_equity
        peak = max(peak, equity)
        dd = (peak - equity) / peak * 100 if peak else 0
        max_dd = max(max_dd, dd)

        trades.append({
            "time": datetime.fromtimestamp(bar["t"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M"),
            "side": side, "strategy": sig["strategy"], "score": sig["score"],
            "entry": entry, "exit": exit_price, "reason": exit_reason,
            "r": r_multiple, "equity": equity,
        })
        idx = exit_idx + 1

    return trades, equity, max_dd


def print_report(symbol, trades, final_equity, max_dd, days):
    if not trades:
        print(f"\n{symbol}: Hic islem uretilmedi (min-score cok yuksek olabilir ya da rejim uygun degil).")
        return
    wins = [t for t in trades if t["r"] > 0]
    losses = [t for t in trades if t["r"] <= 0]
    win_rate = len(wins) / len(trades) * 100
    avg_r = statistics.mean(t["r"] for t in trades)
    avg_win_r = statistics.mean(t["r"] for t in wins) if wins else 0
    avg_loss_r = statistics.mean(t["r"] for t in losses) if losses else 0
    gross_win = sum(t["r"] for t in wins)
    gross_loss = abs(sum(t["r"] for t in losses))
    profit_factor = gross_win / gross_loss if gross_loss else float("inf")
    rs = [t["r"] for t in trades]
    r_std = statistics.pstdev(rs) if len(rs) > 1 else 0
    sharpe_like = (avg_r / r_std) if r_std else 0

    by_strategy = {}
    for t in trades:
        by_strategy.setdefault(t["strategy"], []).append(t["r"])

    print(f"\n{'='*60}")
    print(f"  {symbol}  |  {days} gun  |  {len(trades)} islem")
    print(f"{'='*60}")
    print(f"  Win rate         : {win_rate:.1f}%  ({len(wins)}W / {len(losses)}L)")
    print(f"  Ortalama R       : {avg_r:+.3f}  (kazanan avg {avg_win_r:+.2f}R, kaybeden avg {avg_loss_r:+.2f}R)")
    print(f"  Profit factor    : {profit_factor:.2f}")
    print(f"  Sharpe-benzeri   : {sharpe_like:.2f}")
    print(f"  Max drawdown     : {max_dd:.1f}%")
    print(f"  Toplam getiri    : {(final_equity - 1) * 100:+.1f}%  (sermayenin %1'i risk varsayimiyla)")
    print(f"  Strateji kirilimi:")
    for strat, rlist in by_strategy.items():
        wr = len([x for x in rlist if x > 0]) / len(rlist) * 100
        print(f"    {strat:10s}: {len(rlist):4d} islem, winrate {wr:5.1f}%, avgR {statistics.mean(rlist):+.3f}")
    print(f"{'='*60}\n")


def main():
    ap = argparse.ArgumentParser(description="APEX Scalp - gercek veriyle backtest")
    ap.add_argument("--symbol", default="BTC_USDT")
    ap.add_argument("--days", type=int, default=45)
    ap.add_argument("--min-score", type=int, default=50)
    ap.add_argument("--target-mult", type=float, default=1.5)
    ap.add_argument("--risk-mult", type=float, default=1.0)
    ap.add_argument("--risk-pct", type=float, default=0.01, help="islem basina risklenen sermaye orani")
    ap.add_argument("--max-hold-bars", type=int, default=288, help="5m bar cinsinden max pozisyon suresi (288=24s)")
    args = ap.parse_args()

    need5 = args.days * 288 + 100
    need15 = args.days * 96 + 60
    need1h = args.days * 24 + 40
    need4h = args.days * 6 + 20

    print(f"Gate.io'dan {args.symbol} gercek veri cekiliyor...")
    kl5 = fetch_candles(args.symbol, "5m", need5)
    kl15 = fetch_candles(args.symbol, "15m", need15)
    kl1h = fetch_candles(args.symbol, "1h", need1h)
    kl4h = fetch_candles(args.symbol, "4h", need4h)

    print("Backtest calisiyor (lookahead-free walk-forward)...")
    trades, final_eq, max_dd = run_backtest(
        args.symbol, kl5, kl15, kl1h, kl4h,
        args.min_score, args.target_mult, args.risk_mult, args.risk_pct, args.max_hold_bars,
    )
    print_report(args.symbol, trades, final_eq, max_dd, args.days)

    if trades:
        print("Son 10 islem:")
        for t in trades[-10:]:
            print(f"  {t['time']}  {t['side']:5s} {t['strategy']:9s} score={t['score']:3d}  "
                  f"{t['reason']:8s}  R={t['r']:+.2f}")


if __name__ == "__main__":
    main()
