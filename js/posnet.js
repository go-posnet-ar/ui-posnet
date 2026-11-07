// posnet.js — Lógica del simulador de cajero POSNET
// Maneja: ingreso de monto → creación de sesión → generación de QR → polling del resultado

const API_BASE_KEY = 'posnet_api_base';
const TERMINAL_TOKEN_KEY = 'posnet_terminal_token';

// API Gateway de posnet. El valor anterior apuntaba al puerto gRPC de Terminal Gateway.
const DEFAULT_API_BASE = 'http://192.168.0.2:8000';
const LEGACY_API_BASE = 'http://192.168.0.2:9091';

// Terminal de prueba de posnet. Sin tokens configurados, Terminal Gateway identifica al terminal
// por este encabezado; con tokens, lo ignora y usa el del token.
const TEST_TERMINAL_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const state = {
  amountCents: 0,
  txId: null,
  payToken: null, // Token de la sesión: lo exigen /pay y /status
  ttlTotal: 300,
  ttlRemaining: 300,
  ttlInterval: null,
  pollInterval: null,
};

// ── Inicialización ────────────────────────────────────────────────────────────

function init() {
  loadApiBase();
  updateClock();
  setInterval(updateClock, 1000);
  showScreen('amount');
}

function loadApiBase() {
  let saved = localStorage.getItem(API_BASE_KEY);
  if (!saved || saved === LEGACY_API_BASE) saved = DEFAULT_API_BASE;
  document.getElementById('apiBase').value = saved;
  // El token del terminal se guarda solo mientras dure la pestaña.
  document.getElementById('terminalToken').value = sessionStorage.getItem(TERMINAL_TOKEN_KEY) || '';
}

function saveApiBase() {
  localStorage.setItem(API_BASE_KEY, getApiBase());
  sessionStorage.setItem(TERMINAL_TOKEN_KEY, getTerminalToken());
}

function getTerminalToken() {
  return document.getElementById('terminalToken').value.trim();
}

function getApiBase() {
  return document.getElementById('apiBase').value.trim();
}

function updateClock() {
  const el = document.getElementById('footerTime');
  if (el) el.textContent = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

// ── Pantallas ─────────────────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById('screen-' + name);
  if (target) target.classList.remove('hidden');
}

// ── Teclado ───────────────────────────────────────────────────────────────────

function pressKey(key) {
  clearError('amountError');

  if (key === 'del') {
    state.amountCents = Math.floor(state.amountCents / 10);
  } else {
    if (state.amountCents === 0 && key === '0') return;
    if (String(state.amountCents).length >= 8) return;
    state.amountCents = state.amountCents * 10 + parseInt(key);
  }

  renderAmount();
}

function renderAmount() {
  const pesos = (state.amountCents / 100).toFixed(2);
  document.getElementById('amountDisplay').textContent =
    parseFloat(pesos).toLocaleString('es-AR', { minimumFractionDigits: 2 });
}

// ── Crear sesión ──────────────────────────────────────────────────────────────

async function createSession() {
  if (state.amountCents < 100) {
    showError('amountError', 'monto mínimo: $ 1.00');
    return;
  }

  saveApiBase();

  try {
    const res = await fetch(getApiBase() + '/api/sessions/create', {
      method: 'POST',
      headers: terminalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ amount_cents: state.amountCents, currency: 'ARS' }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'error al crear sesión');

    state.txId = data.transaction_id;
    state.payToken = data.pay_token || null;
    state.ttlTotal = data.ttl_seconds || 300;
    state.ttlRemaining = state.ttlTotal;

    showQR(data);
  } catch (e) {
    showError('amountError', 'error: ' + e.message);
  }
}

// ── Pantalla QR ───────────────────────────────────────────────────────────────

function showQR(data) {
  showScreen('qr');

  // Monto en pantalla del QR
  document.getElementById('qrAmount').textContent =
    '$ ' + (state.amountCents / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 });

  // Generar QR con qrcodejs
  const container = document.getElementById('qrCode');
  container.innerHTML = '';
  new QRCode(container, {
    text: data.qr_content,
    width: 180,
    height: 180,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });

  // Mostrar el contenido del QR (URL) para pruebas
  const urlEl = document.getElementById('qrUrl');
  if (urlEl) {
    urlEl.textContent = data.qr_content;
    urlEl.href = data.qr_content;
  }

  startCountdown();
  startPolling();
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function startCountdown() {
  clearCountdown();

  state.ttlInterval = setInterval(() => {
    state.ttlRemaining--;

    const m = Math.floor(state.ttlRemaining / 60);
    const s = state.ttlRemaining % 60;
    const text = m + ':' + String(s).padStart(2, '0');

    setEl('countdownText', text);

    const pct = (state.ttlRemaining / state.ttlTotal) * 100;
    const fill = document.getElementById('countdownFill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.className = 'countdown-fill' +
        (pct < 20 ? ' danger' : pct < 40 ? ' warn' : '');
    }

    if (state.ttlRemaining <= 0) {
      clearCountdown();
      showResult('expired', null);
    }
  }, 1000);
}

function clearCountdown() {
  if (state.ttlInterval) clearInterval(state.ttlInterval);
  state.ttlInterval = null;
}

// ── Polling ───────────────────────────────────────────────────────────────────

function startPolling() {
  clearPolling();

  state.pollInterval = setInterval(async () => {
    if (!state.txId) return;
    try {
      const res = await fetch(getApiBase() + '/api/sessions/' + state.txId + '/status', {
        headers: sessionHeaders(),
      });
      const data = await res.json();

      if (data.state === 'APPROVED') {
        clearPolling(); clearCountdown();
        showResult('approved', data);
      } else if (data.state === 'REJECTED') {
        clearPolling(); clearCountdown();
        showResult('rejected', data);
      } else if (data.state === 'EXPIRED') {
        clearPolling(); clearCountdown();
        showResult('expired', null);
      }
    } catch (_) {}
  }, 1500);
}

function clearPolling() {
  if (state.pollInterval) clearInterval(state.pollInterval);
  state.pollInterval = null;
}

// ── Simular pago (botón del cajero) ──────────────────────────────────────────

async function simulatePay() {
  if (!state.txId) return;

  clearCountdown();
  showScreen('processing');
  startProcessingSteps();

  try {
    const res = await fetch(getApiBase() + '/api/sessions/' + state.txId + '/pay', {
      method: 'POST',
      headers: sessionHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ card_last4: '1234', card_network: 'VISA', entry_mode: 'QR' }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'error al procesar');
    }

    // Continúa el polling que ya estaba corriendo
    showScreen('processing');
  } catch (e) {
    showScreen('qr');
    showError('qrError', 'error: ' + e.message);
    startCountdown();
  }
}

// ── Animación de pasos de procesamiento ───────────────────────────────────────

let stepInterval = null;
function startProcessingSteps() {
  const steps = [
    'verificando antifraude...',
    'conectando con adquirente...',
    'procesando autorización...',
    'confirmando pago...',
  ];
  let i = 0;
  setEl('processingStep', steps[0]);
  if (stepInterval) clearInterval(stepInterval);
  stepInterval = setInterval(() => {
    i = (i + 1) % steps.length;
    setEl('processingStep', steps[i]);
  }, 1300);
}

// ── Cancelar sesión ───────────────────────────────────────────────────────────

async function cancelSession() {
  clearCountdown();
  clearPolling();

  if (state.txId) {
    try {
      const res = await fetch(getApiBase() + '/sessions/' + state.txId + '/cancel', {
        method: 'POST',
        headers: terminalHeaders({ 'X-Terminal-ID': TEST_TERMINAL_ID }),
      });
      // Si no se pudo cancelar (por ejemplo, ya se está procesando), la sesión vence sola.
      if (!res.ok) console.warn('no se pudo cancelar la sesión', res.status);
    } catch (e) {
      console.warn('no se pudo cancelar la sesión', e);
    }
  }
  newTransaction();
}

// ── Resultado ─────────────────────────────────────────────────────────────────

function showResult(type, data) {
  clearCountdown();
  clearPolling();
  if (stepInterval) clearInterval(stepInterval);

  showScreen('result');

  const amountStr = '$ ' + (state.amountCents / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 }) + ' ARS';

  const configs = {
    approved: {
      icon: '✅',
      text: 'APROBADO',
      textClass: 'text-green',
      code: data?.auth_code ? 'AUTH: ' + data.auth_code : '',
      sub: amountStr,
    },
    rejected: {
      icon: '❌',
      text: 'RECHAZADO',
      textClass: 'text-red',
      code: data?.rejection_reason || 'transacción rechazada',
      sub: amountStr,
    },
    expired: {
      icon: '⏱',
      text: 'EXPIRADO',
      textClass: 'text-amber',
      code: 'tiempo de sesión agotado',
      sub: '',
    },
  };

  const cfg = configs[type] || configs.rejected;

  setEl('resultIcon', cfg.icon);
  setEl('resultText', cfg.text);
  setEl('resultCode', cfg.code);
  setEl('resultAmount', cfg.sub);

  const textEl = document.getElementById('resultText');
  if (textEl) textEl.className = 'result-text ' + cfg.textClass;

  const codeEl = document.getElementById('resultCode');
  if (codeEl) codeEl.style.display = cfg.code ? 'inline-block' : 'none';
}

// ── Nueva transacción ─────────────────────────────────────────────────────────

function newTransaction() {
  clearCountdown();
  clearPolling();
  if (stepInterval) clearInterval(stepInterval);

  state.amountCents = 0;
  state.txId = null;
  state.payToken = null;
  clearError('amountError');
  clearError('qrError');

  document.getElementById('amountDisplay').textContent = '0';
  showScreen('amount');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// terminalHeaders agrega el token del terminal, que Terminal Gateway exige en create y cancel
// cuando tiene TERMINAL_TOKENS_FILE.
function terminalHeaders(headers = {}) {
  const token = getTerminalToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return headers;
}

// sessionHeaders agrega el token de la sesión, que Terminal Gateway exige en /pay y /status.
function sessionHeaders(headers = {}) {
  if (state.payToken) headers['X-Session-Token'] = state.payToken;
  return headers;
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

function clearError(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = '';
}

// ── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
