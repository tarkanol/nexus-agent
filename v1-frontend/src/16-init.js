/* ============================================================
   INIT
   ============================================================ */
window.__apexReady = function(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, {once: true});
  else setTimeout(fn, 0);
};

window.__apexReady(function() {
  Store.load();
  TelegramStore.load();
  loadFocusState();
  loadMarketMode(); // v8.2: FUTURES/SPOT modu + SPOT_CFG
  initChart();
  renderCoinList();
  readSettings();
  bindSafeUI();
  bindSpotUI(); // v8.2: mod anahtari + spot EMA ayarlari
  updateTelegramUI();
  updateFocusUI();
  
  document.querySelectorAll('.tf-btn').forEach(function(b) { b.onclick = function() { setTF(b.getAttribute('data-tf')); }; });
  ['selTargetMult', 'selRiskMult', 'selInt', 'autoMaxSize', 'autoMaxLeverage', 'autoMinScore'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.onchange = readSettings;
  });
  document.getElementById('btnL').onclick = function() { manualOpen('LONG'); };
  document.getElementById('btnS').onclick = function() { manualOpen('SHORT'); };
  
  document.getElementById('telegramToken').value = TELEGRAM.token || '';
  document.getElementById('telegramChatId').value = TELEGRAM.chatId || '';
  document.getElementById('telegramTokenMobile').value = TELEGRAM.token || '';
  document.getElementById('telegramChatIdMobile').value = TELEGRAM.chatId || '';
  
  var focusTog = document.getElementById('togFocus');
  if (focusTog) {
    focusTog.onclick = function() {
      toggleFocus();
      if (engineOn) runEngine();
    };
  }
  
  startDemo();
  
  setTimeout(function() {
    var results = TestSuite.run();
    var failed = results.filter(function(x) { return !x.ok; });
    log('APEX V' + APP_VERSION + ' MOBILE loaded — ' + (results.length - failed.length) + '/' + results.length + ' tests passed', failed.length ? 'err' : 'ok');
    log('📱 Min pos: $' + MIN_POS_VAL + ' | Coins: ' + pairs.length, 'ok');
    log('⚡ New: Volume spike, pattern, momentum signals', 'ok');
    log('🔒 Focus Mode: ' + (focusModeOn ? 'ON' : 'OFF'), 'ok');
    log('🏦 Market: ' + marketMode + (marketMode === 'SPOT' ? ' | Pine EMA stack ' + SPOT_CFG.emaShort + '/' + SPOT_CFG.emaMid + '/' + SPOT_CFG.emaLong + ' ×' + SPOT_CFG.lenMult + ' @' + SPOT_CFG.tf : ''), 'ok');
    log('🔄 Tracker: ' + (CFG.trackerMs || 500) + 'ms', 'ok');
    if (failed.length) { notify('Self-test failure — review log', 'error'); }
  }, 200);
});
