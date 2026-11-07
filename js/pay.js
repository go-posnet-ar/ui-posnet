// pay.js — Lógica de la página de pago del celular
// El celular escanea el QR → abre esta página → muestra monto → paga automáticamente

const state = {
  txId: null,
  payToken: null, // Token de la sesión, en el fragmento del QR: /pay/{id}#t=<token>
  apiBase: null,
  ttlTotal: 300,
  ttlRemaining: 300,
  ttlInterval: null,
  pollInterval: null,
};

// ── Inicialización ────────────────────────────────────────────────────────────

async function init() {
  // Extraer transaction_id de la URL: /pay/{id}
  const parts = window.location.pathname.split('/');
  state.txId = parts[parts.length - 1];

  // El token viaja en el fragmento: el navegador no lo envía al servidor web, así que no queda en
  // sus logs. Se saca de la barra de direcciones para que no se comparta al copiar la URL.
  state.payToken = new URLSearchParams(window.location.hash.slice(1)).get('t');
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // API base = mismo host que sirvió esta página
  state.apiBase = window.location.origin;

  if (!state.txId || state.txId === 'pay') {
    showError('ID de transacción inválido en la URL');
    return;
  }

  await loadSession();
}

// ── Cargar datos de la sesión ─────────────────────────────────────────────────

async function loadSession() {
  try {
    const res = await fetch(state.apiBase + '/api/sessions/' + state.txId + '/status', {
      headers: sessionHeaders(),
    });
    const data = await res.json();

    if (!res.ok || !data.transaction_id) {
      showError('Sesión no encontrada o expirada');
      return;
    }

    if (data.ttl_seconds <= 0 || data.state === 'EXPIRED') {
      showError('El código QR ha expirado');
      return;
    }

    // Ya fue pagado — mostrar resultado directamente
    if (data.state === 'APPROVED') { showResult('approved', data); return; }
    if (data.state === 'REJECTED') { showResult('rejected', data); return; }

    // Mostrar pantalla de monto y arrancar countdown
    state.ttlTotal = data.ttl_seconds;
    state.ttlRemaining = data.ttl_seconds;

    renderAmount(data.amount_cents, data.currency);
    showScreen('amount');
    startCountdown();

    // Pagar automáticamente después de 1.5 segundos
    setTimeout(initiatePay, 1500);

  } catch (e) {
    showError('Error de conexión con el servidor');
  }
}

// ── Mostrar monto ─────────────────────────────────────────────────────────────

function renderAmount(cents, currency) {
  const pesos = (cents / 100).toFixed(2);
  const formatted = parseFloat(pesos).toLocaleString('es-AR', { minimumFractionDigits: 2 });
  setEl('amountValue', '$ ' + formatted);
  setEl('currencyLabel', currency || 'ARS');
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function startCountdown() {
  state.ttlInterval = setInterval(() => {
    state.ttlRemaining--;

    const m = Math.floor(state.ttlRemaining / 60);
    const s = state.ttlRemaining % 60;
    setEl('ttlDisplay', m + ':' + String(s).padStart(2, '0'));

    const pct = (state.ttlRemaining / state.ttlTotal) * 100;
    const fill = document.getElementById('ttlFill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.style.background = pct < 20 ? '#ff4d6d' : pct < 40 ? '#ffb830' : '#00e5a0';
    }

    if (state.ttlRemaining <= 0) {
      clearInterval(state.ttlInterval);
      showResult('expired', null);
    }
  }, 1000);
}

// ── Iniciar pago ──────────────────────────────────────────────────────────────

async function initiatePay() {
  clearInterval(state.ttlInterval);
  showScreen('processing');
  startProcessingAnimation();

  try {
    const res = await fetch(state.apiBase + '/api/sessions/' + state.txId + '/pay', {
      method: 'POST',
      headers: sessionHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        card_last4:   '0000',
        card_network: 'VISA',
        entry_mode:   'QR',
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'error al procesar pago');
    }

    pollResult();

  } catch (e) {
    showResult('rejected', { rejection_reason: 'Error de conexión: ' + e.message });
  }
}

// ── Animación de pasos ────────────────────────────────────────────────────────

function startProcessingAnimation() {
  const steps = [
    'verificando antifraude...',
    'conectando con banco emisor...',
    'procesando autorización...',
    'confirmando pago...',
  ];
  let i = 0;
  setEl('procStep', steps[0]);
  const iv = setInterval(() => {
    i = (i + 1) % steps.length;
    setEl('procStep', steps[i]);
  }, 1400);
  // Guardar referencia para poder limpiar si hace falta
  state._stepInterval = iv;
}

// ── Polling del resultado ─────────────────────────────────────────────────────

function pollResult() {
  let attempts = 0;

  state.pollInterval = setInterval(async () => {
    attempts++;

    if (attempts > 40) {
      clearInterval(state.pollInterval);
      showResult('rejected', { rejection_reason: 'Tiempo de respuesta agotado' });
      return;
    }

    try {
      const res = await fetch(state.apiBase + '/api/sessions/' + state.txId + '/status', {
        headers: sessionHeaders(),
      });
      const data = await res.json();

      if (data.state === 'APPROVED') {
        clearInterval(state.pollInterval);
        if (state._stepInterval) clearInterval(state._stepInterval);
        showResult('approved', data);
      } else if (data.state === 'REJECTED') {
        clearInterval(state.pollInterval);
        if (state._stepInterval) clearInterval(state._stepInterval);
        showResult('rejected', data);
      } else if (data.state === 'EXPIRED') {
        clearInterval(state.pollInterval);
        if (state._stepInterval) clearInterval(state._stepInterval);
        showResult('expired', null);
      }
    } catch (_) {}
  }, 1200);
}

// ── Pantallas ─────────────────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.pay-screen').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById('pay-' + name);
  if (target) target.classList.remove('hidden');
}

function showResult(type, data) {
  clearInterval(state.ttlInterval);
  clearInterval(state.pollInterval);
  if (state._stepInterval) clearInterval(state._stepInterval);

  showScreen('result');

  const configs = {
    approved: {
      icon: '✅',
      title: 'Pago aprobado',
      titleColor: '#00e5a0',
      sub: 'Su pago fue procesado exitosamente',
      code: data?.auth_code ? 'AUTH: ' + data.auth_code : null,
    },
    rejected: {
      icon: '❌',
      title: 'Pago rechazado',
      titleColor: '#ff4d6d',
      sub: data?.rejection_reason || 'La transacción fue rechazada',
      code: null,
    },
    expired: {
      icon: '⏱',
      title: 'QR expirado',
      titleColor: '#ffb830',
      sub: 'Solicite un nuevo código QR al cajero',
      code: null,
    },
  };

  const cfg = configs[type] || configs.rejected;

  setEl('resultIcon', cfg.icon);
  setEl('resultTitle', cfg.title);
  setEl('resultSub', cfg.sub);

  const titleEl = document.getElementById('resultTitle');
  if (titleEl) titleEl.style.color = cfg.titleColor;

  const codeEl = document.getElementById('resultCode');
  if (codeEl) {
    if (cfg.code) {
      codeEl.textContent = cfg.code;
      codeEl.classList.remove('hidden');
    } else {
      codeEl.classList.add('hidden');
    }
  }
}

function showError(msg) {
  showScreen('error');
  setEl('errorMsg', msg);
}

// ── Helper ────────────────────────────────────────────────────────────────────

// sessionHeaders agrega el token de la sesión, que Terminal Gateway exige en /pay y /status.
function sessionHeaders(headers = {}) {
  if (state.payToken) headers['X-Session-Token'] = state.payToken;
  return headers;
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);