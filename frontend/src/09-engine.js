/* ============================================================
   ENGINE
   ============================================================ */
function toggleEng() {
  engineOn = !engineOn;
  var elBtn = document.getElementById('btnEng'); if (elBtn) elBtn.textContent = engineOn ? 'STOP' : 'START';
  var elBdg = document.getElementById('bdgEng');
  if (elBdg) { elBdg.textContent = engineOn ? 'ENG:ON' : 'ENG:OFF'; elBdg.className = 'bdg ' + (engineOn ? 'on' : ''); }
  var elTxt = document.getElementById('engTxt'); if (elTxt) elTxt.textContent = engineOn ? 'ENGINE RUN' : 'ENGINE OFF';
  var elStats = document.getElementById('engStats'); if (elStats) elStats.style.display = engineOn ? 'grid' : 'none';
  if (engineOn) startCountdown(); else if (cdTimer) clearInterval(cdTimer);
}

function startCountdown() {
  if (cdTimer) clearInterval(cdTimer);
  var left = scanSec;
  cdTimer = setInterval(function() {
    left--;
    var el = document.getElementById('eNext'); if (el) el.textContent = left > 0 ? left + 's' : '...';
    if (left <= 0) clearInterval(cdTimer);
  }, 1000);
}

function runEngine() {
  if (!engineOn) return;
  var el = document.getElementById('eLast'); 
  if (el) el.textContent = new Date().toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'});
  var eo = document.getElementById('eOpen'); 
  if (eo) eo.textContent = positions.length;
  
  // TARKAN modu — DVF pine-port flip sinyaliyle tek pair scalp.
  // FUTURES/SPOT ayrimindan bagimsiz, mevcut mod neyse onda calisir.
  if (tarkanMode) { TarkanEngine.tick(); return; }

  // v8.2: SPOT modu — EMA crossover al / crossunder sat dongusu.
  // Cikis taramasi focus modundan etkilenmez (SpotEngine icinde).
  if (marketMode === 'SPOT') { SpotEngine.engineTick(); return; }
  
  if (focusModeOn && positions.length > 0) {
    var sigEl = document.getElementById('eSig');
    if (sigEl) {
      var activePairs = positions.map(function(p) { 
        return p.pair.replace('_USDT', ''); 
      }).join(', ');
      sigEl.textContent = '🔒 FOCUS: ' + activePairs;
      sigEl.style.color = 'var(--warn)';
    }
    return;
  }
  
  var best = null, bestScore = -1;
  for (var i = 0; i < pairs.length; i++) {
    var s = pairs[i];
    var an = pData[s] && pData[s].an;
    if (!an || an.signal === 'WAIT') continue;
    var adjustedScore = an.score * (an.vr || 1) * (an.adx / 18 || 1);
    if (an.strategy === 'BREAKOUT') adjustedScore *= 1.1;
    if (an.strategy === 'PATTERN') adjustedScore *= 1.05;
    if (adjustedScore > bestScore) { 
      bestScore = adjustedScore; 
      best = {sym: s, an: an}; 
    }
  }
  
  var sigEl = document.getElementById('eSig');
  if (sigEl) sigEl.style.color = 'var(--acc)';
  if (!best) { 
    if (sigEl) sigEl.textContent = 'Scanning...'; 
    return; 
  }
  
  if (sigEl) sigEl.textContent = best.sym.replace('_USDT', '') + ' ' + best.an.signal + ' (' + best.an.score + '%)';
  
  if (autonomousMode && autoTrade && positions.length < 4) {
    Execution.open(best.sym, best.an.signal, true);
  }
  updateAutoStats();
}

function updateAutoStats() {
  var btnStats = document.getElementById('autoBtnStats');
  if (btnStats) {
    btnStats.textContent = (autonomousMode ? 'RUNNING' : 'Idle') +
      ' • ' + positions.length + ' open' +
      ' • ' + autonomousTrades + ' trades';
  }
  var autoCountEl = document.getElementById('stAutoCount');
  if (autoCountEl) autoCountEl.textContent = autonomousTrades;
}
