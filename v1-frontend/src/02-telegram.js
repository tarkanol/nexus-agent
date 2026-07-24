/* ============================================================
   TELEGRAM
   ============================================================ */
var TELEGRAM = {
  enabled: false,
  token: '',
  chatId: '',
  storageKey: 'apex-scalp-v81-telegram'
};

var TelegramStore = {
  load: function() {
    try {
      var raw = window.__apexStorage.getItem(TELEGRAM.storageKey);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s.token) TELEGRAM.token = s.token;
      if (s.chatId) TELEGRAM.chatId = s.chatId;
      if (typeof s.enabled === 'boolean') TELEGRAM.enabled = s.enabled;
    } catch(e) {}
  },
  save: function() {
    try {
      window.__apexStorage.setItem(TELEGRAM.storageKey, JSON.stringify({
        token: TELEGRAM.token,
        chatId: TELEGRAM.chatId,
        enabled: TELEGRAM.enabled
      }));
    } catch(e) {}
  }
};

function sendTelegram(message) {
  if (!TELEGRAM.enabled || !TELEGRAM.token || !TELEGRAM.chatId) return Promise.resolve(false);
  var url = 'https://api.telegram.org/bot' + TELEGRAM.token + '/sendMessage';
  var payload = {
    chat_id: TELEGRAM.chatId,
    text: '📊 APEX V8.1\n' + message,
    parse_mode: 'HTML'
  };
  return fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)})
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.ok) { log('Telegram: ' + message.slice(0, 40) + '...', 'ok'); return true; }
      else { log('Telegram error: ' + (data.description || 'Unknown'), 'err'); return false; }
    })
    .catch(function(e) { log('Telegram failed: ' + e.message, 'err'); return false; });
}

function toggleTelegram() {
  TELEGRAM.enabled = !TELEGRAM.enabled;
  TelegramStore.save();
  updateTelegramUI();
  if (TELEGRAM.enabled) sendTelegram('🤖 Bot ready\nVersion: ' + APP_VERSION);
}

function updateTelegramUI() {
  var el = document.getElementById('bdgTelegram');
  if (el) { el.textContent = '📨'; el.className = 'bdg telegram' + (TELEGRAM.enabled ? ' on' : ''); }
  var status = document.getElementById('telegramStatus');
  if (status) {
    status.textContent = TELEGRAM.enabled ? '✅ Active | Chat: ' + (TELEGRAM.chatId || '---') : '⏸️ Inactive';
    status.style.color = TELEGRAM.enabled ? 'var(--long)' : 'var(--dim2)';
  }
  var statusMobile = document.getElementById('telegramStatusMobile');
  if (statusMobile) {
    statusMobile.textContent = TELEGRAM.enabled ? '✅ Active | ' + (TELEGRAM.chatId || '---') : '⏸️ Inactive';
    statusMobile.style.color = TELEGRAM.enabled ? 'var(--long)' : 'var(--dim2)';
  }
  var qa = document.getElementById('qaTelegram');
  if (qa) { qa.className = 'qa-btn' + (TELEGRAM.enabled ? ' on' : ''); }
}

function saveTelegram() {
  var token = document.getElementById('telegramToken').value.trim();
  var chatId = document.getElementById('telegramChatId').value.trim();
  if (token) TELEGRAM.token = token;
  if (chatId) TELEGRAM.chatId = chatId;
  TelegramStore.save();
  updateTelegramUI();
  document.getElementById('telegramTokenMobile').value = TELEGRAM.token;
  document.getElementById('telegramChatIdMobile').value = TELEGRAM.chatId;
  sendTelegram('✅ Test message\nBot connected!\nVersion: ' + APP_VERSION)
    .then(function(success) {
      if (success) notify('Telegram test OK!', 'telegram');
      else notify('Telegram test failed. Check Token/Chat ID.', 'error');
    });
}

function saveTelegramMobile() {
  var token = document.getElementById('telegramTokenMobile').value.trim();
  var chatId = document.getElementById('telegramChatIdMobile').value.trim();
  if (token) TELEGRAM.token = token;
  if (chatId) TELEGRAM.chatId = chatId;
  TelegramStore.save();
  updateTelegramUI();
  document.getElementById('telegramToken').value = TELEGRAM.token;
  document.getElementById('telegramChatId').value = TELEGRAM.chatId;
  notify('Telegram settings saved. Tap TEST to verify.', 'info');
}

function testTelegramMobile() {
  sendTelegram('✅ Mobile test\nBot connected!\nVersion: ' + APP_VERSION)
    .then(function(success) {
      if (success) notify('📨 Test message sent!', 'telegram');
      else notify('❌ Test failed. Check Token/Chat ID.', 'error');
    });
}
