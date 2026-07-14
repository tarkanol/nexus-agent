/* ============================================================
   STORAGE
   ============================================================ */
(function() {
  var memory = {};
  var fallback = {
    getItem: function(k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
    setItem: function(k, v) { memory[k] = String(v); },
    removeItem: function(k) { delete memory[k]; }
  };
  try {
    
    var nativeStore = window.localStorage;
    var probe = '__apex_storage_probe__';
    nativeStore.setItem(probe, '1');
    nativeStore.removeItem(probe);
    window.__apexStorage = nativeStore;
  } catch(e) {
    window.__apexStorage = fallback;
  }
})();

/* ============================================================
   GLOBAL STATE
   ============================================================ */
var APP_VERSION = '8.1';
var START_BAL = 50;
var leverage = 2;
var engineOn = false;
var DEMO_BASE = {
  BTC_USDT: 74000, ETH_USDT: 2050, SOL_USDT: 83, BNB_USDT: 588,
  XRP_USDT: 0.605, DOGE_USDT: 0.12, ADA_USDT: 0.45, AVAX_USDT: 35,
  LINK_USDT: 14, DOT_USDT: 7.2, MATIC_USDT: 0.55, ARB_USDT: 0.85
};
var balance = START_BAL, dailyPnL = 0, peakBal = START_BAL;
var positions = [], trades = [], posId = 1;
var pairs = ['BTC_USDT','ETH_USDT','SOL_USDT','BNB_USDT','XRP_USDT','DOGE_USDT','ADA_USDT','AVAX_USDT'];
var currentPair = 'BTC_USDT', currentTF = '5m';
var autonomousMode = false, autoTrade = true, trailOn = true;
var WORKER = '', appMode = 'demo', futBal = null;
var targetMult = 1.5, riskMult = 1.0, scanSec = 30;
var maxPosSize = 0, maxLeverage = 0, minScore = 50;
var pxState = {}, prevPx = {}, pData = {};
var loopTimer = null, cdTimer = null;
var TRACKER_INTERVAL = null;
var trackerTick = 0, tpSlHits = 0;
var winStreak = 0, loseStreak = 0;
var chartCtx = null, eqCtx = null, lastCW = 0, chartRAF = null;
var closingNow = {};
var equityHistory = [50];
var trendState = {};
var autonomousTrades = 0;
var MIN_POS_VAL = 0.25;

var POSITION_STATE = Object.freeze({
  PENDING_OPEN: 'PENDING_OPEN',
  OPEN: 'OPEN',
  PENDING_CLOSE: 'PENDING_CLOSE',
  ERROR: 'ERROR',
  CLOSED: 'CLOSED'
});

var CFG = {
  feeRate: 0.0004,
  slippageBps: 2,
  spreadBps: 1,
  maxDailyLoss: 999,
  maxDrawdownPct: 8,
  maxTradesPerDay: 999,
  staleDataMs: 90000,
  reconcileMs: 3000,
  trackerMs: 500,
  livePriceMs: 1000,
  killSwitch: false,
  persistKey: 'apex-scalp-v81-mobile',
  dayKey: new Date().toISOString().slice(0, 10),
  recoveryMode: false,
  // v16.5: UTC "olu saat" araligi artik sabit 02-06 degil, kullanici
  // tarafindan ayarlanabilir. deadHourEnabled=false iken banner sadece
  // bilgi amaclidir (eskisi gibi); true iken RiskManager.gate() bu
  // saatlerde yeni islem acilmasini fiilen engeller.
  deadHourEnabled: false,
  deadHourStart: 2,
  deadHourEnd: 6
};

var Runtime = {
  openingLocks: {},
  liveReconcileBusy: false,
  livePriceBusy: false,
  lastLivePriceAt: 0,
  lastReconcileAt: 0,
  lastScanAt: 0,
  scanBusy: false,
  tests: [],
  apiMode: 'unknown',
  capabilities: {snapshot: null, state: null, riskUpdate: null, kill: null},
  compatNotified: false,
  posListWarnedOnce: false
};

/* ============================================================
   FOCUS MODE
   ============================================================ */
var focusModeOn = true;

function toggleFocus() {
  focusModeOn = !focusModeOn;
  updateFocusUI();
  saveFocusState();
  if (autonomousMode && focusModeOn && positions.length > 0) {
    log('[FOCUS] Auto trade paused due to open position', 'info');
  }
  if (engineOn) runEngine();
  return focusModeOn;
}

function isFocusModeActive() { return focusModeOn; }

function shouldScanForSignals() {
  if (focusModeOn && positions && positions.length > 0) { return false; }
  return true;
}

function updateFocusUI() {
  var banner = document.getElementById('bannerPos');
  if (banner) {
    var hasPos = positions && positions.length > 0;
    if (focusModeOn && hasPos) {
      banner.style.display = 'block';
      banner.textContent = '🔒 FOCUS: ' + positions.length + ' open - no new signals';
    } else if (hasPos) {
      banner.style.display = 'block';
      banner.textContent = '⚠️ OPEN POSITION (Focus OFF)';
    } else {
      banner.style.display = 'none';
    }
  }
  
  var tog = document.getElementById('togFocus');
  if (tog) { tog.className = 'tog ' + (focusModeOn ? 'on' : 'off'); }
  
  var desc = document.getElementById('togFocusD');
  if (desc) {
    desc.textContent = focusModeOn ? 'On — scan stops when position open' : 'Off — scan continues even with open positions';
  }
  
  var status = document.getElementById('focusStatus');
  if (status) {
    if (focusModeOn && positions && positions.length > 0) {
      status.textContent = '🔒 Focus ON - Blocking new signals (' + positions.length + ' open)';
      status.style.color = 'var(--warn)';
    } else if (focusModeOn) {
      status.textContent = '🔓 Focus ON - No positions';
      status.style.color = 'var(--long)';
    } else {
      status.textContent = '🔓 Focus OFF - Scanning freely';
      status.style.color = 'var(--dim2)';
    }
  }
  
  var sigEl = document.getElementById('eSig');
  if (sigEl && focusModeOn && positions && positions.length > 0) {
    var pairs = positions.map(function(p) { return p.pair.replace('_USDT', ''); }).join(',');
    sigEl.textContent = '🔒 FOCUS: ' + pairs;
    sigEl.style.color = 'var(--warn)';
  }
}

function saveFocusState() {
  try {
    window.__apexStorage.setItem('apex-focus-mode-v81', JSON.stringify({
      focusModeOn: focusModeOn,
      updatedAt: Date.now()
    }));
  } catch(e) {}
}

function loadFocusState() {
  try {
    var raw = window.__apexStorage.getItem('apex-focus-mode-v81');
    if (raw) {
      var data = JSON.parse(raw);
      if (typeof data.focusModeOn === 'boolean') {
        focusModeOn = data.focusModeOn;
        updateFocusUI();
      }
    }
  } catch(e) {}
}
