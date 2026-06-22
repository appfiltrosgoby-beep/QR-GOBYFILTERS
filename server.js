/**
 * Servidor Backend - QR Scanner App
 * Maneja las solicitudes del frontend y la integración con Google Sheets
 */

// Force IPv4 DNS resolution — Render free tier has routing issues with IPv6
// to googleapis.com, causing ERR_STREAM_PREMATURE_CLOSE on cold starts.
require('dns').setDefaultResultOrder('ipv4first');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');
const https = require('https');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Disable keep-alive on the global HTTPS agent — keeps connections fresh
// and avoids stale-socket ERR_STREAM_PREMATURE_CLOSE on Render.
https.globalAgent.options.keepAlive = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryAfterMs(error) {
  const retryAfter = error?.response?.headers?.['retry-after'];
  if (!retryAfter) return 0;
  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function isRetryableSheetsError(error) {
  const status = error?.response?.status || error?.status;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;

  const code = (error?.code || '').toString();
  return ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code);
}

function formatErrorForLogging(error) {
  if (!error) return { message: 'Unknown error' };
  if (typeof error === 'string') return { message: error };

  const status = error?.response?.status || error?.status;
  const googleError = error?.response?.data?.error || null;
  const retryAfterMs = getRetryAfterMs(error);

  const safe = {
    message: error?.message || String(error),
    code: error?.code || undefined,
    status: status || undefined,
    googleStatus: googleError?.status || undefined,
    googleMessage: googleError?.message || undefined,
    retryAfterMs: retryAfterMs || undefined
  };

  if ((process.env.NODE_ENV || '').toLowerCase() !== 'production' && error?.stack) {
    safe.stack = error.stack;
  }

  return safe;
}

function getErrorHttpStatus(error) {
  return error?.response?.status || error?.status || 0;
}

function isGoogleQuotaError(error) {
  const status = getErrorHttpStatus(error);
  if (status === 429) return true;
  const message = (error?.response?.data?.error?.message || error?.message || '').toString().toLowerCase();
  return message.includes('quota exceeded') || message.includes('rate limit');
}

function respondGoogleSheetsError(res, error, fallbackError = 'Error en Google Sheets') {
  const status = getErrorHttpStatus(error);
  const retryAfterMs = getRetryAfterMs(error);

  if (isGoogleQuotaError(error)) {
    if (retryAfterMs) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    }
    return res.status(429).json({
      success: false,
      error: 'Google API error - cuota excedida',
      details: error?.response?.data?.error?.message || error?.message || 'Quota exceeded'
    });
  }

  const safeDetails = error?.response?.data?.error?.message || error?.message || '';
  return res.status(status && status >= 400 ? status : 500).json({
    success: false,
    error: fallbackError,
    details: safeDetails
  });
}

async function withSheetsRetry(fn, label = 'sheets') {
  const maxAttempts = Number.parseInt(process.env.SHEETS_RETRY_MAX_ATTEMPTS || '4', 10);
  const baseDelayMs = Number.parseInt(process.env.SHEETS_RETRY_BASE_DELAY_MS || '500', 10);
  const maxDelayMs = Number.parseInt(process.env.SHEETS_RETRY_MAX_DELAY_MS || '8000', 10);

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      const retryable = isRetryableSheetsError(error);
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }

      const retryAfterMs = getRetryAfterMs(error);
      const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 150);
      const delayMs = Math.min(maxDelayMs, Math.max(retryAfterMs, exponential) + jitter);

      const logData = formatErrorForLogging(error);
      console.warn(`⚠️ Sheets API [MISS] (${label}) intento ${attempt}/${maxAttempts} en ${delayMs}ms. Error: ${logData.googleMessage || logData.message}`);
      await sleep(delayMs);
    }
  }
}

// Validar variables de entorno críticas
const requiredEnvVars = ['GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SPREADSHEET_ID', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.warn('⚠️ ADVERTENCIA: Variables de entorno faltantes:', missingEnvVars);
  if (missingEnvVars.some(v => v.startsWith('SMTP'))) {
      console.warn('⚠️ La funcionalidad de envío de correos (restablecer contraseña) no funcionará.');
  }
  if (missingEnvVars.some(v => v.includes('GOOGLE'))) {
      console.warn('⚠️ Las rutas de Google Sheets fallarán.');
  }
  console.warn('⚠️ Configura estas variables en el panel de Render para solucionar el error 500.');
}

const app = express();
const PORT = process.env.PORT || 3000;
const path = require('path');

function getRequestIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return forwarded || req.ip || '';
}

function createInMemoryRateLimiter({ windowMs, maxRequests, keyFn }) {
  const hits = new Map();
  const cleanupIntervalMs = Math.max(windowMs, 60_000);

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (now >= entry.resetAt) {
        hits.delete(key);
      }
    }
  }, cleanupIntervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return function rateLimiter(req, res, next) {
    try {
      const now = Date.now();
      const key = (keyFn ? keyFn(req) : getRequestIp(req)) || 'unknown';
      let entry = hits.get(key);

      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }

      entry.count += 1;
      const remaining = Math.max(0, maxRequests - entry.count);
      res.set('X-RateLimit-Limit', String(maxRequests));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

      if (entry.count > maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          success: false,
          message: 'Demasiadas solicitudes. Intenta de nuevo en unos segundos.'
        });
      }

      return next();
    } catch (error) {
      // Si el rate limiter falla, no bloquear el request.
      return next();
    }
  };
}

const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_AUTH_MAX = Number.parseInt(process.env.RATE_LIMIT_AUTH_MAX || '25', 10);
const RATE_LIMIT_PUBLIC_MAX = Number.parseInt(process.env.RATE_LIMIT_PUBLIC_MAX || '40', 10);
const RATE_LIMIT_SCAN_MAX = Number.parseInt(process.env.RATE_LIMIT_SCAN_MAX || '600', 10);

const authLimiter = createInMemoryRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_AUTH_MAX });
const publicLimiter = createInMemoryRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_PUBLIC_MAX });
const scanLimiter = createInMemoryRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_SCAN_MAX });

// Middlewares
app.use(cors());
app.use(compression()); // Comprimir respuestas
app.use(bodyParser.json());

// Rate limiting (según especificación: proteger auth y endpoints públicos)
app.use('/api/validate-user', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/contact-request', publicLimiter);
app.use('/api/save-qr', scanLimiter);
app.use('/api/bulk-ingress', scanLimiter);

// Debug: Log de rutas
const publicPath = path.join(__dirname, 'public');
console.log('📁 Public path:', publicPath);

// Middleware para servir archivos estáticos con cache apropiado
app.use(express.static(publicPath, {
  maxAge: '1d',
  etag: false,
  setHeaders: (res, path) => {
    // No cachear HTML, JSON y JS de manera agresiva
    if (path.endsWith('.html') || path.endsWith('.json') || path.endsWith('.js')) {
      res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
    }
    // Cachear imágenes por más tiempo
    if (path.endsWith('.png') || path.endsWith('.svg')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// Servir manifest.json con el content-type correcto
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json');
  res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
  res.sendFile(path.join(publicPath, 'manifest.json'));
});

// Servir Service Worker
app.get('/service-worker.js', (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(publicPath, 'service-worker.js'));
});

// Servir browserconfig.xml
app.get('/browserconfig.xml', (req, res) => {
  res.type('application/xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(publicPath, 'browserconfig.xml'));
});

let mailTransport = null;

function getSmtpConfig() {
  const service = (process.env.SMTP_SERVICE || '').toString().trim();
  const host = (process.env.SMTP_HOST || '').toString().trim();
  const port = Number.parseInt((process.env.SMTP_PORT || '').toString().trim() || '587', 10);
  const user = (process.env.SMTP_USER || '').toString().trim();
  const pass = (process.env.SMTP_PASS || '').toString();
  const from = (process.env.SMTP_FROM || user || '').toString().trim();

  const secureRaw = (process.env.SMTP_SECURE || '').toString().trim().toLowerCase();
  const secure = secureRaw ? secureRaw === 'true' : port === 465;

  return { service, host, port, user, pass, from, secure };
}

function assertMailConfigured() {
  const { service, host, port, user, pass, from } = getSmtpConfig();
  const missing = [];
  if (!service && !host) missing.push('SMTP_HOST o SMTP_SERVICE');
  if (!Number.isFinite(port) || port <= 0) missing.push('SMTP_PORT');
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');
  if (!from) missing.push('SMTP_FROM');

  if (missing.length > 0) {
    const error = new Error(`Servicio de correo no configurado: falta ${missing.join(', ')}`);
    error.code = 'MAIL_NOT_CONFIGURED';
    throw error;
  }
}

function getMailTransport() {
  if (mailTransport) {
    return mailTransport;
  }

  assertMailConfigured();
  const { service, host, port, user, pass, secure } = getSmtpConfig();

  console.log('📧 Configurando transporte de correo:', { service, host, port, user, secure });

  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  const transportOptions = {
    auth: { user, pass },
    debug: !isProd,
    logger: !isProd,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 45000
  };

  if (service) {
    transportOptions.service = service;
  } else {
    transportOptions.host = host;
    transportOptions.port = port;
    transportOptions.secure = secure;
  }

  mailTransport = nodemailer.createTransport(transportOptions);

  return mailTransport;
}

/**
 * Envía un correo via Resend HTTP API usando https.request() nativo.
 * Render free tier bloquea todos los puertos SMTP (25, 465, 587),
 * pero las llamadas HTTPS salientes funcionan correctamente.
 */
async function sendEmailViaResend({ from, to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const body = JSON.stringify({
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const err = new Error(`Resend API (${res.statusCode}): ${parsed.message || JSON.stringify(parsed)}`);
              err.code = res.statusCode === 401 ? 'EAUTH' : 'ERESEND';
              reject(err);
            }
          } catch (e) {
            reject(new Error(`Resend: respuesta no parseable: ${data.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error('Resend API timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Envía un correo via Brevo HTTP API usando https.request() nativo.
 * No requiere verificar dominio — solo el correo remitente (SMTP_FROM).
 */
async function sendEmailViaBrevo({ from, to, subject, html, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  const toList = (Array.isArray(to) ? to : [to]).map(email =>
    typeof email === 'string' ? { email } : email
  );
  const body = JSON.stringify({
    sender: { name: 'GOBY FILTERS QR', email: from },
    to: toList,
    subject,
    htmlContent: html,
    textContent: text,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const err = new Error(`Brevo API (${res.statusCode}): ${parsed.message || JSON.stringify(parsed)}`);
              err.code = res.statusCode === 401 ? 'EAUTH' : 'EBREVO';
              reject(err);
            }
          } catch (e) {
            reject(new Error(`Brevo: respuesta no parseable: ${data.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error('Brevo API timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Envío unificado.
 * Prioridad: Brevo → Resend → SMTP (desarrollo local).
 */
async function sendEmail({ from, to, subject, html, text }) {
  if (process.env.BREVO_API_KEY) {
    return sendEmailViaBrevo({ from, to, subject, html, text });
  }
  if (process.env.RESEND_API_KEY) {
    return sendEmailViaResend({ from, to, subject, html, text });
  }
  const transport = getMailTransport();
  return transport.sendMail({
    from,
    to: Array.isArray(to) ? to.join(',') : to,
    subject,
    html,
    text,
  });
}

async function sendForgotPasswordConfirmationEmail({ toEmail, displayName, accountUsername, accountPassword, requestId, requestIp, userAgent }) {
  const { from } = getSmtpConfig();

  const safeName = (displayName || '').toString().trim() || 'Usuario';
  const now = new Date();

  const subject = 'Tus credenciales de acceso - GOBY FILTERS QR';
  const text = [
    `Hola ${safeName},`,
    '',
    'Aquí están tus credenciales de acceso a GOBY FILTERS QR:',
    '',
    `Usuario: ${accountUsername}`,
    accountPassword ? `Contraseña: ${accountPassword}` : null,
    '',
    'Si no solicitaste este correo, contáctate con tu administrador.',
    '',
    `ID de solicitud: ${requestId}`,
    `Fecha: ${now.toLocaleString('es-CO')}`,
  ].filter(Boolean).join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; max-width: 520px;">
      <p>Hola <strong>${escapeHtml(safeName)}</strong>,</p>
      <p>Aquí están tus credenciales de acceso a <strong>GOBY FILTERS QR</strong>:</p>
      <table style="border-collapse: collapse; background: #f5f5f5; border-radius: 6px; padding: 16px; width: 100%; margin: 16px 0;">
        <tr>
          <td style="padding: 8px 12px; font-weight: bold; white-space: nowrap;">Usuario:</td>
          <td style="padding: 8px 12px; font-family: monospace; font-size: 1em;">${escapeHtml(accountUsername)}</td>
        </tr>
        ${accountPassword ? `
        <tr>
          <td style="padding: 8px 12px; font-weight: bold; white-space: nowrap;">Contraseña:</td>
          <td style="padding: 8px 12px; font-family: monospace; font-size: 1em;">${escapeHtml(accountPassword)}</td>
        </tr>` : ''}
      </table>
      <p style="color: #555; font-size: 0.9em;">Si no solicitaste este correo, contáctate con tu administrador.</p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;"/>
      <p style="margin: 0; color: #888; font-size: 0.8em;">ID de solicitud: ${escapeHtml(requestId)} &nbsp;|&nbsp; ${escapeHtml(now.toLocaleString('es-CO'))}</p>
    </div>
  `;

  await sendEmail({ from, to: toEmail, subject, html, text });
}

function escapeHtml(value) {
  return (value || '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Recibe una solicitud de contacto del usuario.
 * POST /api/contact-request
 * Body: { solicitud, nombre?, email?, telefono?, usuarioApp?, clienteApp?, rolApp? }
 */
app.post('/api/contact-request', async (req, res) => {
  try {
    const body = req.body || {};
    const solicitud = (body.solicitud || '').toString().trim();
    const nombre = (body.nombre || '').toString().trim();
    const email = (body.email || '').toString().trim();
    const telefono = (body.telefono || '').toString().trim();
    const usuarioApp = (body.usuarioApp || '').toString().trim();
    const clienteApp = (body.clienteApp || '').toString().trim();
    const rolApp = (body.rolApp || '').toString().trim();

    if (!solicitud) {
      return res.status(400).json({ success: false, message: 'La solicitud es requerida' });
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Correo inválido' });
    }

    if (telefono) {
      const phoneError = validatePhoneMinDigits(telefono, 10);
      if (phoneError) {
        return res.status(400).json({ success: false, message: phoneError });
      }
    }

    const timestamp = new Date();
    const formatted = formatDateTimeForSheet(timestamp);

    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const userAgent = (req.get('user-agent') || '').toString();

    const rowData = {
      FECHA: formatted.date,
      HORA: formatted.time,
      SOLICITUD: solicitud,
      NOMBRE: nombre,
      EMAIL: email,
      TELEFONO: telefono,
      USUARIO_APP: usuarioApp,
      CLIENTE_APP: clienteApp,
      ROL_APP: rolApp,
      IP: ip,
      USER_AGENT: userAgent,
      TIMESTAMP_ISO: timestamp.toISOString()
    };

    let savedTo = 'local';

    try {
      const doc = await getGoogleSheet();
      const sheet = await getOrCreateContactRequestsSheet(doc);
      await sheet.addRow(rowData);
      savedTo = 'sheets';
    } catch (error) {
      // Fallback: guardar localmente para no perder solicitudes si Sheets no está configurado.
      try {
        const outDir = path.join(__dirname, 'data');
        await fs.promises.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, 'contact-requests.jsonl');
        await fs.promises.appendFile(outPath, JSON.stringify(rowData) + '\n', 'utf8');
      } catch (fallbackError) {
        console.warn('⚠️ No se pudo guardar la solicitud localmente:', fallbackError);
      }
      console.warn('⚠️ Guardado en Google Sheets falló, usando fallback local:', error?.message || error);
      savedTo = 'local';
    }

    return res.json({ success: true, message: 'Solicitud recibida', savedTo });
  } catch (error) {
    console.error('Error en /api/contact-request:', formatErrorForLogging(error));
    res.status(500).json({ success: false, error: 'Error al procesar la solicitud' });
  }
});

/**
 * Valida un usuario contra la hoja USUARIOS
 * POST /api/validate-user
 * Body: { usuario, tipo, password }
 */
app.post('/api/validate-user', async (req, res) => {
  try {
    const { usuario, tipo, password } = req.body;

    if (!usuario || !tipo || !password) {
      return res.status(400).json({ success: false, message: 'Usuario, tipo y contraseña son requeridos' });
    }

    const doc = await getGoogleSheet();
    const normalizedType = normalizeType(tipo);

    const lookup = await findUserRowByLoginIdentifier(doc, usuario, password);
    if (lookup.error === 'ambiguous') {
      return res.json({ success: false, message: lookup.message || 'Usuario ambiguo. Usa tu correo.' });
    }

    const userRow = lookup.row;
    if (!userRow || !doesPasswordMatchRow(userRow, password)) {
      return res.json({ success: false, message: 'Usuario no autorizado' });
    }

    const userClient = userRow.get('CLIENTE') || '';
    const canonicalUser = normalizeUser(userRow.get('USUARIO') || usuario);
    const userDisplayName = (userRow.get('NOMBRE') || '').toString().trim();

    const storedType = normalizeType(userRow.get('TIPO'));

    // Validar tipo de usuario según el flujo de login
    if (normalizedType === 'user') {
      // Flujo "usuarios": acepta mecánico y despacho
      if (!['mecanico', 'despacho'].includes(storedType)) {
        return res.json({ success: false, message: 'Tipo no autorizado para acceso de usuarios' });
      }
    } else if (normalizedType === 'administrador') {
      // Flujo "administrador": acepta administrador y superadmin
      if (storedType !== 'administrador' && storedType !== 'super') {
        return res.json({ success: false, message: 'Tipo no autorizado para acceso de administrador' });
      }
    } else {
      // Otros flujos: tipo debe coincidir exactamente
      if (storedType !== normalizedType) {
        return res.json({ success: false, message: 'Tipo no autorizado' });
      }
    }

    // Determinar el rol basado en el TIPO del usuario
    let role = 'user';
    if (storedType === 'super') {
      role = 'superadmin';
    } else if (storedType === 'administrador') {
      role = 'admin';
    } else if (storedType === 'despacho') {
      role = 'dispatch';
    }
    // mecánico e despacho inician sesión como 'user' o 'dispatch'
    
    return res.json({ 
      success: true, 
      tipo: storedType, 
      usuario: canonicalUser,
      nombre: userDisplayName,
      role,
      cliente: userClient 
    });
  } catch (error) {
    console.error('Error al validar usuario:', formatErrorForLogging(error));
    res.status(500).json({ success: false, error: 'Error al validar usuario' });
  }
});

/**
 * Solicitud de restablecimiento de contraseña (público)
 * POST /api/forgot-password
 * Body: { usuario }
 * Envía un correo de confirmación al correo asociado al perfil.
 */
app.post('/api/forgot-password', async (req, res) => {
  try {
    const body = req.body || {};
    const usuario = (body.usuario || '').toString().trim();

    if (!usuario) {
      return res.status(400).json({ success: false, message: 'Usuario (correo o nombre) es requerido' });
    }

    // Si el servicio de correo no está configurado, reportarlo claramente.
    assertMailConfigured();

    const doc = await getGoogleSheet();
    const lookup = await findUserRowByLoginIdentifier(doc, usuario);
    if (lookup.error === 'ambiguous') {
      return res.status(400).json({ success: false, message: lookup.message || 'Usuario ambiguo. Usa tu correo.' });
    }

    // Respuesta genérica para evitar enumeración de usuarios.
    const genericResponse = { success: true, message: 'Si la cuenta existe, se enviará un correo de confirmación al email asociado.' };

    if (!lookup.row) {
      return res.json(genericResponse);
    }

    const profileEmail = (lookup.row.get('USUARIO') || '').toString().trim();
    const displayName = (lookup.row.get('NOMBRE') || '').toString().trim();
    const accountUsername = profileEmail;
    const accountPassword = (lookup.row.get('CONTRASEÑA') || '').toString().trim();

    if (!profileEmail || !isValidEmail(profileEmail)) {
      return res.json(genericResponse);
    }

    const requestId = crypto.randomBytes(16).toString('hex');
    const requestIp = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const userAgent = (req.get('user-agent') || '').toString();

    try {
      await sendForgotPasswordConfirmationEmail({
        toEmail: profileEmail,
        displayName,
        accountUsername,
        accountPassword,
        requestId,
        requestIp,
        userAgent
      });
    } catch (mailError) {
      const errorLog = formatErrorForLogging(mailError);
      const smtpCfg = getSmtpConfig();
      console.error('❌ Error crítico enviando correo (detalles):', JSON.stringify(errorLog, null, 2));
      console.error('📧 Config SMTP activa en Render:', { service: smtpCfg.service, host: smtpCfg.host, port: smtpCfg.port, user: smtpCfg.user, secure: smtpCfg.secure });
      
      let userMessage = 'No se pudo enviar el correo de confirmación. Intenta más tarde.';
      if (mailError?.code === 'EAUTH') {
        userMessage = 'Error de autenticación con el servidor de correo. Revisa SMTP_USER y SMTP_PASS.';
      } else if (mailError?.code === 'ETIMEDOUT') {
        userMessage = 'Tiempo de espera agotado conectando al servidor SMTP. Revisa SMTP_HOST y SMTP_PORT.';
      } else if (mailError?.code === 'ENOTFOUND' || mailError?.code === 'EDNS') {
        userMessage = 'No se pudo encontrar el servidor SMTP. Verifica que SMTP_HOST sea correcto en la configuración.';
      }
      return res.status(500).json({ success: false, message: userMessage });
    }

    return res.json(genericResponse);
  } catch (error) {
    console.error('Error en /api/forgot-password:', formatErrorForLogging(error));
    if (error?.code === 'MAIL_NOT_CONFIGURED') {
      return res.status(500).json({ success: false, message: error.message || 'Servicio de correo no configurado' });
    }
    return res.status(500).json({ success: false, message: 'Error al procesar la solicitud' });
  }
});

function isValidEmail(email) {
  const value = (email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateStrongPassword(password) {
  const value = (password || '').toString();
  if (value.length < 8) return 'La contraseña debe tener mínimo 8 caracteres';
  if (!/[a-z]/.test(value)) return 'La contraseña debe tener al menos una minúscula';
  if (!/[A-Z]/.test(value)) return 'La contraseña debe tener al menos una mayúscula';
  if (!/[^A-Za-z0-9]/.test(value)) return 'La contraseña debe tener al menos un carácter especial';
  return '';
}

function normalizePhoneDigits(phone) {
  return (phone || '').toString().replace(/\D/g, '');
}

function validatePhoneMinDigits(phone, minDigits = 10) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) {
    return 'El teléfono es requerido';
  }
  if (digits.length < minDigits) {
    return `El teléfono debe tener mínimo ${minDigits} dígitos`;
  }
  return '';
}

function normalizeName(name) {
  return (name || '').toString().trim();
}

function normalizePersonNameForMatch(value) {
  return (value || '')
    .toString()
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function looksLikeEmail(value) {
  return /@/.test((value || '').toString());
}

function doesPasswordMatchRow(userRow, password) {
  const storedPassword = (userRow?.get?.('CONTRASEÑA') || '').toString().trim();
  return storedPassword === (password || '').toString();
}

async function findUserRowByLoginIdentifier(doc, loginIdentifier, passwordHint = '') {
  const input = (loginIdentifier || '').toString().trim();
  if (!input) {
    return { row: null, error: 'missing_identifier' };
  }

  const normalizedUser = normalizeUser(input);
  const normalizedName = normalizePersonNameForMatch(input);

  // Optimizamos usando el caché global de filas de usuarios para evitar N lecturas a Sheets
  const startTime = Date.now();
  const allRows = await getCachedAllUsersRows(doc);
  const duration = Date.now() - startTime;
  
  const emailMatches = [];
  const nameMatches = [];

  for (const item of allRows) {
    const row = item.row;
    if (normalizeUser(row.get('USUARIO')) === normalizedUser) {
      emailMatches.push({ sheet: item.sheet, row });
    }
    if (normalizePersonNameForMatch(row.get('NOMBRE') || '') === normalizedName) {
      nameMatches.push({ sheet: item.sheet, row });
    }
  }

  console.log(`🔍 Lookup Usuario: "${input}" | [CACHE ${duration < 10 ? 'HIT' : 'MISS'}] | Tiempo: ${duration}ms | Resultados: ${emailMatches.length + nameMatches.length}`);

  // Si parece correo, solo buscar por USUARIO
  if (looksLikeEmail(input)) {
    if (emailMatches.length === 0) {
      return { row: null, sheet: null, error: 'not_found' };
    }

    const passwordValue = (passwordHint || '').toString();
    const preferred = passwordValue
      ? (emailMatches.find(m => doesPasswordMatchRow(m.row, passwordValue)) || null)
      : null;

    const match = preferred || emailMatches[0];
    return { row: match.row, sheet: match.sheet, error: null };
  }

  // Buscar por NOMBRE (si es único)
  if (nameMatches.length > 1) {
    return { row: null, error: 'ambiguous', message: 'Hay varios usuarios con ese nombre. Inicia sesión con tu correo.' };
  }
  if (nameMatches.length === 1) {
    return { row: nameMatches[0].row, sheet: nameMatches[0].sheet, error: null };
  }

  // Fallback: buscar por USUARIO aunque no parezca correo (por compatibilidad)
  if (emailMatches.length === 0) {
    return { row: null, sheet: null, error: 'not_found' };
  }

  const passwordValue = (passwordHint || '').toString();
  const preferred = passwordValue
    ? (emailMatches.find(m => doesPasswordMatchRow(m.row, passwordValue)) || null)
    : null;

  const emailMatch = preferred || emailMatches[0];
  return { row: emailMatch.row, sheet: emailMatch.sheet, error: null };
}

/**
 * Registro de usuario (público)
 * POST /api/register
 * Body: { nombre, correo, password, cliente }
 * Crea una solicitud de registro pendiente (requiere aprobación de superadmin).
 * Al aprobar, se guarda la información en la hoja global USUARIOS.
 */
app.post('/api/register', async (req, res) => {
  try {
    const { nombre, correo, telefono, usuario, password, cliente } = req.body;

    const normalizedName = normalizeName(nombre);
    const normalizedEmail = normalizeUser(correo || usuario);
    const normalizedPhone = (telefono || '').toString().trim();

    const normalizedClientInput = normalizeClientForMatch(cliente || '');

    if (!normalizedName || !normalizedEmail || !normalizedPhone || !password || !normalizedClientInput) {
      return res.status(400).json({ success: false, message: 'Nombre, correo, teléfono, empresa y contraseña son requeridos' });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'El usuario debe ser un correo válido' });
    }

    const phoneError = validatePhoneMinDigits(normalizedPhone, 10);
    if (phoneError) {
      return res.status(400).json({ success: false, message: phoneError });
    }

    const passwordError = validateStrongPassword(password);
    if (passwordError) {
      return res.status(400).json({ success: false, message: passwordError });
    }

    // Tipo por defecto para registros públicos (el rol despacho/admin se gestiona por administradores)
    const normalizedTipo = 'mecanico';

    const doc = await getGoogleSheet();

    // Validar que el cliente exista (los clientes se manejan en la hoja CLIENTES)
    const clientsSheet = await getOrCreateClientsSheet(doc);
    const clientsRows = await clientsSheet.getRows();
    const matchedClientRow = clientsRows.find(row => normalizeClientForMatch(row.get('NOMBRE') || '') === normalizedClientInput);
    
    // Si no existe, permitimos el registro pero lo marcamos como nuevo (se creará al aprobar)
    const canonicalClientName = matchedClientRow 
      ? (matchedClientRow.get('NOMBRE') || '').toString().trim() 
      : (cliente || '').toString().trim().toUpperCase();
    
    const isNewClient = !matchedClientRow;

    const globalSheet = await getOrCreateUsersSheet(doc);
    const pendingSheet = await getOrCreatePendingUsersSheet(doc);

    // Validar duplicado en hoja global
    const globalRows = await globalSheet.getRows();
    const existsGlobal = globalRows.some(row => normalizeUser(row.get('USUARIO')) === normalizedEmail);
    if (existsGlobal) {
      return res.status(409).json({ success: false, message: 'El usuario ya existe' });
    }

    // Validar duplicado en pendientes
    const pendingRows = await pendingSheet.getRows();
    const pendingExists = pendingRows.some(row => {
      const rowUser = normalizeUser(row.get('USUARIO'));
      const estado = (row.get('ESTADO') || '').toString().trim().toUpperCase();
      return rowUser === normalizedEmail && (estado === 'PENDIENTE' || estado === 'EN_REVISION');
    });
    if (pendingExists) {
      return res.status(409).json({
        success: false,
        message: 'Ya existe una solicitud pendiente para este usuario'
      });
    }

    // Validar duplicado en hojas por cliente (si existen)
    await ensureDocInfoLoaded(doc);
    for (const sheet of doc.sheetsByIndex) {
      if (!sheet.title.endsWith('_USUARIOS')) continue;
      const rows = await sheet.getRows();
      const exists = rows.some(row => normalizeUser(row.get('USUARIO')) === normalizedEmail);
      if (exists) {
        return res.status(409).json({ success: false, message: 'El usuario ya existe' });
      }
    }

    const requestId = generateRegistrationRequestId();
    const createdAt = new Date().toLocaleString('es-ES');

    await pendingSheet.addRow({
      'ID': requestId,
      'NOMBRE': normalizedName,
      'TELEFONO': normalizedPhone,
      'USUARIO': normalizedEmail,
      'CONTRASEÑA': password,
      'CLIENTE': canonicalClientName,
      'TIPO': normalizedTipo,
      'ESTADO': 'PENDIENTE',
      'CLIENTE_NUEVO': isNewClient ? 'SÍ' : 'NO',
      'CREADO_EN': createdAt,
      'APROBADO_EN': '',
      'APROBADO_POR': ''
    });

    // Notificar superadmins (no bloquear por errores de notificación)
    try {
      await createPendingRegistrationAlerts(doc, {
        requestId,
        nombre: normalizedName,
        email: normalizedEmail,
        telefono: normalizedPhone,
        cliente: canonicalClientName,
        isNewClient
      });
    } catch (error) {
      console.warn('⚠️ No se pudieron crear alertas de registro pendiente:', formatErrorForLogging(error));
    }

    await sendPendingRegistrationEmailToSuperadmins({
      requestId,
      nombre: normalizedName,
      email: normalizedEmail,
      telefono: normalizedPhone,
      cliente: canonicalClientName,
      isNewClient
    });

    // Confirmar al usuario que su solicitud fue recibida
    try {
      await sendRegistrationConfirmationToUser({
        nombre: normalizedName,
        email: normalizedEmail,
        cliente: canonicalClientName,
        requestId
      });
    } catch (mailError) {
      console.warn('⚠️ No se pudo enviar confirmación de registro al usuario:', formatErrorForLogging(mailError));
    }

    return res.json({
      success: true,
      message: 'Solicitud enviada. Pendiente de aprobación por superadmin',
      requestId
    });
  } catch (error) {
    console.error('Error al registrar usuario:', formatErrorForLogging(error));
    return res.status(500).json({ success: false, message: 'Error al registrar usuario' });
  }
});

/**
 * Lista solicitudes de registro pendientes (solo superadmin)
 * GET /api/register/pending
 * Headers: x-auth-user, x-auth-password
 */
app.get('/api/register/pending', async (req, res) => {
  let cacheKey = null;
  try {
    const authUser = (req.headers['x-auth-user'] || '').toString().trim();
    const authPassword = (req.headers['x-auth-password'] || '').toString();

    if (!authUser || !authPassword) {
      return res.status(401).json({ success: false, error: 'Credenciales requeridas' });
    }

    const doc = await getGoogleSheet();
    const auth = await findUserRowByCredentials(doc, authUser, authPassword);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const authTipo = normalizeType(auth.row.get('TIPO'));
    if (authTipo !== 'super') {
      return res.status(403).json({ success: false, error: 'Solo superadmin' });
    }

    cacheKey = `register-pending|${normalizeUser(auth.row.get('USUARIO') || authUser)}`;
    const cached = getFromApiCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const pendingSheet = await getOrCreatePendingUsersSheet(doc);
    const rows = await pendingSheet.getRows();
    
    // Cargar clientes existentes para marcar los nuevos en la lista
    const clientsSheet = await getOrCreateClientsSheet(doc);
    const clientsRows = await clientsSheet.getRows();
    const existingClientNames = new Set(clientsRows.map(r => normalizeClientForMatch(r.get('NOMBRE') || '')));

    const pending = rows
      .map(row => {
        const clientName = (row.get('CLIENTE') || '').toString().trim();
        return {
          id: (row.get('ID') || '').toString().trim(),
          nombre: (row.get('NOMBRE') || '').toString().trim(),
          telefono: (row.get('TELEFONO') || '').toString().trim(),
          usuario: normalizeUser(row.get('USUARIO')),
          cliente: clientName,
          clienteNuevo: !existingClientNames.has(normalizeClientForMatch(clientName)),
          tipo: normalizeType(row.get('TIPO')),
          estado: (row.get('ESTADO') || '').toString().trim().toUpperCase(),
          creadoEn: (row.get('CREADO_EN') || '').toString().trim()
        };
      })
      .filter(item => !!item.id && item.estado === 'PENDIENTE');

    const payload = { success: true, data: pending };
    setToApiCache(cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    console.error('Error listando registros pendientes:', formatErrorForLogging(error));
    if (cacheKey && isGoogleQuotaError(error)) {
      const payload = {
        success: false,
        error: 'Google API error - cuota excedida',
        details: error?.response?.data?.error?.message || error?.message || 'Quota exceeded'
      };
      setToApiCache(cacheKey, payload, API_QUOTA_ERROR_CACHE_TTL_MS);
    }
    return respondGoogleSheetsError(res, error, 'Error listando registros pendientes');
  }
});

/**
 * Aprueba una solicitud de registro pendiente (solo superadmin)
 * POST /api/register/approve
 * Headers: x-auth-user, x-auth-password
 * Body: { requestId }
 */
app.post('/api/register/approve', async (req, res) => {
  try {
    const authUser = (req.headers['x-auth-user'] || '').toString().trim();
    const authPassword = (req.headers['x-auth-password'] || '').toString();
    const requestId = (req.body?.requestId || '').toString().trim();

    if (!authUser || !authPassword) {
      return res.status(401).json({ success: false, error: 'Credenciales requeridas' });
    }
    if (!requestId) {
      return res.status(400).json({ success: false, error: 'requestId es requerido' });
    }

    const doc = await getGoogleSheet();
    const auth = await findUserRowByCredentials(doc, authUser, authPassword);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const authTipo = normalizeType(auth.row.get('TIPO'));
    if (authTipo !== 'super') {
      return res.status(403).json({ success: false, error: 'Solo superadmin' });
    }

    const pendingSheet = await getOrCreatePendingUsersSheet(doc);
    const pendingRows = await pendingSheet.getRows();
    const pendingRow = pendingRows.find(row => (row.get('ID') || '').toString().trim() === requestId) || null;
    if (!pendingRow) {
      return res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
    }

    const estado = (pendingRow.get('ESTADO') || '').toString().trim().toUpperCase();
    if (estado !== 'PENDIENTE') {
      return res.status(409).json({ success: false, error: `La solicitud no está pendiente (estado: ${estado || 'N/A'})` });
    }

    const nombre = (pendingRow.get('NOMBRE') || '').toString().trim();
    const telefono = (pendingRow.get('TELEFONO') || '').toString().trim();
    const usuario = normalizeUser(pendingRow.get('USUARIO'));
    const password = (pendingRow.get('CONTRASEÑA') || '').toString();
    const cliente = (pendingRow.get('CLIENTE') || '').toString().trim();
    const tipo = normalizeType(pendingRow.get('TIPO')) || 'mecanico';

    if (!usuario || !password || !cliente) {
      return res.status(400).json({ success: false, error: 'Solicitud incompleta (usuario/contraseña/cliente)' });
    }

    const globalUsersSheet = await getOrCreateUsersSheet(doc);
    const globalRows = await globalUsersSheet.getRows();
    const exists = globalRows.some(row => normalizeUser(row.get('USUARIO')) === usuario);
    if (exists) {
      return res.status(409).json({ success: false, error: 'El usuario ya existe en USUARIOS' });
    }

    // Validar si la empresa existe, si no, crearla automáticamente
    const clientsSheet = await getOrCreateClientsSheet(doc);
    const clientsRows = await clientsSheet.getRows();
    const normalizedClientInput = normalizeClientForMatch(cliente);
    const matchedClientRow = clientsRows.find(row => normalizeClientForMatch(row.get('NOMBRE') || '') === normalizedClientInput);

    if (!matchedClientRow) {
      console.log(`🆕 Creando nueva empresa "${cliente}" automáticamente al aprobar registro`);
      const now = new Date().toLocaleDateString('es-ES');
      await clientsSheet.addRow({
        'NOMBRE': cliente,
        'FECHA_REGISTRO': now
      });
      // Inicializar sus hojas correspondientes
      await getOrCreateClientUsersSheet(doc, cliente);
      await getOrCreateClientRecordsSheet(doc, cliente);
    }

    await globalUsersSheet.addRow({
      'NOMBRE': nombre,
      'TELEFONO': telefono,
      'USUARIO': usuario,
      'TIPO': tipo,
      'CONTRASEÑA': password,
      'CLIENTE': cliente
    });

    // Guardar también en la hoja específica del cliente (Dual Save)
    if (tipo !== 'super') {
      try {
        const clientUsersSheet = await getOrCreateClientUsersSheet(doc, cliente);
        const clientUsersRows = await clientUsersSheet.getRows();
        if (!clientUsersRows.some(row => normalizeUser(row.get('USUARIO')) === usuario)) {
          await clientUsersSheet.addRow({
            'NOMBRE': nombre,
            'TELEFONO': telefono,
            'USUARIO': usuario,
            'TIPO': tipo,
            'CONTRASEÑA': password,
            'CLIENTE': cliente
          });
        }
      } catch (err) {
        console.warn(`⚠️ Error al guardar en hoja secundaria de "${cliente}":`, err.message);
      }
    }

    const approvedAt = new Date().toLocaleString('es-ES');
    pendingRow.set('ESTADO', 'APROBADO');
    pendingRow.set('APROBADO_EN', approvedAt);
    pendingRow.set('APROBADO_POR', normalizeUser(auth.row.get('USUARIO') || authUser));
    await pendingRow.save();

    // Limpiar cache del listado de pendientes para refresco inmediato
    invalidateApiCacheByPrefix('register-pending|');

    return res.json({ success: true, message: 'Solicitud aprobada y usuario creado' });
  } catch (error) {
    console.error('Error aprobando registro pendiente:', formatErrorForLogging(error));
    return respondGoogleSheetsError(res, error, 'Error aprobando registro pendiente');
  }
});

/**
 * Rechaza una solicitud de registro pendiente (solo superadmin)
 * POST /api/register/reject
 * Headers: x-auth-user, x-auth-password
 * Body: { requestId }
 */
app.post('/api/register/reject', async (req, res) => {
  try {
    const authUser = (req.headers['x-auth-user'] || '').toString().trim();
    const authPassword = (req.headers['x-auth-password'] || '').toString();
    const requestId = (req.body?.requestId || '').toString().trim();

    if (!authUser || !authPassword) {
      return res.status(401).json({ success: false, error: 'Credenciales requeridas' });
    }
    if (!requestId) {
      return res.status(400).json({ success: false, error: 'requestId es requerido' });
    }

    const doc = await getGoogleSheet();
    const auth = await findUserRowByCredentials(doc, authUser, authPassword);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const authTipo = normalizeType(auth.row.get('TIPO'));
    if (authTipo !== 'super') {
      return res.status(403).json({ success: false, error: 'Solo superadmin' });
    }

    const pendingSheet = await getOrCreatePendingUsersSheet(doc);
    const pendingRows = await pendingSheet.getRows();
    const pendingRow = pendingRows.find(row => (row.get('ID') || '').toString().trim() === requestId) || null;
    if (!pendingRow) {
      return res.status(404).json({ success: false, error: 'Solicitud no encontrada' });
    }

    const estado = (pendingRow.get('ESTADO') || '').toString().trim().toUpperCase();
    if (estado !== 'PENDIENTE') {
      return res.status(409).json({ success: false, error: `La solicitud no está pendiente (estado: ${estado || 'N/A'})` });
    }

    const rejectedAt = new Date().toLocaleString('es-ES');
    pendingRow.set('ESTADO', 'RECHAZADO');
    pendingRow.set('RECHAZADO_EN', rejectedAt);
    pendingRow.set('RECHAZADO_POR', normalizeUser(auth.row.get('USUARIO') || authUser));
    await pendingRow.save();

    // Limpiar cache del listado de pendientes para refresco inmediato
    invalidateApiCacheByPrefix('register-pending|');

    return res.json({ success: true, message: 'Solicitud rechazada' });
  } catch (error) {
    console.error('Error rechazando registro pendiente:', formatErrorForLogging(error));
    return respondGoogleSheetsError(res, error, 'Error rechazando registro pendiente');
  }
});

/**
 * Perfil del usuario (no-superadmin)
 * GET /api/profile
 * Headers: x-auth-user, x-auth-password
 */
app.get('/api/profile', async (req, res) => {
  try {
    const authUser = req.headers['x-auth-user'] || '';
    const authPassword = req.headers['x-auth-password'] || '';

    if (!authUser || !authPassword) {
      return res.status(400).json({ success: false, message: 'Credenciales requeridas' });
    }

    const doc = await getGoogleSheet();
    const auth = await findUserRowByCredentials(doc, authUser, authPassword);
    if (!auth) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const tipo = normalizeType(auth.row.get('TIPO'));
    if (tipo === 'super') {
      return res.status(403).json({ success: false, message: 'Superadmin no usa este módulo' });
    }

    const role = tipo === 'administrador'
      ? 'admin'
      : (tipo === 'despacho' ? 'dispatch' : 'user');

    return res.json({
      success: true,
      data: {
        nombre: auth.row.get('NOMBRE') || '',
        telefono: auth.row.get('TELEFONO') || '',
        correo: normalizeUser(auth.row.get('USUARIO')),
        tipo,
        role,
        cliente: auth.row.get('CLIENTE') || ''
      }
    });
  } catch (error) {
    console.error('Error al obtener perfil:', formatErrorForLogging(error));
    res.status(500).json({ success: false, message: 'Error al obtener perfil' });
  }
});

/**
 * Actualiza perfil del usuario (no-superadmin)
 * PUT /api/profile
 * Headers: x-auth-user, x-auth-password
 * Body: { nombre?, correo?, password? }
 */
app.put('/api/profile', async (req, res) => {
  try {
    const authUser = req.headers['x-auth-user'] || '';
    const authPassword = req.headers['x-auth-password'] || '';
    const { nombre, correo, telefono, currentPassword, password } = req.body || {};
    const hasTelefonoField = Object.prototype.hasOwnProperty.call((req.body || {}), 'telefono');

    if (!authUser || !authPassword) {
      return res.status(400).json({ success: false, message: 'Credenciales requeridas' });
    }

    const nextName = normalizeName(nombre);
    const nextEmail = normalizeUser(correo);
    const nextPhone = (telefono || '').toString().trim();
    const nextPassword = (password || '').toString().trim();
    const currentPasswordValue = (currentPassword || '').toString().trim();

    if (!nextName && !nextEmail && !nextPhone && !nextPassword) {
      return res.status(400).json({ success: false, message: 'No hay cambios para guardar' });
    }

    if (nextEmail && !isValidEmail(nextEmail)) {
      return res.status(400).json({ success: false, message: 'El correo debe ser válido' });
    }

    if (hasTelefonoField) {
      const phoneError = validatePhoneMinDigits(nextPhone, 10);
      if (phoneError) {
        return res.status(400).json({ success: false, message: phoneError });
      }
    }

    if (nextPassword) {
      if (!currentPasswordValue) {
        return res.status(400).json({ success: false, message: 'Para cambiar la contraseña, confirma la contraseña actual' });
      }

      if (currentPasswordValue !== authPassword) {
        return res.status(400).json({ success: false, message: 'La contraseña actual no coincide' });
      }

      const passwordError = validateStrongPassword(nextPassword);
      if (passwordError) {
        return res.status(400).json({ success: false, message: passwordError });
      }
    }

    const doc = await getGoogleSheet();
    const auth = await findUserRowByCredentials(doc, authUser, authPassword);
    if (!auth) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const tipo = normalizeType(auth.row.get('TIPO'));
    if (tipo === 'super') {
      return res.status(403).json({ success: false, message: 'Superadmin no usa este módulo' });
    }

    const currentEmail = normalizeUser(auth.row.get('USUARIO'));
    const emailToSet = nextEmail || currentEmail;

    if (emailToSet !== currentEmail) {
      const exists = await userExistsAcrossSheets(doc, emailToSet);
      if (exists) {
        return res.status(409).json({ success: false, message: 'El correo ya está en uso' });
      }
    }

    // Actualizar la fila encontrada
    if (nextName) auth.row.set('NOMBRE', nextName);
    if (nextPhone) auth.row.set('TELEFONO', nextPhone);
    auth.row.set('USUARIO', emailToSet);
    if (nextPassword) auth.row.set('CONTRASEÑA', nextPassword);
    await auth.row.save();

    // Mantener sincronizada la hoja global USUARIOS si también existe
    const globalSheet = await getOrCreateUsersSheet(doc);
    if (auth.sheet.title !== globalSheet.title) {
      const rows = await globalSheet.getRows();
      const globalRow = rows.find(row => normalizeUser(row.get('USUARIO')) === currentEmail);
      if (globalRow) {
        if (nextName) globalRow.set('NOMBRE', nextName);
        if (nextPhone) globalRow.set('TELEFONO', nextPhone);
        globalRow.set('USUARIO', emailToSet);
        if (nextPassword) globalRow.set('CONTRASEÑA', nextPassword);
        // Si cambiamos el correo, preservar el resto de datos
        await globalRow.save();
      }
    }

    return res.json({
      success: true,
      message: 'Perfil actualizado correctamente',
      data: {
        nombre: nextName || auth.row.get('NOMBRE') || '',
        telefono: nextPhone || auth.row.get('TELEFONO') || '',
        correo: emailToSet
      }
    });
  } catch (error) {
    console.error('Error al actualizar perfil:', formatErrorForLogging(error));
    res.status(500).json({ success: false, message: 'Error al actualizar perfil' });
  }
});

/**
 * Lista usuarios (solo superadmin)
 * GET /api/users
 */
app.get('/api/users', async (req, res) => {
  try {
    const doc = await getGoogleSheet();

    const authUser = req.headers['x-auth-user'] || '';
    const authPassword = req.headers['x-auth-password'] || '';
    
    // Validar que el usuario autenticado sea superadmin o administrador
    const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
    if (!authData) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const { tipo: authTipo, cliente: authCliente } = authData;

    // Calcular escaneos por usuario desde la hoja REGISTROS global.
    const countsByUser = Object.create(null);
    
    // OPTIMIZACIÓN: Usar el caché de objetos global para evitar leer Sheets de nuevo
    const startTime = Date.now();
    let records = await getGlobalRecordsObjects(doc);
    
    if (authTipo !== 'super' && authCliente) {
      const normalizedAuthClient = normalizeClientForMatch(authCliente);
      records = records.filter(r => normalizeClientForMatch(r.cliente || '') === normalizedAuthClient);
    }
    
    for (const record of records) {
      accumulateUserScanCountsFromRecordObject(record, countsByUser);
    }

    const allUsers = [];
    const allUserRows = await getCachedAllUsersRows(doc);
    
    if (authTipo === 'super') {
      // Mostrar todos los usuarios únicos del caché
      const uniqueUsers = new Set();
      for (const item of allUserRows) {
        const row = item.row;
        const userValue = normalizeUser(row.get('USUARIO'));
        if (uniqueUsers.has(userValue)) continue;
        uniqueUsers.add(userValue);
        
        allUsers.push({
          usuario: userValue,
          tipo: normalizeType(row.get('TIPO')),
          cliente: row.get('CLIENTE') || '',
          escaneos: countsByUser[userValue] || 0
        });
      }
    } else {
      // Administrador: validar usuarios por columna CLIENTE en hoja global USUARIOS
      const normalizedAuthClient = normalizeClientForMatch(authCliente || '');
      const rows = allUserRows.filter(item => {
        const row = item.row;
        const rowClient = normalizeClientForMatch(row.get('CLIENTE') || '');
        return !!rowClient && rowClient === normalizedAuthClient;
      });
      for (const item of rows) {
        const row = item.row;
        const userValue = normalizeUser(row.get('USUARIO'));
        allUsers.push({
          usuario: userValue,
          tipo: normalizeType(row.get('TIPO')),
          cliente: row.get('CLIENTE') || '',
          escaneos: countsByUser[userValue] || 0
        });
      }
    }

    console.log(`👥 Listar Usuarios | [HIT] | Tiempo: ${Date.now() - startTime}ms | Total: ${allUsers.length}`);
    res.json({ success: true, data: allUsers, _log: { cache: 'HIT', time: `${Date.now() - startTime}ms` } });
  } catch (error) {
    console.error('Error al listar usuarios:', formatErrorForLogging(error));
    res.status(500).json({ success: false, error: 'Error al listar usuarios' });
  }
});

/**
 * Crea o actualiza un usuario (solo superadmin)
 * POST /api/users
 * Body: { usuario, tipo, password, cliente, authUser, authPassword }
 */
app.post('/api/users', async (req, res) => {
  try {
    const { usuario, tipo, password, cliente, authUser, authPassword } = req.body;

    const normalizedUser = normalizeUser(usuario);
    const normalizedType = normalizeType(tipo);
    const normalizedClient = normalizeClient(cliente);

    if (!normalizedUser || !normalizedType || !password) {
      return res.status(400).json({ success: false, message: 'Usuario, tipo y contraseña son requeridos' });
    }

    if (!normalizedClient && normalizedType !== 'super') {
      return res.status(400).json({ success: false, message: 'Cliente es requerido para usuarios no superadmin' });
    }

    if (!['administrador', 'mecanico', 'despacho', 'super'].includes(normalizedType)) {
      return res.status(400).json({ success: false, message: 'Tipo inválido' });
    }

    const doc = await getGoogleSheet();

    // Validar que el usuario autenticado sea superadmin o administrador
    const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
    if (!authData) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const { tipo: authTipo, cliente: authCliente } = authData;

    // Validaciones adicionales para administradores
    if (authTipo === 'administrador') {
      // Admin no puede crear superadmins
      if (normalizedType === 'super') {
        return res.status(403).json({ success: false, message: 'Administrador no puede crear superadmins' });
      }
      // Admin solo puede crear usuarios de su propio cliente
      if (normalizeClientForMatch(normalizedClient) !== normalizeClientForMatch(authCliente)) {
        return res.status(403).json({ success: false, message: 'Solo puede crear usuarios de su cliente' });
      }
    }

    const globalSheet = await getOrCreateUsersSheet(doc);

    // Determinar en qué hoja guardar
    let targetSheet;
    if (normalizedType === 'super') {
      // Superadmins se guardan en hoja global
      targetSheet = globalSheet;
    } else {
      // Crear hojas del cliente si no existen
      await getOrCreateClientUsersSheet(doc, normalizedClient);
      await getOrCreateClientRecordsSheet(doc, normalizedClient);
      targetSheet = await getOrCreateClientUsersSheet(doc, normalizedClient);
    }

    const rows = await targetSheet.getRows();
    const existingRow = rows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);

    if (existingRow) {
      existingRow.set('TIPO', normalizedType);
      existingRow.set('CONTRASEÑA', password);
      existingRow.set('CLIENTE', normalizedClient);
      await existingRow.save();

      return res.json({ success: true, message: 'Usuario actualizado' });
    }

    await targetSheet.addRow({
      'USUARIO': normalizedUser,
      'TIPO': normalizedType,
      'CONTRASEÑA': password,
      'CLIENTE': normalizedClient
    });

    // Guardar tambien en la hoja global USUARIOS para no-superadmins
    if (normalizedType !== 'super') {
      const globalRows = await globalSheet.getRows();
      const globalUserRow = globalRows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);
      if (!globalUserRow) {
        await globalSheet.addRow({
          'USUARIO': normalizedUser,
          'TIPO': normalizedType,
          'CONTRASEÑA': password,
          'CLIENTE': normalizedClient
        });
      }
    }

    res.json({ success: true, message: 'Usuario creado' });
  } catch (error) {
    console.error('Error al crear usuario:', formatErrorForLogging(error));
    res.status(500).json({ success: false, error: 'Error al crear usuario' });
  }
});

  /**
   * Elimina un usuario (solo superadmin)
   * DELETE /api/users/:usuario
   */
  app.delete('/api/users/:usuario', async (req, res) => {
    try {
      const { usuario } = req.params;
      const authUser = req.headers['x-auth-user'];
      const authPassword = req.headers['x-auth-password'];

      const normalizedUser = normalizeUser(usuario);

      if (!normalizedUser) {
        return res.status(400).json({ success: false, message: 'Usuario es requerido' });
      }

      const doc = await getGoogleSheet();

      // Validar que el usuario autenticado sea superadmin o administrador
      const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
      if (!authData) {
        return res.status(401).json({ success: false, message: 'No autorizado' });
      }

      const { tipo: authTipo, cliente: authCliente } = authData;

      const globalSheet = await getOrCreateUsersSheet(doc);

      // Buscar el usuario que se va a eliminar para validar permisos
      let rows = await globalSheet.getRows();
      let userRow = rows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);
      let userCliente = '';
      let userTipo = '';
      
      if (!userRow) {
        // Buscar en hojas de clientes
        await ensureDocInfoLoaded(doc);
        for (const sheet of doc.sheetsByIndex) {
          if (sheet.title.endsWith('_USUARIOS')) {
            rows = await sheet.getRows();
            userRow = rows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);
            if (userRow) {
              userCliente = userRow.get('CLIENTE') || '';
              userTipo = normalizeType(userRow.get('TIPO'));
              break;
            }
          }
        }
      } else {
        userCliente = userRow.get('CLIENTE') || '';
        userTipo = normalizeType(userRow.get('TIPO'));
      }

      if (!userRow) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
      }

      if (authTipo === 'administrador') {
        return res.status(403).json({ success: false, message: 'Administrador no puede eliminar usuarios' });
      }

      // Eliminar el usuario
      await userRow.delete();
      
      // Si el usuario también existe en la hoja global y estamos en una hoja de cliente, eliminarlo también
      if (authTipo === 'super' && userTipo !== 'super') {
        const globalRows = await globalSheet.getRows();
        const globalUserRow = globalRows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);
        if (globalUserRow) {
          await globalUserRow.delete();
        }
      }

      return res.json({ success: true, message: 'Usuario eliminado correctamente' });
    } catch (error) {
      console.error('Error al eliminar usuario:', formatErrorForLogging(error));
      res.status(500).json({ success: false, error: 'Error al eliminar usuario' });
    }
  });

  /**
   * Actualiza un usuario (solo superadmin)
   * PUT /api/users/:usuario
   */
  app.put('/api/users/:usuario', async (req, res) => {
    try {
      const { usuario } = req.params;
      const { tipo, password, cliente, authUser, authPassword } = req.body;

      const normalizedUser = normalizeUser(usuario);
      const normalizedType = normalizeType(tipo);
      const normalizedClient = normalizeClient(cliente);

      if (!normalizedUser || !normalizedType || !password) {
        return res.status(400).json({ success: false, message: 'Usuario, tipo y contraseña son requeridos' });
      }

      if (!normalizedClient && normalizedType !== 'super') {
        return res.status(400).json({ success: false, message: 'Cliente es requerido para usuarios no superadmin' });
      }

      const doc = await getGoogleSheet();

      // Validar que el usuario autenticado sea superadmin o administrador
      const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
      if (!authData) {
        return res.status(401).json({ success: false, message: 'No autorizado' });
      }

      const { tipo: authTipo, cliente: authCliente } = authData;

      // Validaciones adicionales para administradores
      if (authTipo === 'administrador') {
        // Admin no puede editar superadmins
        if (normalizedType === 'super') {
          return res.status(403).json({ success: false, message: 'Administrador no puede crear/editar superadmins' });
        }
        // Admin solo puede editar usuarios de su propio cliente
        if (normalizeClientForMatch(normalizedClient) !== normalizeClientForMatch(authCliente)) {
          return res.status(403).json({ success: false, message: 'Solo puede editar usuarios de su cliente' });
        }
      }

      const globalSheet = await getOrCreateUsersSheet(doc);

      // Buscar usuario en la hoja global
      let rows = await globalSheet.getRows();
      let userRow = rows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);
    
      if (userRow) {
        userRow.set('TIPO', normalizedType);
        userRow.set('CONTRASEÑA', password);
        userRow.set('CLIENTE', normalizedClient);
        await userRow.save();
        return res.json({ success: true, message: 'Usuario actualizado correctamente' });
      }

      // Buscar en hojas de clientes
      await ensureDocInfoLoaded(doc);
      for (const sheet of doc.sheetsByIndex) {
        if (sheet.title.endsWith('_USUARIOS')) {
          rows = await sheet.getRows();
          userRow = rows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);
          if (userRow) {
            userRow.set('TIPO', normalizedType);
            userRow.set('CONTRASEÑA', password);
            userRow.set('CLIENTE', normalizedClient);
            await userRow.save();
            return res.json({ success: true, message: 'Usuario actualizado correctamente' });
          }
        }
      }

      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    } catch (error) {
      console.error('Error al actualizar usuario:', formatErrorForLogging(error));
      res.status(500).json({ success: false, error: 'Error al actualizar usuario' });
    }
  });

// Servir index.html desde la raíz (fallback para SPA)
app.get('/', (req, res) => {
    const indexPath = path.join(publicPath, 'index.html');
    res.sendFile(indexPath);
});

// Configuración de Google Sheets
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

// Aumentamos los tiempos de caché para reducir el consumo de la cuota de Google Sheets API
const SHEETS_DOC_CACHE_TTL_MS = Number.parseInt(process.env.SHEETS_DOC_CACHE_TTL_MS || '60000', 10);
const SHEETS_LOADINFO_TTL_MS = Number.parseInt(process.env.SHEETS_LOADINFO_TTL_MS || '60000', 10);
const SHEETS_HEADER_TTL_MS = Number.parseInt(process.env.SHEETS_HEADER_TTL_MS || '300000', 10);

// Cache corto para agregación superadmin (evita leer N hojas en cada request).
const SUPERADMIN_RECORDS_CACHE_TTL_MS = Number.parseInt(process.env.SUPERADMIN_RECORDS_CACHE_TTL_MS || '30000', 10);
const SUPERADMIN_RECORDS_CACHE_MAX_KEYS = Number.parseInt(process.env.SUPERADMIN_RECORDS_CACHE_MAX_KEYS || '10', 10);

let cachedGoogleDoc = null;
let cachedGoogleDocExpiresAt = 0;
let cachedGoogleDocPromise = null;

const superadminRecordsCache = new Map();
const superadminRecordsInFlight = new Map();

function cleanupSuperadminRecordsCache() {
  const now = Date.now();
  for (const [key, entry] of superadminRecordsCache.entries()) {
    if (!entry || now >= entry.expiresAt) {
      superadminRecordsCache.delete(key);
    }
  }

  if (superadminRecordsCache.size <= SUPERADMIN_RECORDS_CACHE_MAX_KEYS) {
    return;
  }

  const entries = Array.from(superadminRecordsCache.entries())
    .sort((a, b) => (a[1]?.expiresAt || 0) - (b[1]?.expiresAt || 0));
  while (superadminRecordsCache.size > SUPERADMIN_RECORDS_CACHE_MAX_KEYS) {
    const next = entries.shift();
    if (!next) break;
    superadminRecordsCache.delete(next[0]);
  }
}

// Cache corto por endpoint (reduce ráfagas desde la UI).
const API_RESPONSE_CACHE_TTL_MS = Number.parseInt(process.env.API_RESPONSE_CACHE_TTL_MS || '60000', 10);
const API_QUOTA_ERROR_CACHE_TTL_MS = Number.parseInt(process.env.API_QUOTA_ERROR_CACHE_TTL_MS || '60000', 10);
const apiResponseCache = new Map();

function invalidateApiCacheByPrefix(prefix) {
  if (!prefix) return;
  for (const key of apiResponseCache.keys()) {
    if (typeof key === 'string' && key.startsWith(prefix)) {
      apiResponseCache.delete(key);
    }
  }
}

function getFromApiCache(key) {
  if (API_RESPONSE_CACHE_TTL_MS <= 0) return null;
  const entry = apiResponseCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    apiResponseCache.delete(key);
    return null;
  }
  console.log(`⚡ API Cache [HIT]: ${key}`);
  return entry.value;
}

function setToApiCache(key, value, ttlMsOverride = 0) {
  const ttl = Number.isFinite(ttlMsOverride) && ttlMsOverride > 0 ? ttlMsOverride : API_RESPONSE_CACHE_TTL_MS;
  if (ttl <= 0) return;
  console.log(`💾 API Cache [SET]: ${key} (TTL: ${ttl/1000}s)`);
  apiResponseCache.set(key, { expiresAt: Date.now() + ttl, value });
}

// Cache global para filas de usuarios (evita N lecturas en login/perfil)
const USERS_ROWS_CACHE_TTL_MS = 60000;
let usersRowsCache = { expiresAt: 0, value: null };

async function getCachedAllUsersRows(doc) {
  const now = Date.now();
  if (usersRowsCache.value && now < usersRowsCache.expiresAt) {
    return usersRowsCache.value;
  }

  const startTime = Date.now();
  const rows = [];
  const globalSheet = await getOrCreateUsersSheet(doc);
  const globalRows = await withSheetsRetry(() => globalSheet.getRows(), 'USUARIOS.getRows');
  globalRows.forEach(r => rows.push({ sheet: globalSheet, row: r }));

  await ensureDocInfoLoaded(doc);
  for (const sheet of doc.sheetsByIndex) {
    if (!sheet.title.endsWith('_USUARIOS') || sheet.title === USERS_SHEET_TITLE) continue;
    const clientRows = await withSheetsRetry(() => sheet.getRows(), `${sheet.title}.getRows`);
    clientRows.forEach(r => rows.push({ sheet, row: r }));
  }

  usersRowsCache = { expiresAt: now + USERS_ROWS_CACHE_TTL_MS, value: rows };
  console.log(`👥 Users Cache [MISS] | Lectura completa realizada en ${Date.now() - startTime}ms`);
  return rows;
}

// Cache global corto de la hoja REGISTROS (reduce lecturas duplicadas entre endpoints/usuarios)
const RECORDS_ROWS_CACHE_TTL_MS = Number.parseInt(process.env.RECORDS_ROWS_CACHE_TTL_MS || '60000', 10);
let recordsObjectsCache = { expiresAt: 0, value: null };

async function getGlobalRecordsObjects(doc) {
  const now = Date.now();
  if (RECORDS_ROWS_CACHE_TTL_MS > 0 && recordsObjectsCache.value && now < recordsObjectsCache.expiresAt) {
    console.log(`📦 Records Cache [HIT]`);
    return recordsObjectsCache.value;
  }

  const startTime = Date.now();
  const globalSheet = await getOrCreateRecordsSheet(doc);
  const rows = await withSheetsRetry(() => globalSheet.getRows(), 'REGISTROS.getRows');
  const records = rows.map(mapRecordRowToObject);

  if (RECORDS_ROWS_CACHE_TTL_MS > 0) {
    recordsObjectsCache = { expiresAt: now + RECORDS_ROWS_CACHE_TTL_MS, value: records };
  }
  console.log(`📦 Records Cache [MISS] | Lectura de REGISTROS en ${Date.now() - startTime}ms`);
  return records;
}

async function ensureDocInfoLoaded(doc) {
  const now = Date.now();
  const loadedAt = doc?.__gobyInfoLoadedAt || 0;
  if (loadedAt && now - loadedAt < SHEETS_LOADINFO_TTL_MS) {
    return;
  }
  await withSheetsRetry(() => doc.loadInfo(), 'doc.loadInfo');
  doc.__gobyInfoLoadedAt = Date.now();
}

async function ensureSheetHeaderRowLoaded(sheet) {
  if (!sheet) return;
  const now = Date.now();
  const loadedAt = sheet.__gobyHeaderLoadedAt || 0;
  if (loadedAt && sheet.headerValues && sheet.headerValues.length > 0 && (now - loadedAt) < SHEETS_HEADER_TTL_MS) {
    return;
  }
  await withSheetsRetry(() => sheet.loadHeaderRow(), `sheet.loadHeaderRow:${sheet.title || 'unknown'}`);
  sheet.__gobyHeaderLoadedAt = Date.now();
}

const RECORDS_SHEET_TITLE = 'REGISTROS';
const USERS_SHEET_TITLE = 'USUARIOS';
const PENDING_USERS_SHEET_TITLE = 'USUARIOS_PENDIENTES';
const REWARDS_SHEET_TITLE = 'RECOMPENSAS';
const REWARDS_HISTORY_SHEET_TITLE = 'RECOMPENSAS_HISTORIAL';
const ALERTS_SHEET_TITLE = 'ALERTAS';
const CONTACT_REQUESTS_SHEET_TITLE = 'SOLICITUDES';
const SUPERADMIN_1_EMAIL = process.env.SUPERADMIN_1_EMAIL || '';
const SUPERADMIN_2_EMAIL = process.env.SUPERADMIN_2_EMAIL || '';

function generateRegistrationRequestId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function getSuperadminRecipientEmailsFromUsersRows(rows) {
  const recipients = new Set();
  for (const row of rows || []) {
    const tipo = normalizeType(row.get('TIPO'));
    if (tipo !== 'super') continue;
    const email = normalizeUser(row.get('USUARIO'));
    if (email) recipients.add(email);
  }

  [SUPERADMIN_1_EMAIL, SUPERADMIN_2_EMAIL]
    .map(normalizeUser)
    .filter(Boolean)
    .forEach(email => recipients.add(email));

  return Array.from(recipients);
}

async function createPendingRegistrationAlerts(doc, { requestId, nombre, email, telefono, cliente, isNewClient }) {
  const alertsSheet = await getOrCreateAlertsSheet(doc);
  const allUserRows = await getAllUsersRows(doc);
  const recipients = getSuperadminRecipientEmailsFromUsersRows(allUserRows);

  if (recipients.length === 0) {
    return { created: 0 };
  }
  const now = new Date().toLocaleString('es-ES');
  const message = `Nueva solicitud de registro: ${email}${cliente ? ` (Cliente: ${cliente})` : ''}${isNewClient ? ' - ¡LA EMPRESA NO EXISTE Y REQUIERE VALIDACIÓN!' : ''}.`;
  const detail = JSON.stringify({ requestId, nombre, email, telefono, cliente });

  let created = 0;
  for (const recipientEmail of recipients) {
    await alertsSheet.addRow({
      'ID': generateAlertId(),
      'DESTINATARIO': recipientEmail,
      'DESTINATARIO_TIPO': 'super',
      'CLIENTE': cliente || '',
      'EVENTO': 'REGISTRO_PENDIENTE',
      'MENSAJE': message,
      'DETALLE': detail,
      'FECHA': now,
      'LEIDO': 'NO',
      'LEIDO_EN': ''
    });
    created += 1;
  }

  return { created };
}

async function sendRegistrationConfirmationToUser({ nombre, email, cliente, requestId }) {
  const { from } = getSmtpConfig();
  const safeName = (nombre || '').toString().trim() || 'Usuario';

  const subject = 'Solicitud de registro recibida - GOBY FILTERS QR';
  const text = [
    `Hola ${safeName},`,
    '',
    'Recibimos tu solicitud de registro en GOBY FILTERS QR.',
    'Un administrador la revisará y recibirás acceso una vez sea aprobada.',
    '',
    `Empresa: ${cliente}`,
    `ID de solicitud: ${requestId}`,
    '',
    'Si tienes dudas, contáctate con tu administrador.'
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; max-width: 520px;">
      <p>Hola <strong>${escapeHtml(safeName)}</strong>,</p>
      <p>Recibimos tu solicitud de registro en <strong>GOBY FILTERS QR</strong>.</p>
      <p>Un administrador la revisará y recibirás acceso una vez sea aprobada.</p>
      <table style="border-collapse: collapse; background: #f5f5f5; border-radius: 6px; padding: 16px; width: 100%; margin: 16px 0;">
        <tr>
          <td style="padding: 8px 12px; font-weight: bold; white-space: nowrap;">Empresa:</td>
          <td style="padding: 8px 12px;">${escapeHtml(cliente)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; font-weight: bold; white-space: nowrap;">ID de solicitud:</td>
          <td style="padding: 8px 12px; font-family: monospace;">${escapeHtml(requestId)}</td>
        </tr>
      </table>
      <p style="color: #555; font-size: 0.9em;">Si tienes dudas, contáctate con tu administrador.</p>
    </div>
  `;

  await sendEmail({ from, to: email, subject, html, text });
}

async function sendPendingRegistrationEmailToSuperadmins({ requestId, nombre, email, telefono, cliente, isNewClient }) {
  const recipients = [SUPERADMIN_1_EMAIL, SUPERADMIN_2_EMAIL]
    .map(normalizeUser)
    .filter(Boolean);

  if (recipients.length === 0) return { sent: 0 };

  try {
    const { from } = getSmtpConfig();

    const subject = `Solicitud de registro pendiente${isNewClient ? ' (NUEVA EMPRESA)' : ''} (GOBY FILTERS QR)`;
    const now = new Date();

    const text = [
      `Hay una nueva solicitud de registro pendiente de aprobación.${isNewClient ? ' ¡ADVERTENCIA: La empresa ingresada no existe en la base de clientes y requiere validación!' : ''}`,
      `Hay una nueva solicitud de registro pendiente de aprobación.${isNewClient ? ' ¡LA EMPRESA ES NUEVA!' : ''}`,
      '',
      `ID: ${requestId}`,
      `Nombre: ${nombre || ''}`,
      `Correo: ${email}`,
      `Teléfono: ${telefono || ''}`,
      `Cliente: ${cliente || ''}${isNewClient ? ' (NUEVA)' : ''}`,
      `Fecha: ${now.toLocaleString('es-CO')}`,
      '',
      'Ingresa a la app como superadmin y aprueba la solicitud en Gestión de Usuarios.'
    ].join('\n');

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.45;">
        <p>Hay una nueva solicitud de registro pendiente de aprobación.${isNewClient ? ' <strong style="color: #d32f2f;">¡ADVERTENCIA: La empresa ingresada no existe en la base de clientes y requiere validación!</strong>' : ''}</p>
        <p>Hay una nueva solicitud de registro pendiente de aprobación.${isNewClient ? ' <strong style="color: #d32f2f;">¡LA EMPRESA ES NUEVA!</strong>' : ''}</p>
        <hr/>
        <p style="margin:0;"><strong>ID:</strong> ${escapeHtml(requestId)}</p>
        <p style="margin:0;"><strong>Nombre:</strong> ${escapeHtml(nombre || '')}</p>
        <p style="margin:0;"><strong>Correo:</strong> ${escapeHtml(email)}</p>
        <p style="margin:0;"><strong>Teléfono:</strong> ${escapeHtml(telefono || '')}</p>
        <p style="margin:0;"><strong>Cliente:</strong> ${escapeHtml(cliente || '')} ${isNewClient ? '<span style="background-color: #ffc107; padding: 2px 5px; border-radius: 3px; font-size: 0.8em; font-weight: bold;">NUEVA</span>' : ''}</p>
        <p style="margin:0;"><strong>Fecha:</strong> ${escapeHtml(now.toLocaleString('es-CO'))}</p>
        <hr/>
        <p>Ingresa a la app como <strong>superadmin</strong> y aprueba la solicitud en <strong>Gestión de Usuarios</strong>.</p>
      </div>
    `;

    await sendEmail({ from, to: recipients, subject, html, text });

    return { sent: recipients.length };
  } catch (error) {
    // No bloquear el registro si el correo falla.
    console.warn('⚠️ No se pudo enviar correo a superadmins por solicitud de registro:', formatErrorForLogging(error));
    return { sent: 0, error: error?.message || String(error) };
  }
}

function formatDateTimeForSheet(date) {
  const value = date instanceof Date ? date : new Date();
  const formatter = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(value);
  const map = Object.create(null);
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  return {
    date: `${map.year || ''}-${map.month || ''}-${map.day || ''}`,
    time: `${map.hour || ''}:${map.minute || ''}:${map.second || ''}`
  };
}

// -- Cache de token OAuth2 nativo --
let _nativeTokenCache = null;
let _nativeTokenCacheExpiresAt = 0;

/**
 * Obtiene un access token de Google usando https.request() nativo de Node.js.
 * Bypassa completamente node-fetch/gaxios que causan ERR_STREAM_PREMATURE_CLOSE
 * en Render free tier.
 */
async function getAccessTokenNative() {
  if (_nativeTokenCache && Date.now() < _nativeTokenCacheExpiresAt) {
    return _nativeTokenCache;
  }

  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const rawKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email,
    scope: SCOPES.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const signable = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signable);
  signer.end();
  const sig = signer.sign(rawKey).toString('base64url');
  const jwtStr = `${signable}.${sig}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwtStr,
  }).toString();

  const token = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.access_token) {
              resolve({ access_token: parsed.access_token, expires_in: parsed.expires_in || 3600 });
            } else {
              reject(new Error(`Google OAuth2 error (${res.statusCode}): ${JSON.stringify(parsed)}`));
            }
          } catch (e) {
            reject(new Error(`OAuth2 respuesta no parseable: ${data.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error('OAuth2 token request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  _nativeTokenCache = token;
  _nativeTokenCacheExpiresAt = Date.now() + (token.expires_in - 120) * 1000;
  return token;
}

/**
 * Inicializa y autentica la conexión con Google Sheets
 * @returns {GoogleSpreadsheet} Documento de Google Sheets autenticado
 */
async function getGoogleSheet() {
  // Validar variables de entorno antes de intentar cualquier conexión
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_SPREADSHEET_ID) {
    throw new Error('Variables de entorno de Google Sheets no configuradas');
  }

  const now = Date.now();
  if (cachedGoogleDoc && now < cachedGoogleDocExpiresAt) {
    return cachedGoogleDoc;
  }
  if (cachedGoogleDocPromise) {
    return await cachedGoogleDocPromise;
  }

  cachedGoogleDocPromise = withSheetsRetry(async () => {
    // Token via https.request() nativo — bypassa node-fetch/gaxios que falla en Render
    const { access_token, expires_in } = await getAccessTokenNative();

    const auth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: SCOPES,
    });

    // Pre-poblar credenciales para que JWT no llame a gaxios/node-fetch
    auth.credentials = {
      access_token,
      token_type: 'Bearer',
      expiry_date: Date.now() + (expires_in - 60) * 1000,
    };

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
    await ensureDocInfoLoaded(doc);
    cachedGoogleDoc = doc;
    cachedGoogleDocExpiresAt = Date.now() + Math.max(0, SHEETS_DOC_CACHE_TTL_MS);
    return doc;
  }, 'getGoogleSheet').catch(error => {
    console.error('Error al conectar con Google Sheets:', formatErrorForLogging(error));
    throw error;
  });

  try {
    return await cachedGoogleDocPromise;
  } finally {
    cachedGoogleDocPromise = null;
  }
}

/**
 * Inicializa la hoja de cálculo con encabezados si no existen
 * @param {Object} sheet - Hoja de Google Sheets
 */
async function initializeRecordsSheet(sheet) {
  await ensureSheetHeaderRowLoaded(sheet);
  
  const requiredHeaders = [
    'ID',
    'REFERENCIA',
    'SERIAL',
    'ESTADO',
    'CLIENTE',
    'USUARIO_DESPACHO',
    'USUARIO_PLANTA',
    'USUARIO_INSTALACION',
    'USUARIO_DESINSTALACION',
    'PLACA',
    'KILOMETRAJE_INSTALACION',
    'KILOMETRAJE_DESINSTALACION',
    'FECHA_ALMACEN',
    'FECHA_DESPACHO',
    'FECHA_INSTALACION',
    'FECHA_DESINSTALACION',
    'HORA_ALMACEN',
    'HORA_DESPACHO',
    'HORA_INSTALACION',
    'HORA_DESINSTALACION',
    'NOMBRE_INSTALADOR'
  ];
  
  // Si no hay encabezados, crearlos
  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow(requiredHeaders);
  } else {
    // Verificar si falta alguna columna requerida y agregarla
    const missingHeaders = requiredHeaders.filter(header => !sheet.headerValues.includes(header));
    
    if (missingHeaders.length > 0) {
      console.log(`⚠️ Agregando columnas faltantes a hoja ${sheet.title}:`, missingHeaders);
      const newHeaders = [...sheet.headerValues, ...missingHeaders];
      await sheet.setHeaderRow(newHeaders);
      sheet.__gobyHeaderLoadedAt = 0;
      await ensureSheetHeaderRowLoaded(sheet); // Recargar headers
    }
  }
}

/**
 * Inicializa la hoja de usuarios con encabezados si no existen
 * @param {Object} sheet - Hoja de Google Sheets
 */
async function initializeUsersSheet(sheet) {
  await ensureSheetHeaderRowLoaded(sheet);

  const requiredHeaders = [
    'NOMBRE',
    'TELEFONO',
    'USUARIO',
    'TIPO',
    'CONTRASEÑA',
    'CLIENTE'
  ];

  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow(requiredHeaders);
    return;
  }

  const missingHeaders = requiredHeaders.filter(header => !sheet.headerValues.includes(header));
  if (missingHeaders.length > 0) {
    await sheet.setHeaderRow([...sheet.headerValues, ...missingHeaders]);
    sheet.__gobyHeaderLoadedAt = 0;
    await ensureSheetHeaderRowLoaded(sheet);
  }
}

async function initializePendingUsersSheet(sheet) {
  await ensureSheetHeaderRowLoaded(sheet);

  const requiredHeaders = [
    'ID',
    'NOMBRE',
    'TELEFONO',
    'USUARIO',
    'CONTRASEÑA',
    'CLIENTE',
    'TIPO',
    'ESTADO',
    'CLIENTE_NUEVO',
    'CREADO_EN',
    'APROBADO_EN',
    'APROBADO_POR',
    'RECHAZADO_EN',
    'RECHAZADO_POR'
  ];

  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow(requiredHeaders);
    return;
  }

  const missingHeaders = requiredHeaders.filter(header => !sheet.headerValues.includes(header));
  if (missingHeaders.length > 0) {
    await sheet.setHeaderRow([...sheet.headerValues, ...missingHeaders]);
    sheet.__gobyHeaderLoadedAt = 0;
    await ensureSheetHeaderRowLoaded(sheet);
  }
}

async function initializeContactRequestsSheet(sheet) {
  await ensureSheetHeaderRowLoaded(sheet);

  const requiredHeaders = [
    'FECHA',
    'HORA',
    'SOLICITUD',
    'NOMBRE',
    'EMAIL',
    'TELEFONO',
    'USUARIO_APP',
    'CLIENTE_APP',
    'ROL_APP',
    'IP',
    'USER_AGENT',
    'TIMESTAMP_ISO'
  ];

  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow(requiredHeaders);
    return;
  }

  const missingHeaders = requiredHeaders.filter(header => !sheet.headerValues.includes(header));
  if (missingHeaders.length > 0) {
    await sheet.setHeaderRow([...sheet.headerValues, ...missingHeaders]);
    sheet.__gobyHeaderLoadedAt = 0;
    await ensureSheetHeaderRowLoaded(sheet);
  }
}

async function getOrCreateContactRequestsSheet(doc) {
  let sheet = doc.sheetsByTitle[CONTACT_REQUESTS_SHEET_TITLE];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: CONTACT_REQUESTS_SHEET_TITLE,
      headerValues: [
        'FECHA',
        'HORA',
        'SOLICITUD',
        'NOMBRE',
        'EMAIL',
        'TELEFONO',
        'USUARIO_APP',
        'CLIENTE_APP',
        'ROL_APP',
        'IP',
        'USER_AGENT',
        'TIMESTAMP_ISO'
      ]
    });
  }

  await initializeContactRequestsSheet(sheet);
  return sheet;
}

/**
 * Obtiene o crea la hoja de registros
 * @param {GoogleSpreadsheet} doc
 */
async function getOrCreateRecordsSheet(doc) {
  let sheet = doc.sheetsByTitle[RECORDS_SHEET_TITLE];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: RECORDS_SHEET_TITLE,
      headerValues: [
        'ID',
        'REFERENCIA',
        'SERIAL',
        'ESTADO',
        'CLIENTE',
        'USUARIO_DESPACHO',
        'USUARIO_PLANTA',
        'USUARIO_INSTALACION',
        'USUARIO_DESINSTALACION',
        'FECHA_ALMACEN',
        'FECHA_DESPACHO',
        'FECHA_INSTALACION',
        'FECHA_DESINSTALACION',
        'HORA_ALMACEN',
        'HORA_DESPACHO',
        'HORA_INSTALACION',
        'HORA_DESINSTALACION',
        'NOMBRE_INSTALADOR'
      ]
    });
  }

  await initializeRecordsSheet(sheet);
  return sheet;
}

/**
 * Obtiene o crea la hoja de clientes
 * @param {GoogleSpreadsheet} doc
 */
async function getOrCreateClientsSheet(doc) {
  const CLIENTS_SHEET_TITLE = 'CLIENTES';
  let sheet = doc.sheetsByTitle[CLIENTS_SHEET_TITLE];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: CLIENTS_SHEET_TITLE,
      headerValues: [
        'NOMBRE',
        'FECHA_REGISTRO'
      ]
    });
    console.log('✅ Creada hoja CLIENTES');
  }

  await ensureSheetHeaderRowLoaded(sheet);
  return sheet;
}

/**
 * Obtiene o crea la hoja de usuarios
 * @param {GoogleSpreadsheet} doc
 */
async function getOrCreateUsersSheet(doc) {
  let sheet = doc.sheetsByTitle[USERS_SHEET_TITLE];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: USERS_SHEET_TITLE,
      headerValues: [
        'NOMBRE',
        'TELEFONO',
        'USUARIO',
        'TIPO',
        'CONTRASEÑA',
        'CLIENTE'
      ]
    });
  }

  await initializeUsersSheet(sheet);
  return sheet;
}

async function getOrCreatePendingUsersSheet(doc) {
  let sheet = doc.sheetsByTitle[PENDING_USERS_SHEET_TITLE];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: PENDING_USERS_SHEET_TITLE,
      headerValues: [
        'ID',
        'NOMBRE',
        'TELEFONO',
        'USUARIO',
        'CONTRASEÑA',
        'CLIENTE',
        'TIPO',
        'ESTADO',
        'CREADO_EN',
        'APROBADO_EN',
        'APROBADO_POR',
        'RECHAZADO_EN',
        'RECHAZADO_POR'
      ]
    });
  }

  await initializePendingUsersSheet(sheet);
  return sheet;
}

async function initializeRewardsSheet(sheet) {
  await ensureSheetHeaderRowLoaded(sheet);

  const requiredHeaders = [
    'IDENTIFICADOR',
    'NOMBRE',
    'PUNTOS',
    'INSTALACIONES',
    'DESINSTALACIONES',
    'REDENCIONES',
    'ACTUALIZADO_EN'
  ];

  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow(requiredHeaders);
    return;
  }

  const missingHeaders = requiredHeaders.filter(header => !sheet.headerValues.includes(header));
  if (missingHeaders.length > 0) {
    await sheet.setHeaderRow([...sheet.headerValues, ...missingHeaders]);
    sheet.__gobyHeaderLoadedAt = 0;
    await ensureSheetHeaderRowLoaded(sheet);
  }
}

async function initializeRewardsHistorySheet(sheet) {
  await ensureSheetHeaderRowLoaded(sheet);

  const requiredHeaders = [
    'IDENTIFICADOR',
    'MOVIMIENTO',
    'PUNTOS',
    'REFERENCIA',
    'SERIAL',
    'DESCRIPCION',
    'FECHA',

    // Datos de entrega (solo aplica para canjes)
    'ENTREGA_NOMBRE',
    'ENTREGA_TELEFONO',
    'ENTREGA_DIRECCION',
    'ENTREGA_CIUDAD',
    'ENTREGA_NOTAS'
  ];

  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow(requiredHeaders);
    return;
  }

  const missingHeaders = requiredHeaders.filter(header => !sheet.headerValues.includes(header));
  if (missingHeaders.length > 0) {
    await sheet.setHeaderRow([...sheet.headerValues, ...missingHeaders]);
    sheet.__gobyHeaderLoadedAt = 0;
    await ensureSheetHeaderRowLoaded(sheet);
  }
}

async function initializeAlertsSheet(sheet) {
  await ensureSheetHeaderRowLoaded(sheet);

  const requiredHeaders = [
    'ID',
    'DESTINATARIO',
    'DESTINATARIO_TIPO',
    'CLIENTE',
    'EVENTO',
    'MENSAJE',
    'DETALLE',
    'FECHA',
    'LEIDO',
    'LEIDO_EN'
  ];

  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow(requiredHeaders);
    return;
  }

  const missingHeaders = requiredHeaders.filter(header => !sheet.headerValues.includes(header));
  if (missingHeaders.length > 0) {
    await sheet.setHeaderRow([...sheet.headerValues, ...missingHeaders]);
    sheet.__gobyHeaderLoadedAt = 0;
    await ensureSheetHeaderRowLoaded(sheet);
  }
}

async function getOrCreateRewardsSheet(doc) {
  let sheet = doc.sheetsByTitle[REWARDS_SHEET_TITLE];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: REWARDS_SHEET_TITLE,
      headerValues: [
        'IDENTIFICADOR',
        'NOMBRE',
        'PUNTOS',
        'INSTALACIONES',
        'DESINSTALACIONES',
        'REDENCIONES',
        'ACTUALIZADO_EN'
      ]
    });
  }

  await initializeRewardsSheet(sheet);
  return sheet;
}

async function getOrCreateRewardsHistorySheet(doc) {
  let sheet = doc.sheetsByTitle[REWARDS_HISTORY_SHEET_TITLE];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: REWARDS_HISTORY_SHEET_TITLE,
      headerValues: [
        'IDENTIFICADOR',
        'MOVIMIENTO',
        'PUNTOS',
        'REFERENCIA',
        'SERIAL',
        'DESCRIPCION',
        'FECHA',
        'ENTREGA_NOMBRE',
        'ENTREGA_TELEFONO',
        'ENTREGA_DIRECCION',
        'ENTREGA_CIUDAD',
        'ENTREGA_NOTAS'
      ]
    });
  }

  await initializeRewardsHistorySheet(sheet);
  return sheet;
}

async function getOrCreateAlertsSheet(doc) {
  let sheet = doc.sheetsByTitle[ALERTS_SHEET_TITLE];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: ALERTS_SHEET_TITLE,
      headerValues: [
        'ID',
        'DESTINATARIO',
        'DESTINATARIO_TIPO',
        'CLIENTE',
        'EVENTO',
        'MENSAJE',
        'DETALLE',
        'FECHA',
        'LEIDO',
        'LEIDO_EN'
      ]
    });
  }

  await initializeAlertsSheet(sheet);
  return sheet;
}

function normalizeRewardIdentifier(identifier) {
  return (identifier || '').trim().toLowerCase();
}

function generateAlertId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

async function getAllUsersRows(doc) {
  const rows = [];
  const globalSheet = await getOrCreateUsersSheet(doc);
  rows.push(...(await globalSheet.getRows()));

  await ensureDocInfoLoaded(doc);
  for (const sheet of doc.sheetsByIndex) {
    if (!sheet.title.endsWith('_USUARIOS')) continue;
    try {
      rows.push(...(await sheet.getRows()));
    } catch (error) {
      console.warn(`⚠️ No se pudo leer hoja ${sheet.title}:`, error.message);
    }
  }

  return rows;
}

async function createRewardRedemptionAlerts(doc, { identifier, rewardName, points }) {
  const alertsSheet = await getOrCreateAlertsSheet(doc);
  const allUserRows = await getAllUsersRows(doc);

  const normalizedIdentifier = normalizeUser(identifier);
  const redeemerRow = allUserRows.find(row => normalizeUser(row.get('USUARIO')) === normalizedIdentifier) || null;
  const client = redeemerRow ? (redeemerRow.get('CLIENTE') || '') : '';
  const clientKey = normalizeClientForMatch(client);

  const recipients = new Map();

  // Admins del mismo cliente
  if (clientKey) {
    for (const row of allUserRows) {
      const tipo = normalizeType(row.get('TIPO'));
      if (tipo !== 'administrador') continue;
      if (normalizeClientForMatch(row.get('CLIENTE') || '') !== clientKey) continue;
      const email = normalizeUser(row.get('USUARIO'));
      if (email) {
        recipients.set(email, 'administrador');
      }
    }
  }

  // Superadmins
  for (const row of allUserRows) {
    const tipo = normalizeType(row.get('TIPO'));
    if (tipo !== 'super') continue;
    const email = normalizeUser(row.get('USUARIO'));
    if (email) {
      recipients.set(email, 'super');
    }
  }

  // Fallback por variables de entorno
  [SUPERADMIN_1_EMAIL, SUPERADMIN_2_EMAIL]
    .map(normalizeUser)
    .filter(Boolean)
    .forEach(email => recipients.set(email, 'super'));

  if (recipients.size === 0) {
    return { created: 0 };
  }

  const now = new Date().toLocaleString('es-ES');
  const safeRewardName = (rewardName || '').toString().trim();
  const parsedPoints = Number.isFinite(points) ? points : parseInt(points, 10) || 0;

  const message = `${identifier} canjeó "${safeRewardName}" por ${parsedPoints} puntos${client ? ` (Cliente: ${client})` : ''}.`;
  const detail = JSON.stringify({
    identifier: normalizedIdentifier,
    rewardName: safeRewardName,
    points: parsedPoints,
    client: client || ''
  });

  let created = 0;
  for (const [email, tipo] of recipients.entries()) {
    await alertsSheet.addRow({
      'ID': generateAlertId(),
      'DESTINATARIO': email,
      'DESTINATARIO_TIPO': tipo,
      'CLIENTE': client || '',
      'EVENTO': 'CANJE_PREMIO',
      'MENSAJE': message,
      'DETALLE': detail,
      'FECHA': now,
      'LEIDO': 'NO',
      'LEIDO_EN': ''
    });
    created += 1;
  }

  return { created };
}

async function getRewardBalanceRow(rewardsSheet, identifier) {
  const normalizedIdentifier = normalizeRewardIdentifier(identifier);
  if (!normalizedIdentifier) {
    return null;
  }

  const rows = await rewardsSheet.getRows();
  return rows.find(row => normalizeRewardIdentifier(row.get('IDENTIFICADOR')) === normalizedIdentifier) || null;
}

async function creditRewardPoints(doc, identifier, displayName, points, metadata = {}) {
  const normalizedIdentifier = normalizeRewardIdentifier(identifier);
  if (!normalizedIdentifier || !Number.isFinite(points) || points <= 0) {
    return null;
  }

  const rewardsSheet = await getOrCreateRewardsSheet(doc);
  const historySheet = await getOrCreateRewardsHistorySheet(doc);
  const now = new Date().toLocaleString('es-ES');

  const rewardRow = await getRewardBalanceRow(rewardsSheet, normalizedIdentifier);
  const movementType = metadata.movementType === 'uninstallation' ? 'uninstallation' : 'installation';
  const currentPoints = rewardRow ? parseInt(rewardRow.get('PUNTOS') || '0', 10) || 0 : 0;
  const currentInstallations = rewardRow ? parseInt(rewardRow.get('INSTALACIONES') || '0', 10) || 0 : 0;
  const currentUninstallations = rewardRow ? parseInt(rewardRow.get('DESINSTALACIONES') || '0', 10) || 0 : 0;
  const currentRedemptions = rewardRow ? parseInt(rewardRow.get('REDENCIONES') || '0', 10) || 0 : 0;
  const nextPoints = currentPoints + points;
  const nextInstallations = movementType === 'installation'
    ? currentInstallations + points
    : currentInstallations;
  const nextUninstallations = movementType === 'uninstallation'
    ? currentUninstallations + points
    : currentUninstallations;

  if (rewardRow) {
    rewardRow.set('NOMBRE', displayName || rewardRow.get('NOMBRE') || identifier);
    rewardRow.set('PUNTOS', nextPoints);
    rewardRow.set('INSTALACIONES', nextInstallations);
    rewardRow.set('DESINSTALACIONES', nextUninstallations);
    rewardRow.set('REDENCIONES', currentRedemptions);
    rewardRow.set('ACTUALIZADO_EN', now);
    await rewardRow.save();
  } else {
    await rewardsSheet.addRow({
      'IDENTIFICADOR': normalizedIdentifier,
      'NOMBRE': displayName || identifier,
      'PUNTOS': nextPoints,
      'INSTALACIONES': nextInstallations,
      'DESINSTALACIONES': nextUninstallations,
      'REDENCIONES': 0,
      'ACTUALIZADO_EN': now
    });
  }

  await historySheet.addRow({
    'IDENTIFICADOR': normalizedIdentifier,
    'MOVIMIENTO': movementType === 'uninstallation' ? 'GANADO_DESINSTALACION' : 'GANADO_INSTALACION',
    'PUNTOS': points,
    'REFERENCIA': metadata.referencia || '',
    'SERIAL': metadata.serial || '',
    'DESCRIPCION': metadata.descripcion || 'Punto por instalación completada',
    'FECHA': now
  });

  return {
    identifier: normalizedIdentifier,
    nombre: displayName || identifier,
    puntos: nextPoints,
    instalaciones: nextInstallations,
    desinstalaciones: nextUninstallations,
    redenciones: currentRedemptions,
    actualizadoEn: now
  };
}

async function redeemRewardPoints(doc, identifier, displayName, points, metadata = {}) {
  const normalizedIdentifier = normalizeRewardIdentifier(identifier);
  if (!normalizedIdentifier || !Number.isFinite(points) || points <= 0) {
    return { success: false, message: 'Datos inválidos para redención' };
  }

  const rewardsSheet = await getOrCreateRewardsSheet(doc);
  const historySheet = await getOrCreateRewardsHistorySheet(doc);
  const rewardRow = await getRewardBalanceRow(rewardsSheet, normalizedIdentifier);

  if (!rewardRow) {
    return { success: false, message: 'El usuario no tiene puntos registrados' };
  }

  const currentPoints = parseInt(rewardRow.get('PUNTOS') || '0', 10) || 0;
  const currentRedemptions = parseInt(rewardRow.get('REDENCIONES') || '0', 10) || 0;

  if (currentPoints < points) {
    return { success: false, message: 'Puntos insuficientes para redimir' };
  }

  const now = new Date().toLocaleString('es-ES');
  const nextPoints = currentPoints - points;

  rewardRow.set('NOMBRE', displayName || rewardRow.get('NOMBRE') || identifier);
  rewardRow.set('PUNTOS', nextPoints);
  rewardRow.set('REDENCIONES', currentRedemptions + points);
  rewardRow.set('ACTUALIZADO_EN', now);
  await rewardRow.save();

  await historySheet.addRow({
    'IDENTIFICADOR': normalizedIdentifier,
    'MOVIMIENTO': 'REDIMIDO',
    'PUNTOS': points,
    'REFERENCIA': metadata.referencia || '',
    'SERIAL': metadata.serial || '',
    'DESCRIPCION': metadata.descripcion || 'Canje de premio',
    'FECHA': now,
    'ENTREGA_NOMBRE': metadata.entregaNombre || '',
    'ENTREGA_TELEFONO': metadata.entregaTelefono || '',
    'ENTREGA_DIRECCION': metadata.entregaDireccion || '',
    'ENTREGA_CIUDAD': metadata.entregaCiudad || '',
    'ENTREGA_NOTAS': metadata.entregaNotas || ''
  });

  return {
    success: true,
    reward: {
      identifier: normalizedIdentifier,
      nombre: displayName || rewardRow.get('NOMBRE') || identifier,
      puntos: nextPoints,
      instalaciones: parseInt(rewardRow.get('INSTALACIONES') || '0', 10) || 0,
      desinstalaciones: parseInt(rewardRow.get('DESINSTALACIONES') || '0', 10) || 0,
      redenciones: currentRedemptions + points,
      actualizadoEn: now
    }
  };
}

function normalizeUser(user) {
  return (user || '').trim().toLowerCase();
}

function normalizeType(type) {
  return (type || '').trim().toLowerCase();
}

function normalizeClient(client) {
  return (client || '').trim().toUpperCase();
}

function normalizeClientForMatch(client) {
  return (client || '')
    .toString()
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeSheetTitleKey(title) {
  return (title || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
}

function findSheetByTitleCandidates(doc, titles) {
  const candidates = (titles || []).filter(Boolean);
  for (const title of candidates) {
    if (doc.sheetsByTitle[title]) {
      return doc.sheetsByTitle[title];
    }
  }

  const candidateKeys = new Set(candidates.map(normalizeSheetTitleKey));
  for (const sheet of doc.sheetsByIndex) {
    if (candidateKeys.has(normalizeSheetTitleKey(sheet.title))) {
      return sheet;
    }
  }

  return null;
}

function isSuperadminUser(usuario) {
  const normalizedUser = normalizeUser(usuario);
  return normalizedUser === normalizeUser(SUPERADMIN_1_EMAIL) ||
         normalizedUser === normalizeUser(SUPERADMIN_2_EMAIL);
}

function isSuperadminRow(row) {
  return normalizeType(row.get('TIPO')) === 'super';
}

function isUserInRecord(row, userEmail) {
  const normalizedUser = normalizeUser(userEmail);
  if (!normalizedUser) {
    return false;
  }

  return [
    row.get('USUARIO_DESPACHO'),
    row.get('USUARIO_PLANTA'),
    row.get('USUARIO_INSTALACION'),
    row.get('USUARIO_DESINSTALACION')
  ].some(value => normalizeUser(value) === normalizedUser);
}

function parseRecordStageDateTime(dateValue, timeValue) {
  const dateText = (dateValue || '').toString().trim();
  if (!dateText) return null;

  let date = null;
  // Soportar yyyy-mm-dd y dd/mm/yyyy
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    const parsed = new Date(`${dateText}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      date = parsed;
    }
  } else {
    date = parseSpanishDate(dateText);
  }

  if (!date) return null;

  const timeText = (timeValue || '').toString().trim();
  if (timeText) {
    const parts = timeText.split(':').map(v => parseInt(v, 10));
    const [hh, mm, ss] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
    date.setHours(hh, mm, ss, 0);
  }

  return date;
}

function recordLatestEventTimestampMs(record) {
  const stages = [
    { d: 'fechaDesinstalacion', t: 'horaDesinstalacion' },
    { d: 'fechaInstalacion', t: 'horaInstalacion' },
    { d: 'fechaDespacho', t: 'horaDespacho' },
    { d: 'fechaAlmacen', t: 'horaAlmacen' }
  ];

  for (const stage of stages) {
    const date = parseRecordStageDateTime(record?.[stage.d], record?.[stage.t]);
    if (date) return date.getTime();
  }

  return 0;
}

function recordDedupKey(record) {
  const ref = (record?.referencia || '').toString().trim();
  const serial = (record?.serial || '').toString().trim();
  return `${ref}|${serial}`;
}

function mapRecordRowToObject(row) {
  return {
    id: row.get('ID'),
    referencia: row.get('REFERENCIA'),
    serial: row.get('SERIAL'),
    estado: row.get('ESTADO'),
    cliente: row.get('CLIENTE'),
    usuarioDespacho: row.get('USUARIO_DESPACHO'),
    usuarioPlanta: row.get('USUARIO_PLANTA'),
    usuarioInstalacion: row.get('USUARIO_INSTALACION'),
    usuarioDesinstalacion: row.get('USUARIO_DESINSTALACION'),
    placa: row.get('PLACA'),
    kilometrajeInstalacion: row.get('KILOMETRAJE_INSTALACION'),
    kilometrajeDesinstalacion: row.get('KILOMETRAJE_DESINSTALACION'),
    fechaAlmacen: row.get('FECHA_ALMACEN'),
    fechaDespacho: row.get('FECHA_DESPACHO'),
    fechaInstalacion: row.get('FECHA_INSTALACION'),
    fechaDesinstalacion: row.get('FECHA_DESINSTALACION'),
    horaAlmacen: row.get('HORA_ALMACEN'),
    horaDespacho: row.get('HORA_DESPACHO'),
    horaInstalacion: row.get('HORA_INSTALACION'),
    horaDesinstalacion: row.get('HORA_DESINSTALACION')
  };
}

async function getAllRecordsForSuperadmin(doc, { requestedClient = '', maxRecords = 0 } = {}) {
  const requestedKey = requestedClient ? normalizeClientForMatch(requestedClient) : '';
  const cacheKey = requestedKey || '*';

  const normalizedMax = Number.isFinite(maxRecords) && maxRecords > 0
    ? Math.max(1, Math.min(maxRecords, 20_000))
    : 0;

  if (SUPERADMIN_RECORDS_CACHE_TTL_MS > 0) {
    cleanupSuperadminRecordsCache();

    const cached = superadminRecordsCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt && Array.isArray(cached.data)) {
      const data = cached.data;
      return normalizedMax ? data.slice(0, Math.min(normalizedMax, data.length)) : data.slice();
    }

    const inFlight = superadminRecordsInFlight.get(cacheKey);
    if (inFlight) {
      const data = await inFlight;
      return normalizedMax ? data.slice(0, Math.min(normalizedMax, data.length)) : data.slice();
    }
  }

  const loader = (async () => {
    const records = [];
    const globalSheet = await getOrCreateRecordsSheet(doc);
    const globalRows = await globalSheet.getRows();
    records.push(...globalRows.map(mapRecordRowToObject));

    await ensureDocInfoLoaded(doc);
    for (const sheet of doc.sheetsByIndex) {
      if (!sheet.title || sheet.title === RECORDS_SHEET_TITLE) continue;
      if (!sheet.title.endsWith('_REGISTROS')) continue;

      try {
        const rows = await sheet.getRows();
        const mapped = rows.map(mapRecordRowToObject);
        records.push(...mapped);
      } catch (error) {
        console.warn(`⚠️ No se pudo leer hoja ${sheet.title}:`, formatErrorForLogging(error));
      }
    }

    const filtered = requestedKey
      ? records.filter(r => normalizeClientForMatch(r.cliente || '') === requestedKey)
      : records;

    const byKey = new Map();
    for (const record of filtered) {
      const key = recordDedupKey(record);
      if (!key || key === '|') continue;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, record);
        continue;
      }
      const next = recordLatestEventTimestampMs(record) >= recordLatestEventTimestampMs(existing)
        ? record
        : existing;
      byKey.set(key, next);
    }

    const deduped = Array.from(byKey.values());
    deduped.sort((a, b) => recordLatestEventTimestampMs(b) - recordLatestEventTimestampMs(a));

    return deduped;
  })();

  if (SUPERADMIN_RECORDS_CACHE_TTL_MS > 0) {
    superadminRecordsInFlight.set(cacheKey, loader);
    try {
      const data = await loader;
      superadminRecordsCache.set(cacheKey, {
        expiresAt: Date.now() + Math.max(0, SUPERADMIN_RECORDS_CACHE_TTL_MS),
        data: Array.isArray(data) ? data : []
      });
      return normalizedMax ? data.slice(0, Math.min(normalizedMax, data.length)) : data;
    } finally {
      superadminRecordsInFlight.delete(cacheKey);
    }
  }

  const data = await loader;
  return normalizedMax ? data.slice(0, Math.min(normalizedMax, data.length)) : data;
}

function accumulateUserScanCountsFromRecordRow(row, countsByUser) {
  const scanStages = [
    { dateKey: 'FECHA_ALMACEN', userKey: 'USUARIO_PLANTA' },
    { dateKey: 'FECHA_DESPACHO', userKey: 'USUARIO_DESPACHO' },
    { dateKey: 'FECHA_INSTALACION', userKey: 'USUARIO_INSTALACION' },
    { dateKey: 'FECHA_DESINSTALACION', userKey: 'USUARIO_DESINSTALACION' }
  ];

  for (const stage of scanStages) {
    const dateValue = (row.get(stage.dateKey) || '').toString().trim();
    if (!dateValue) continue;

    const userValue = normalizeUser(row.get(stage.userKey));
    if (!userValue) continue;

    countsByUser[userValue] = (countsByUser[userValue] || 0) + 1;
  }
}

function accumulateUserScanCountsFromRecordObject(record, countsByUser) {
  const scanStages = [
    { date: record.fechaAlmacen, user: record.usuarioPlanta },
    { date: record.fechaDespacho, user: record.usuarioDespacho },
    { date: record.fechaInstalacion, user: record.usuarioInstalacion },
    { date: record.fechaDesinstalacion, user: record.usuarioDesinstalacion }
  ];

  for (const stage of scanStages) {
    const dateValue = (stage.date || '').toString().trim();
    if (!dateValue) continue;

    const userValue = normalizeUser(stage.user);
    if (!userValue) continue;

    countsByUser[userValue] = (countsByUser[userValue] || 0) + 1;
  }
}

/**
 * Valida credenciales de administrador o superadmin y retorna el row con información
 * @param {GoogleSpreadsheet} doc
 * @param {string} usuario
 * @param {string} password
 * @returns {Promise<{row: Object, tipo: string, cliente: string} | null>}
 */
async function validateAdminOrSuperadminCredentials(doc, usuario, password) {
  const lookup = await findUserRowByLoginIdentifier(doc, usuario, password);
  if (lookup.error || !lookup.row) {
    return null;
  }

  const userRow = lookup.row;
  if (!doesPasswordMatchRow(userRow, password)) {
    return null;
  }
  
  const tipo = normalizeType(userRow.get('TIPO'));
  const cliente = userRow.get('CLIENTE') || '';
  
  // Verificar que sea superadmin o administrador
  if (tipo !== 'super' && tipo !== 'administrador') {
    return null;
  }
  
  return { row: userRow, tipo, cliente };
}

/**
 * Valida credenciales de superadmin buscando en todas las hojas
 * @param {GoogleSpreadsheet} doc
 * @param {string} usuario
 * @param {string} password
 * @returns {Object|null} Fila del usuario si es válido y superadmin, null en caso contrario
 */
async function validateSuperadminCredentials(doc, usuario, password) {
  const lookup = await findUserRowByLoginIdentifier(doc, usuario, password);
  if (lookup.error || !lookup.row) {
    return null;
  }

  const userRow = lookup.row;
  if (!doesPasswordMatchRow(userRow, password)) {
    return null;
  }

  if (!isSuperadminRow(userRow)) {
    return null;
  }

  return userRow;
}

/**
 * Obtiene o crea la hoja de usuarios de un cliente específico
 * @param {GoogleSpreadsheet} doc
 * @param {string} cliente - Nombre del cliente
 */
async function getOrCreateClientUsersSheet(doc, cliente) {
  const normalizedClient = normalizeClient(cliente);
  const sheetTitle = `${normalizedClient}_USUARIOS`;
  const altTitle = `${normalizedClient.replace(/\s+/g, '_')}_USUARIOS`;
  
  let sheet = findSheetByTitleCandidates(doc, [sheetTitle, altTitle]);

  if (!sheet) {
    sheet = await doc.addSheet({
      title: sheetTitle,
      headerValues: [
        'NOMBRE',
        'USUARIO',
        'TIPO',
        'CONTRASEÑA',
        'CLIENTE'
      ]
    });
    console.log(`✅ Creada hoja de usuarios para cliente: ${sheetTitle}`);
  }

  await initializeUsersSheet(sheet);
  return sheet;
}

async function findUserRowByCredentials(doc, usuario, password) {
  const input = (usuario || '').toString().trim();
  if (!input || !password) return null;

  const lookup = await findUserRowByLoginIdentifier(doc, input, password);
  if (lookup.error || !lookup.row) {
    return null;
  }

  if (!doesPasswordMatchRow(lookup.row, password)) {
    return null;
  }

  return { sheet: lookup.sheet, row: lookup.row };
}

async function userExistsAcrossSheets(doc, usuario) {
  const normalizedUser = normalizeUser(usuario);
  if (!normalizedUser) return false;

  const globalSheet = await getOrCreateUsersSheet(doc);
  const globalRows = await globalSheet.getRows();
  if (globalRows.some(row => normalizeUser(row.get('USUARIO')) === normalizedUser)) {
    return true;
  }

  await ensureDocInfoLoaded(doc);
  for (const sheet of doc.sheetsByIndex) {
    if (!sheet.title.endsWith('_USUARIOS')) continue;
    const rows = await sheet.getRows();
    if (rows.some(row => normalizeUser(row.get('USUARIO')) === normalizedUser)) {
      return true;
    }
  }

  return false;
}

/**
 * Obtiene o crea la hoja de registros de un cliente específico
 * @param {GoogleSpreadsheet} doc
 * @param {string} cliente - Nombre del cliente
 */
async function getOrCreateClientRecordsSheet(doc, cliente) {
  const normalizedClient = normalizeClient(cliente);
  const sheetTitle = `${normalizedClient}_REGISTROS`;
  const altTitle = `${normalizedClient.replace(/\s+/g, '_')}_REGISTROS`;
  
  let sheet = findSheetByTitleCandidates(doc, [sheetTitle, altTitle]);

  if (!sheet) {
    sheet = await doc.addSheet({
      title: sheetTitle,
      headerValues: [
        'ID',
        'REFERENCIA',
        'SERIAL',
        'ESTADO',
        'CLIENTE',
        'USUARIO_DESPACHO',
        'USUARIO_PLANTA',
        'USUARIO_INSTALACION',
        'USUARIO_DESINSTALACION',
        'PLACA',
        'KILOMETRAJE_INSTALACION',
        'KILOMETRAJE_DESINSTALACION',
        'FECHA_ALMACEN',
        'FECHA_DESPACHO',
        'FECHA_INSTALACION',
        'FECHA_DESINSTALACION',
        'HORA_ALMACEN',
        'HORA_DESPACHO',
        'HORA_INSTALACION',
        'HORA_DESINSTALACION',
        'NOMBRE_INSTALADOR'
      ]
    });
    console.log(`✅ Creada hoja de registros para cliente: ${sheetTitle}`);
  }

  await ensureSheetHeaderRowLoaded(sheet);
  return sheet;
}

/**
 * Obtiene el cliente de un usuario desde cualquier hoja de clientes
 * @param {GoogleSpreadsheet} doc
 * @param {string} usuario
 */
async function getUserClient(doc, usuario) {
  const normalizedUser = normalizeUser(usuario);
  
  // Primero buscar en la hoja global USUARIOS (para superadmins)
  const globalSheet = await getOrCreateUsersSheet(doc);
  const globalRows = await globalSheet.getRows();
  const globalUser = globalRows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);
  
  if (globalUser) {
    return globalUser.get('CLIENTE') || '';
  }
  
  // Buscar en todas las hojas de clientes
  await ensureDocInfoLoaded(doc);
  for (const sheet of doc.sheetsByIndex) {
    if (sheet.title.endsWith('_USUARIOS')) {
      const rows = await sheet.getRows();
      const userRow = rows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);
      if (userRow) {
        return userRow.get('CLIENTE') || '';
      }
    }
  }
  
  return '';
}

async function validateUserCredentials(sheet, usuario, password) {
  const rows = await sheet.getRows();
  const normalizedUser = normalizeUser(usuario);
  const userRow = rows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);

  if (!userRow) {
    return null;
  }

  const storedPassword = (userRow.get('CONTRASEÑA') || '').toString().trim();
  if (storedPassword !== password) {
    return null;
  }

  return userRow;
}

/**
 * Busca un registro existente por REFERENCIA y SERIAL
 * @param {Object} sheet - Hoja de Google Sheets
 * @param {string} referencia - Referencia del producto
 * @param {string} serial - Serial del producto
 * @returns {Object|null} Fila encontrada o null
 */
async function findExistingRecord(sheet, referencia, serial) {
  const rows = await sheet.getRows();
  return rows.find(row => 
    row.get('REFERENCIA') === referencia && 
    row.get('SERIAL') === serial
  );
}

/**
 * Parsea el contenido del QR para extraer REFERENCIA y SERIAL
 * @param {string} qrContent - Contenido del QR en formato REFERENCIA|SERIAL
 * @returns {Object} Objeto con referencia y serial, o null si es inválido
 */
function parseQRContent(qrContent) {
  // Formato esperado: REFERENCIA|SERIAL (ej: OG971390|202630010002)
  const parts = qrContent.split('|');
  
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return {
      referencia: parts[0].trim(),
      serial: parts[1].trim()
    };
  }
  
  return null;
}

/**
 * Incrementa la parte numérica final de un serial, preservando prefijo y longitud.
 * Ej: '202630010001' + step 1 → '202630010002'
 *     'SER001' + step 4 → 'SER005'
 */
function incrementSerial(serial, step) {
  const match = serial.match(/^(.*?)(\d+)$/);
  if (!match) return serial + String(step + 1);
  const prefix = match[1];
  const numStr = match[2];
  const incremented = parseInt(numStr, 10) + step;
  return prefix + String(incremented).padStart(numStr.length, '0');
}

// ============================================
// RUTAS DE LA API
// ============================================

/**
 * Ruta de prueba - Verifica que el servidor está funcionando
 */
app.get('/api/health', async (req, res) => {
  const health = {
    status: 'OK',
    message: 'Servidor funcionando correctamente',
    timestamp: new Date().toISOString(),
    sheets: 'unknown'
  };

  try {
    await getGoogleSheet();
    health.sheets = 'connected';
  } catch {
    health.sheets = 'unavailable';
    health.status = 'DEGRADED';
  }

  res.status(health.status === 'OK' ? 200 : 503).json(health);
});

/**
 * Obtiene lista de clientes
 * GET /api/clients
 */
app.get('/api/clients', async (req, res) => {
  const cacheKey = 'api-clients-list';
  const cached = getFromApiCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const startTime = Date.now();
    const doc = await getGoogleSheet();
    const sheet = await getOrCreateClientsSheet(doc);
    const rows = await withSheetsRetry(() => sheet.getRows(), 'CLIENTES.getRows');

    const clients = rows.map(row => ({
      nombre: row.get('NOMBRE') || ''
    })).filter(c => c.nombre.trim() !== '');

    const payload = { success: true, data: clients };
    setToApiCache(cacheKey, payload, 300000); // 5 min cache para clientes
    console.log(`🏢 Listar Clientes | [MISS] | Tiempo: ${Date.now() - startTime}ms`);
    res.json(payload);
  } catch (error) {
    console.error('Error al obtener clientes:', formatErrorForLogging(error));
    res.status(500).json({ 
      success: false, 
      error: 'Error al obtener clientes',
      details: error.message 
    });
  }
});

/**
 * Registra un nuevo cliente
 * POST /api/clients
 * Body: { nombre, authUser, authPassword }
 */
app.post('/api/clients', async (req, res) => {
  try {
    const { nombre, authUser, authPassword } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'El nombre del cliente es requerido' 
      });
    }

    // Validar que sea superadmin
    const doc = await getGoogleSheet();
    const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
    
    if (!authData || authData.tipo !== 'super') {
      return res.status(401).json({ 
        success: false, 
        message: 'Solo superadmin puede agregar clientes' 
      });
    }

    // Obtener hoja de clientes
    const sheet = await getOrCreateClientsSheet(doc);
    const rows = await sheet.getRows();

    // Verificar que no exista ya
    const normalizedNombre = nombre.trim().toUpperCase();
    const exists = rows.some(row => 
      (row.get('NOMBRE') || '').trim().toUpperCase() === normalizedNombre
    );

    if (exists) {
      return res.status(400).json({ 
        success: false, 
        error: 'Este cliente ya existe' 
      });
    }

    // Agregar nuevo cliente
    const now = new Date().toLocaleDateString('es-ES');
    await sheet.addRow({
      'NOMBRE': nombre.trim(),
      'FECHA_REGISTRO': now
    });

    // Crear automáticamente la hoja de registros para este cliente
    await ensureDocInfoLoaded(doc);
    const clienteNormalizado = nombre.trim().toUpperCase();
    
    // Crear hoja de registros del cliente
    const recordsSheetName = `${clienteNormalizado}_REGISTROS`;
    let recordsSheet = doc.sheetsByTitle[recordsSheetName];
    if (!recordsSheet) {
      recordsSheet = await doc.addSheet({
        title: recordsSheetName,
        headerValues: [
          'ID',
          'REFERENCIA',
          'SERIAL',
          'ESTADO',
          'CLIENTE',
          'USUARIO_PLANTA',
          'USUARIO_INSTALACION',
          'USUARIO_DESINSTALACION',
          'PLACA',
          'KILOMETRAJE_INSTALACION',
          'KILOMETRAJE_DESINSTALACION',
          'FECHA_ALMACEN',
          'FECHA_DESPACHO',
          'FECHA_INSTALACION',
          'FECHA_DESINSTALACION',
          'HORA_ALMACEN',
          'HORA_DESPACHO',
          'HORA_INSTALACION',
          'HORA_DESINSTALACION'
        ]
      });
      console.log(`✅ Creada hoja de registros: ${recordsSheetName}`);
    }

    res.json({ 
      success: true, 
      message: '✅ Cliente y hoja de registros creados correctamente',
      data: {
        nombre: nombre.trim(),
        fechaRegistro: now,
        hojasCreadas: [recordsSheetName]
      }
    });
  } catch (error) {
    console.error('Error al registrar cliente:', formatErrorForLogging(error));
    res.status(500).json({ 
      success: false, 
      error: 'Error al registrar cliente',
      details: error.message 
    });
  }
});

/**
 * Actualiza un cliente existente
 * PUT /api/clients
 * Body: { nombreActual, nuevoNombre, authUser, authPassword }
 */
app.put('/api/clients', async (req, res) => {
  try {
    const { nombreActual, nuevoNombre, authUser, authPassword } = req.body;

    if (!nombreActual || !nombreActual.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'El nombre actual del cliente es requerido' 
      });
    }

    if (!nuevoNombre || !nuevoNombre.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'El nuevo nombre del cliente es requerido' 
      });
    }

    // Validar que sea superadmin
    const doc = await getGoogleSheet();
    const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
    
    if (!authData || authData.tipo !== 'super') {
      return res.status(401).json({ 
        success: false, 
        message: 'Solo superadmin puede editar clientes' 
      });
    }

    // Obtener hoja de clientes
    const sheet = await getOrCreateClientsSheet(doc);
    const rows = await sheet.getRows();

    // Buscar el cliente a editar
    const normalizedActual = nombreActual.trim().toUpperCase();
    const clienteRow = rows.find(row => 
      (row.get('NOMBRE') || '').trim().toUpperCase() === normalizedActual
    );

    if (!clienteRow) {
      return res.status(404).json({ 
        success: false, 
        error: 'Cliente no encontrado' 
      });
    }

    // Verificar que el nuevo nombre no exista ya (si es diferente)
    const normalizedNuevo = nuevoNombre.trim().toUpperCase();
    if (normalizedActual !== normalizedNuevo) {
      const exists = rows.some(row => 
        (row.get('NOMBRE') || '').trim().toUpperCase() === normalizedNuevo
      );

      if (exists) {
        return res.status(400).json({ 
          success: false, 
          error: 'Ya existe un cliente con ese nombre' 
        });
      }
    }

    // Actualizar el cliente
    clienteRow.set('NOMBRE', nuevoNombre.trim());
    await clienteRow.save();

    // También actualizar el nombre del cliente en:
    // 1. Hoja de registros globales
    // 2. Hoja de usuarios del cliente
    // 3. Renombrar la hoja del cliente (si existe)
    
    await ensureDocInfoLoaded(doc);
    
    // Actualizar registros globales
    const registrosSheet = await getOrCreateRecordsSheet(doc);
    const registrosRows = await registrosSheet.getRows();
    for (const row of registrosRows) {
      if ((row.get('CLIENTE') || '').trim().toUpperCase() === normalizedActual) {
        row.set('CLIENTE', nuevoNombre.trim());
        await row.save();
      }
    }

    // Actualizar usuarios del cliente
    const oldClientUsersSheetName = `${normalizedActual}_USUARIOS`;
    const oldClientRecordsSheetName = `${normalizedActual}_REGISTROS`;
    const newClientUsersSheetName = `${normalizedNuevo}_USUARIOS`;
    const newClientRecordsSheetName = `${normalizedNuevo}_REGISTROS`;

    // Renombrar hoja de usuarios si existe
    const oldUsersSheet = doc.sheetsByTitle[oldClientUsersSheetName];
    if (oldUsersSheet) {
      await oldUsersSheet.updateProperties({ title: newClientUsersSheetName });
      // Actualizar campo CLIENTE en cada usuario
      const usersRows = await oldUsersSheet.getRows();
      for (const row of usersRows) {
        row.set('CLIENTE', nuevoNombre.trim());
        await row.save();
      }
    }

    // Renombrar hoja de registros del cliente si existe
    const oldRecordsSheet = doc.sheetsByTitle[oldClientRecordsSheetName];
    if (oldRecordsSheet) {
      await oldRecordsSheet.updateProperties({ title: newClientRecordsSheetName });
      // Actualizar campo CLIENTE en cada registro
      const recordsRows = await oldRecordsSheet.getRows();
      for (const row of recordsRows) {
        row.set('CLIENTE', nuevoNombre.trim());
        await row.save();
      }
    }

    res.json({ 
      success: true, 
      message: '✅ Cliente actualizado correctamente',
      data: {
        nombreAnterior: nombreActual.trim(),
        nombreNuevo: nuevoNombre.trim()
      }
    });
  } catch (error) {
    console.error('Error al actualizar cliente:', formatErrorForLogging(error));
    res.status(500).json({ 
      success: false, 
      error: 'Error al actualizar cliente',
      details: error.message 
    });
  }
});

/**
 * Elimina un cliente
 * DELETE /api/clients
 * Body: { nombre, authUser, authPassword }
 */
app.delete('/api/clients', async (req, res) => {
  try {
    const { nombre, authUser, authPassword } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'El nombre del cliente es requerido' 
      });
    }

    // Validar que sea superadmin
    const doc = await getGoogleSheet();
    const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
    
    if (!authData || authData.tipo !== 'super') {
      return res.status(401).json({ 
        success: false, 
        message: 'Solo superadmin puede eliminar clientes' 
      });
    }

    // Obtener hoja de clientes
    const sheet = await getOrCreateClientsSheet(doc);
    const rows = await sheet.getRows();

    // Buscar el cliente a eliminar
    const normalizedNombre = nombre.trim().toUpperCase();
    const clienteRow = rows.find(row => 
      (row.get('NOMBRE') || '').trim().toUpperCase() === normalizedNombre
    );

    if (!clienteRow) {
      return res.status(404).json({ 
        success: false, 
        error: 'Cliente no encontrado' 
      });
    }

    // Verificar si el cliente tiene registros asociados
    const registrosSheet = await getOrCreateRecordsSheet(doc);
    const registrosRows = await registrosSheet.getRows();
    const tieneRegistros = registrosRows.some(row => 
      (row.get('CLIENTE') || '').trim().toUpperCase() === normalizedNombre
    );

    if (tieneRegistros) {
      return res.status(400).json({ 
        success: false, 
        error: 'No se puede eliminar el cliente porque tiene registros asociados. Primero elimina o reasigna los registros.' 
      });
    }

    // Eliminar el cliente de la hoja CLIENTES
    await clienteRow.delete();

    // Opcional: eliminar las hojas del cliente si existen
    await ensureDocInfoLoaded(doc);
    const clientUsersSheetName = `${normalizedNombre}_USUARIOS`;
    const clientRecordsSheetName = `${normalizedNombre}_REGISTROS`;

    const usersSheet = doc.sheetsByTitle[clientUsersSheetName];
    if (usersSheet) {
      await usersSheet.delete();
    }

    const recordsSheet = doc.sheetsByTitle[clientRecordsSheetName];
    if (recordsSheet) {
      await recordsSheet.delete();
    }

    res.json({ 
      success: true, 
      message: '✅ Cliente eliminado correctamente',
      data: {
        nombre: nombre.trim()
      }
    });
  } catch (error) {
    console.error('Error al eliminar cliente:', formatErrorForLogging(error));
    res.status(500).json({ 
      success: false, 
      error: 'Error al eliminar cliente',
      details: error.message 
    });
  }
});

/**
 * Guarda un código QR escaneado en Google Sheets
 * POST /api/save-qr
 * Body: { qrContent }
 */
app.post('/api/save-qr', async (req, res) => {
  try {
    const { qrContent, userEmail, userClient, userTipo } = req.body;

    // Validación de datos
    if (!qrContent) {
      return res.status(400).json({ 
        success: false, 
        error: 'El contenido del QR es requerido' 
      });
    }

    // El cliente es requerido desde el primer escaneo para usuarios despacho

    // Parsear el contenido del QR
    const parsedData = parseQRContent(qrContent);
    if (!parsedData) {
      console.log('❌ QR con formato inválido:', qrContent);
      return res.status(400).json({ 
        success: false, 
        error: `Formato de QR inválido. Esperado: REFERENCIA|SERIAL. Recibido: "${qrContent.substring(0, 50)}${qrContent.length > 50 ? '...' : ''}"`,
        qrContent: qrContent
      });
    }

    const { referencia, serial } = parsedData;

    // Conectar a Google Sheets y obtener la hoja REGISTROS global (fuente única de verdad)
    const doc = await getGoogleSheet();
    const globalSheet = await getOrCreateRecordsSheet(doc);
    
    // Asegurar que los headers estén cargados correctamente
    await ensureSheetHeaderRowLoaded(globalSheet);
    console.log('✅ Headers cargados en globalSheet:', globalSheet.headerValues);

    const existingGlobalRecord = await findExistingRecord(globalSheet, referencia, serial);
    const now = new Date();
    const fecha = now.toLocaleDateString('es-ES');
    const hora = now.toLocaleTimeString('es-ES');

    if (existingGlobalRecord) {
      // Registro existente: determinar siguiente estado
      // La trazabilidad es por serial, independiente del usuario que escanee
      const currentState = existingGlobalRecord.get('ESTADO');
      const recordClient = (existingGlobalRecord.get('CLIENTE') || '').trim(); // Cliente original del registro
      const normalizedUserClient = (userClient || '').trim();
      const effectiveClient = recordClient || normalizedUserClient;
      
      // Obtener la hoja del cliente actual (quien escanea) solo si tiene cliente asignado
      let currentClientSheet = null;
      let existingCurrentClientRecord = null;
      if (effectiveClient) {
        currentClientSheet = await getOrCreateClientRecordsSheet(doc, effectiveClient);
        await ensureSheetHeaderRowLoaded(currentClientSheet); // Asegurar headers cargados
        existingCurrentClientRecord = await findExistingRecord(currentClientSheet, referencia, serial);
      }
      
      // Obtener la hoja del cliente original (si es diferente)
      let originalClientSheet = null;
      let existingOriginalClientRecord = null;
      if (recordClient && recordClient !== normalizedUserClient && recordClient !== effectiveClient) {
        originalClientSheet = await getOrCreateClientRecordsSheet(doc, recordClient);
        await ensureSheetHeaderRowLoaded(originalClientSheet); // Asegurar headers cargados
        existingOriginalClientRecord = await findExistingRecord(originalClientSheet, referencia, serial);
      }
      
      if (currentState === 'EN ALMACEN') {
        // SEGUNDO ESCANEO: Actualizar a DESPACHADO
        // Validar que exista cliente asignado (debe venir desde el primer escaneo)
        if (!effectiveClient) {
          return res.status(400).json({ 
            success: false, 
            error: 'Debes seleccionar un cliente para continuar con este producto' 
          });
        }

        // Asegurar cliente en el registro global si no estaba
        if (!recordClient && effectiveClient) {
          existingGlobalRecord.set('CLIENTE', effectiveClient);
        }

        existingGlobalRecord.set('ESTADO', 'DESPACHADO');
        existingGlobalRecord.set('USUARIO_DESPACHO', userEmail || '');
        existingGlobalRecord.set('FECHA_DESPACHO', fecha);
        existingGlobalRecord.set('HORA_DESPACHO', hora);
        await existingGlobalRecord.save();

        // Registrar cliente en CLIENTES si no existe (solo para usuarios despacho)
        if (userTipo === 'despacho' && effectiveClient) {
          const clientsSheet = await getOrCreateClientsSheet(doc);
          const clientsRows = await clientsSheet.getRows();
          const normalizedClientName = effectiveClient.trim().toUpperCase();
          const clientExists = clientsRows.some(row => 
            (row.get('NOMBRE') || '').trim().toUpperCase() === normalizedClientName
          );
          
          if (!clientExists) {
            await clientsSheet.addRow({
              'NOMBRE': effectiveClient.trim(),
              'FECHA_REGISTRO': fecha
            });
          }
        }

        // Actualizar o crear registro en la hoja del cliente
        if (existingCurrentClientRecord) {
          existingCurrentClientRecord.set('ESTADO', 'DESPACHADO');
          existingCurrentClientRecord.set('CLIENTE', effectiveClient);
          existingCurrentClientRecord.set('USUARIO_DESPACHO', userEmail || '');
          existingCurrentClientRecord.set('USUARIO_PLANTA', existingGlobalRecord.get('USUARIO_PLANTA'));
          existingCurrentClientRecord.set('FECHA_DESPACHO', fecha);
          existingCurrentClientRecord.set('HORA_DESPACHO', hora);
          await existingCurrentClientRecord.save();
        } else {
          const currentClientRows = await currentClientSheet.getRows();
          await currentClientSheet.addRow({
            'ID': currentClientRows.length + 1,
            'REFERENCIA': referencia,
            'SERIAL': serial,
            'ESTADO': 'DESPACHADO',
            'CLIENTE': effectiveClient,
            'USUARIO_DESPACHO': userEmail || '',
            'USUARIO_PLANTA': existingGlobalRecord.get('USUARIO_PLANTA'),
            'USUARIO_INSTALACION': '',
            'USUARIO_DESINSTALACION': '',
            'PLACA': '',
            'KILOMETRAJE_INSTALACION': '',
            'KILOMETRAJE_DESINSTALACION': '',
            'NOMBRE_INSTALADOR': '',
            'FECHA_ALMACEN': existingGlobalRecord.get('FECHA_ALMACEN'),
            'FECHA_DESPACHO': fecha,
            'FECHA_INSTALACION': '',
            'FECHA_DESINSTALACION': '',
            'HORA_ALMACEN': existingGlobalRecord.get('HORA_ALMACEN'),
            'HORA_DESPACHO': hora,
            'HORA_INSTALACION': '',
            'HORA_DESINSTALACION': ''
          });
        }

        return res.json({ 
          success: true, 
          action: 'dispatched',
          message: '🚚 Producto marcado como DESPACHADO',
          data: {
            id: existingGlobalRecord.get('ID'),
            referencia,
            serial,
            estado: 'DESPACHADO',
            cliente: effectiveClient, // Cliente ya asignado desde el primer escaneo
            fechaAlmacen: existingGlobalRecord.get('FECHA_ALMACEN'),
            fechaDespacho: fecha
          }
        });
      } else if (currentState === 'DESPACHADO') {
        // TERCER ESCANEO: Actualizar a INSTALADO
        // Extraer datos adicionales del body con validación
        const placa = (req.body.placa || '').trim();
        const kilometrajeInstalacion = (req.body.kilometrajeInstalacion || '').trim();
        const installerName = (req.body.installerName || '').trim();
        
        // Verificar si se enviaron los datos de instalación
        if (!placa || !kilometrajeInstalacion) {
          // Pedir al frontend que solicite los datos de instalación
          return res.json({ 
            success: true, 
            action: 'needs_installation_data',
            message: 'Se requieren datos de instalación',
            data: {
              id: existingGlobalRecord.get('ID'),
              referencia,
              serial,
              estado: currentState,
              cliente: effectiveClient
            }
          });
        }
        
        // Log para debugging
        console.log(`📝 [INSTALACION] Guardando instalación - Placa: ${placa}, KM: ${kilometrajeInstalacion}, Instalador: "${installerName}" (length: ${installerName.length})`);
        
        existingGlobalRecord.set('ESTADO', 'INSTALADO');
        existingGlobalRecord.set('USUARIO_INSTALACION', userEmail || '');
        existingGlobalRecord.set('PLACA', placa);
        existingGlobalRecord.set('KILOMETRAJE_INSTALACION', kilometrajeInstalacion);
        existingGlobalRecord.set('NOMBRE_INSTALADOR', installerName);
        existingGlobalRecord.set('FECHA_INSTALACION', fecha);
        existingGlobalRecord.set('HORA_INSTALACION', hora);
        await existingGlobalRecord.save();

        const rewardSummary = await creditRewardPoints(
          doc,
          userEmail || installerName || 'usuario',
          installerName || userEmail || 'Usuario',
          1,
          {
            referencia,
            serial,
            movementType: 'installation',
            descripcion: 'Punto por instalación completada'
          }
        );

        // Actualizar o crear en la hoja del cliente actual
        if (existingCurrentClientRecord) {
          existingCurrentClientRecord.set('ESTADO', 'INSTALADO');
          existingCurrentClientRecord.set('USUARIO_INSTALACION', userEmail || '');
          existingCurrentClientRecord.set('PLACA', placa);
          existingCurrentClientRecord.set('KILOMETRAJE_INSTALACION', kilometrajeInstalacion);
          existingCurrentClientRecord.set('NOMBRE_INSTALADOR', installerName);
          existingCurrentClientRecord.set('FECHA_INSTALACION', fecha);
          existingCurrentClientRecord.set('HORA_INSTALACION', hora);
          await existingCurrentClientRecord.save();
        } else if (currentClientSheet) {
          // Crear nuevo registro en la hoja del cliente actual con todos los datos
          const currentClientRows = await currentClientSheet.getRows();
          await currentClientSheet.addRow({
            'ID': currentClientRows.length + 1,
            'REFERENCIA': referencia,
            'SERIAL': serial,
            'ESTADO': 'INSTALADO',
            'CLIENTE': effectiveClient,
            'USUARIO_DESPACHO': existingGlobalRecord.get('USUARIO_DESPACHO'),
            'USUARIO_PLANTA': existingGlobalRecord.get('USUARIO_PLANTA'),
            'USUARIO_INSTALACION': userEmail || '',
            'USUARIO_DESINSTALACION': '',
            'PLACA': placa,
            'KILOMETRAJE_INSTALACION': kilometrajeInstalacion,
            'NOMBRE_INSTALADOR': installerName,
            'FECHA_ALMACEN': existingGlobalRecord.get('FECHA_ALMACEN'),
            'FECHA_DESPACHO': existingGlobalRecord.get('FECHA_DESPACHO'),
            'FECHA_INSTALACION': fecha,
            'FECHA_DESINSTALACION': '',
            'HORA_ALMACEN': existingGlobalRecord.get('HORA_ALMACEN'),
            'HORA_DESPACHO': existingGlobalRecord.get('HORA_DESPACHO'),
            'HORA_INSTALACION': hora,
            'HORA_DESINSTALACION': ''
          });
        }

        // Actualizar también en hoja del cliente original (si es diferente)
        if (existingOriginalClientRecord) {
          existingOriginalClientRecord.set('ESTADO', 'INSTALADO');
          existingOriginalClientRecord.set('USUARIO_INSTALACION', userEmail || '');
          existingOriginalClientRecord.set('PLACA', placa);
          existingOriginalClientRecord.set('KILOMETRAJE_INSTALACION', kilometrajeInstalacion);
          existingOriginalClientRecord.set('NOMBRE_INSTALADOR', installerName);
          existingOriginalClientRecord.set('FECHA_INSTALACION', fecha);
          existingOriginalClientRecord.set('HORA_INSTALACION', hora);
          await existingOriginalClientRecord.save();
        }

        return res.json({ 
          success: true, 
          action: 'installed',
          message: '🔧 Producto marcado como INSTALADO',
          data: {
            id: existingGlobalRecord.get('ID'),
            referencia,
            serial,
            estado: 'INSTALADO',
            cliente: effectiveClient,
            fechaAlmacen: existingGlobalRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingGlobalRecord.get('FECHA_DESPACHO'),
            fechaInstalacion: fecha,
            usuarioInstalacion: userEmail,
            rewardSummary
          }
        });
      } else if (currentState === 'INSTALADO') {
        // CUARTO ESCANEO: Actualizar a DESINSTALADO
        const kilometrajeDesinstalacion = (req.body.kilometrajeDesinstalacion || '').trim();

        if (!kilometrajeDesinstalacion) {
          return res.json({
            success: true,
            action: 'needs_uninstallation_data',
            message: 'Se requieren datos de desinstalación',
            data: {
              id: existingGlobalRecord.get('ID'),
              referencia,
              serial,
              estado: currentState,
              cliente: effectiveClient
            }
          });
        }

        existingGlobalRecord.set('ESTADO', 'DESINSTALADO');
        existingGlobalRecord.set('USUARIO_DESINSTALACION', userEmail || '');
        existingGlobalRecord.set('KILOMETRAJE_DESINSTALACION', kilometrajeDesinstalacion);
        existingGlobalRecord.set('FECHA_DESINSTALACION', fecha);
        existingGlobalRecord.set('HORA_DESINSTALACION', hora);
        await existingGlobalRecord.save();

        const rewardSummary = await creditRewardPoints(
          doc,
          userEmail || existingGlobalRecord.get('NOMBRE_INSTALADOR') || 'usuario',
          userEmail || existingGlobalRecord.get('NOMBRE_INSTALADOR') || 'Usuario',
          1,
          {
            referencia,
            serial,
            movementType: 'uninstallation',
            descripcion: 'Punto por desinstalación completada'
          }
        );

        if (existingCurrentClientRecord) {
          existingCurrentClientRecord.set('ESTADO', 'DESINSTALADO');
          existingCurrentClientRecord.set('USUARIO_DESINSTALACION', userEmail || '');
          existingCurrentClientRecord.set('KILOMETRAJE_DESINSTALACION', kilometrajeDesinstalacion);
          existingCurrentClientRecord.set('FECHA_DESINSTALACION', fecha);
          existingCurrentClientRecord.set('HORA_DESINSTALACION', hora);
          await existingCurrentClientRecord.save();
        }

        if (existingOriginalClientRecord) {
          existingOriginalClientRecord.set('ESTADO', 'DESINSTALADO');
          existingOriginalClientRecord.set('USUARIO_DESINSTALACION', userEmail || '');
          existingOriginalClientRecord.set('KILOMETRAJE_DESINSTALACION', kilometrajeDesinstalacion);
          existingOriginalClientRecord.set('FECHA_DESINSTALACION', fecha);
          existingOriginalClientRecord.set('HORA_DESINSTALACION', hora);
          await existingOriginalClientRecord.save();
        }

        return res.json({
          success: true,
          action: 'uninstalled',
          message: '📤 Producto marcado como DESINSTALADO',
          data: {
            id: existingGlobalRecord.get('ID'),
            referencia,
            serial,
            estado: 'DESINSTALADO',
            cliente: effectiveClient,
            fechaAlmacen: existingGlobalRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingGlobalRecord.get('FECHA_DESPACHO'),
            fechaInstalacion: existingGlobalRecord.get('FECHA_INSTALACION'),
            fechaDesinstalacion: fecha,
            usuarioDesinstalacion: userEmail,
            rewardSummary
          }
        });
      } else {
        // Ya fue DESINSTALADO, mostrar información pero asegurar que existe en hoja del cliente actual
        if (!existingCurrentClientRecord && currentClientSheet) {
          // Crear el registro en la hoja del cliente actual para que pueda verlo
          const currentClientRows = await currentClientSheet.getRows();
          await currentClientSheet.addRow({
            'ID': currentClientRows.length + 1,
            'REFERENCIA': referencia,
            'SERIAL': serial,
            'ESTADO': 'DESINSTALADO',
            'CLIENTE': recordClient,
            'USUARIO_DESPACHO': existingGlobalRecord.get('USUARIO_DESPACHO'),
            'USUARIO_PLANTA': existingGlobalRecord.get('USUARIO_PLANTA'),
            'USUARIO_INSTALACION': existingGlobalRecord.get('USUARIO_INSTALACION'),
            'USUARIO_DESINSTALACION': existingGlobalRecord.get('USUARIO_DESINSTALACION'),
            'PLACA': existingGlobalRecord.get('PLACA'),
            'KILOMETRAJE_INSTALACION': existingGlobalRecord.get('KILOMETRAJE_INSTALACION'),
            'KILOMETRAJE_DESINSTALACION': existingGlobalRecord.get('KILOMETRAJE_DESINSTALACION'),
            'FECHA_ALMACEN': existingGlobalRecord.get('FECHA_ALMACEN'),
            'FECHA_DESPACHO': existingGlobalRecord.get('FECHA_DESPACHO'),
            'FECHA_INSTALACION': existingGlobalRecord.get('FECHA_INSTALACION'),
            'FECHA_DESINSTALACION': existingGlobalRecord.get('FECHA_DESINSTALACION'),
            'HORA_ALMACEN': existingGlobalRecord.get('HORA_ALMACEN'),
            'HORA_DESPACHO': existingGlobalRecord.get('HORA_DESPACHO'),
            'HORA_INSTALACION': existingGlobalRecord.get('HORA_INSTALACION'),
            'HORA_DESINSTALACION': existingGlobalRecord.get('HORA_DESINSTALACION')
          });
        }

        return res.json({ 
          success: true, 
          action: 'already_completed',
          message: '⚠️ Este producto ya completó todo el ciclo (DESINSTALADO)',
          data: {
            referencia,
            serial,
            estado: currentState,
            cliente: recordClient,
            fechaAlmacen: existingGlobalRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingGlobalRecord.get('FECHA_DESPACHO'),
            fechaInstalacion: existingGlobalRecord.get('FECHA_INSTALACION'),
            fechaDesinstalacion: existingGlobalRecord.get('FECHA_DESINSTALACION')
          }
        });
      }
    } else {
      // PRIMER ESCANEO: Crear nuevo registro EN ALMACEN (con cliente)
      const normalizedUserClient = (userClient || '').trim();
      if (userTipo === 'despacho' && !normalizedUserClient) {
        return res.status(400).json({ 
          success: false, 
          error: 'Debes seleccionar un cliente para registrar este producto' 
        });
      }
      const globalRows = await globalSheet.getRows();
      const nextGlobalId = globalRows.length + 1;

      const newRecordData = {
        'REFERENCIA': referencia,
        'SERIAL': serial,
        'ESTADO': 'EN ALMACEN',
        'CLIENTE': normalizedUserClient,
        'USUARIO_DESPACHO': '',
        'USUARIO_PLANTA': userEmail || '',
        'USUARIO_INSTALACION': '',
        'USUARIO_DESINSTALACION': '',
        'PLACA': '',
        'KILOMETRAJE_INSTALACION': '',
        'FECHA_ALMACEN': fecha,
        'FECHA_DESPACHO': '',
        'FECHA_INSTALACION': '',
        'FECHA_DESINSTALACION': '',
        'HORA_ALMACEN': hora,
        'HORA_DESPACHO': '',
        'HORA_INSTALACION': '',
        'HORA_DESINSTALACION': ''
      };

      // Guardar en hoja global REGISTROS (fuente única de verdad)
      await globalSheet.addRow({
        'ID': nextGlobalId,
        ...newRecordData
      });

      // Registrar cliente en CLIENTES si no existe
      if (normalizedUserClient) {
        const clientsSheet = await getOrCreateClientsSheet(doc);
        const clientsRows = await clientsSheet.getRows();
        const normalizedClientName = normalizedUserClient.toUpperCase();
        const clientExists = clientsRows.some(row => 
          (row.get('NOMBRE') || '').trim().toUpperCase() === normalizedClientName
        );
        if (!clientExists) {
          await clientsSheet.addRow({
            'NOMBRE': normalizedUserClient,
            'FECHA_REGISTRO': fecha
          });
        }
      }

      // Guardar tambien en la hoja del cliente
      if (normalizedUserClient) {
        const clientSheet = await getOrCreateClientRecordsSheet(doc, normalizedUserClient);
        await ensureSheetHeaderRowLoaded(clientSheet);
        const clientRows = await clientSheet.getRows();
        await clientSheet.addRow({
          'ID': clientRows.length + 1,
          'REFERENCIA': referencia,
          'SERIAL': serial,
          'ESTADO': 'EN ALMACEN',
          'CLIENTE': normalizedUserClient,
          'USUARIO_DESPACHO': '',
          'USUARIO_PLANTA': userEmail || '',
          'USUARIO_INSTALACION': '',
          'USUARIO_DESINSTALACION': '',
          'PLACA': '',
          'KILOMETRAJE_INSTALACION': '',
          'KILOMETRAJE_DESINSTALACION': '',
          'NOMBRE_INSTALADOR': '',
          'FECHA_ALMACEN': fecha,
          'FECHA_DESPACHO': '',
          'FECHA_INSTALACION': '',
          'FECHA_DESINSTALACION': '',
          'HORA_ALMACEN': hora,
          'HORA_DESPACHO': '',
          'HORA_INSTALACION': '',
          'HORA_DESINSTALACION': ''
        });
      }

      res.json({ 
        success: true, 
        action: 'stored',
        message: '✅ Producto registrado EN ALMACEN',
        data: {
          id: nextGlobalId,
          referencia,
          serial,
          estado: 'EN ALMACEN',
          cliente: normalizedUserClient,
          fechaAlmacen: fecha
        }
      });
    }

  } catch (error) {
    console.error('Error al guardar QR:', formatErrorForLogging(error));
    res.status(500).json({ 
      success: false, 
      error: 'Error al guardar en Google Sheets',
      details: error.message 
    });
  }
});

/**
 * Obtiene los últimos registros de QR escaneados
 * GET /api/recent-scans?limit=10&cliente=ACME
 * Requiere headers: x-auth-user, x-auth-password
 */
app.get('/api/recent-scans', async (req, res) => {
  let cacheKey = null;
  try {
    const limit = parseInt(req.query.limit) || 10;
    const requestedClient = (req.query.cliente || '').toString().trim();

    const authUser = (req.headers['x-auth-user'] || '').toString().trim();
    const authPassword = (req.headers['x-auth-password'] || '').toString();

    if (!authUser || !authPassword) {
      return res.status(401).json({ success: false, message: 'Credenciales requeridas' });
    }
    
    const doc = await getGoogleSheet();
    const auth = await findUserRowByCredentials(doc, authUser, authPassword);
    if (!auth) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const authTipo = normalizeType(auth.row.get('TIPO'));
    const authCliente = (auth.row.get('CLIENTE') || '').toString().trim();
    const isSuper = authTipo === 'super';
    const isAdmin = authTipo === 'administrador';
    const authEmail = normalizeUser(auth.row.get('USUARIO') || authUser);
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 2000)) : 10;

    cacheKey = `recent-scans|${authTipo}|${normalizeClientForMatch(requestedClient)}|${safeLimit}|${authEmail}`;
    const cached = getFromApiCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    let records = [];

    // Usar hoja global REGISTROS como fuente única de verdad.
    // Esto reduce cuota (evita leer N hojas por cliente) y asegura consistencia.
    records = await getGlobalRecordsObjects(doc);

    if (requestedClient) {
      // Filtro por cliente: permitido para superadmin, y para admin solo si es su cliente
      if (!isSuper && !isAdmin) {
        return res.status(403).json({ success: false, message: 'No autorizado para filtrar por cliente' });
      }

      const requestedKey = normalizeClientForMatch(requestedClient);
      if (isAdmin) {
        const adminKey = normalizeClientForMatch(authCliente);
        if (!adminKey || requestedKey !== adminKey) {
          return res.status(403).json({ success: false, message: 'Solo puede ver registros de su cliente' });
        }
      }

      records = records.filter(r => normalizeClientForMatch(r.cliente || '') === requestedKey);
    } else if (isAdmin) {
      // Admin: siempre restringido a su cliente
      const adminKey = normalizeClientForMatch(authCliente);
      records = records.filter(r => normalizeClientForMatch(r.cliente || '') === adminKey);
    } else if (!isSuper) {
      // Usuarios normales: solo sus registros
      records = records.filter(r => {
        const normalized = normalizeUser(authEmail);
        if (!normalized) return false;
        return [
          r.usuarioDespacho,
          r.usuarioPlanta,
          r.usuarioInstalacion,
          r.usuarioDesinstalacion
        ].some(value => normalizeUser(value) === normalized);
      });
    }

    // Ordenar por el último evento (más reciente primero)
    records.sort((a, b) => recordLatestEventTimestampMs(b) - recordLatestEventTimestampMs(a));

    const data = records.slice(0, safeLimit);

    const payload = { success: true, data };
    setToApiCache(cacheKey, payload);
    res.json(payload);

  } catch (error) {
    console.error('Error al obtener registros:', formatErrorForLogging(error));
    if (cacheKey && isGoogleQuotaError(error)) {
      const payload = {
        success: false,
        error: 'Google API error - cuota excedida',
        details: error?.response?.data?.error?.message || error?.message || 'Quota exceeded'
      };
      setToApiCache(cacheKey, payload, API_QUOTA_ERROR_CACHE_TTL_MS);
    }
    return respondGoogleSheetsError(res, error, 'Error al obtener registros');
  }
});

/**
 * Obtiene estadísticas de escaneos
 * GET /api/stats
 * Requiere headers: x-auth-user, x-auth-password
 */
app.get('/api/stats', async (req, res) => {
  let cacheKey = null;
  try {
    const cliente = (req.query.cliente || '').toString().trim();
    const authUser = (req.headers['x-auth-user'] || '').toString().trim();
    const authPassword = (req.headers['x-auth-password'] || '').toString();

    if (!authUser || !authPassword) {
      return res.status(401).json({ success: false, message: 'Credenciales requeridas' });
    }
    
    const doc = await getGoogleSheet();

    const auth = await findUserRowByCredentials(doc, authUser, authPassword);
    if (!auth) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const authTipo = normalizeType(auth.row.get('TIPO'));
    const authCliente = (auth.row.get('CLIENTE') || '').toString().trim();
    const isSuper = authTipo === 'super';
    const isAdmin = authTipo === 'administrador';
  const normalizedUser = normalizeUser(auth.row.get('USUARIO') || authUser);
  // Solo usuarios finales (mecánico/despacho) deben ver conteos por su propio usuario.
  // Admin y Superadmin ven conteos agregados del cliente / global.
  const shouldFilterByUser = !isSuper && !isAdmin;

    cacheKey = `stats|${authTipo}|${normalizeClientForMatch(cliente)}|${normalizedUser}`;
    const cached = getFromApiCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Stats siempre se calculan desde la hoja global REGISTROS (fuente única de verdad).
    // Esto asegura que el contador de superadmin refleje exactamente el total en REGISTROS.
    let records = await getGlobalRecordsObjects(doc);
    console.log(`📊 Stats API: Total de registros disponibles: ${records.length}`);

    if (cliente) {
      if (!isSuper && !isAdmin) {
        return res.status(403).json({ success: false, message: 'No autorizado para filtrar por cliente' });
      }

      const requestedKey = normalizeClientForMatch(cliente);
      if (isAdmin) {
        const adminKey = normalizeClientForMatch(authCliente);
        if (!adminKey || requestedKey !== adminKey) {
          return res.status(403).json({ success: false, message: 'Solo puede ver estadísticas de su cliente' });
        }
      }

      records = records.filter(r => normalizeClientForMatch(r.cliente || '') === requestedKey);
    } else if (isAdmin) {
      const adminKey = normalizeClientForMatch(authCliente);
      records = records.filter(r => normalizeClientForMatch(r.cliente || '') === adminKey);
    } else if (!isSuper) {
      records = records.filter(r => {
        const normalized = normalizeUser(normalizedUser);
        if (!normalized) return false;
        return [
          r.usuarioDespacho,
          r.usuarioPlanta,
          r.usuarioInstalacion,
          r.usuarioDesinstalacion
        ].some(value => normalizeUser(value) === normalized);
      });
      console.log(`👤 Stats filtradas por usuario "${normalizedUser}": ${records.length} registros`);
    }

    // Adaptar records (objetos) a una forma compatible con el bloque existente
    const rows = records.map(record => ({
      get: (key) => {
        const map = {
          ID: record.id,
          REFERENCIA: record.referencia,
          SERIAL: record.serial,
          ESTADO: record.estado,
          CLIENTE: record.cliente,
          USUARIO_DESPACHO: record.usuarioDespacho,
          USUARIO_PLANTA: record.usuarioPlanta,
          USUARIO_INSTALACION: record.usuarioInstalacion,
          USUARIO_DESINSTALACION: record.usuarioDesinstalacion,
          PLACA: record.placa,
          KILOMETRAJE_INSTALACION: record.kilometrajeInstalacion,
          KILOMETRAJE_DESINSTALACION: record.kilometrajeDesinstalacion,
          FECHA_ALMACEN: record.fechaAlmacen,
          FECHA_DESPACHO: record.fechaDespacho,
          FECHA_INSTALACION: record.fechaInstalacion,
          FECHA_DESINSTALACION: record.fechaDesinstalacion,
          HORA_ALMACEN: record.horaAlmacen,
          HORA_DESPACHO: record.horaDespacho,
          HORA_INSTALACION: record.horaInstalacion,
          HORA_DESINSTALACION: record.horaDesinstalacion
        };
        return map[key];
      }
    }));
    const today = new Date().toLocaleDateString('es-ES');

    const stats = {
      total: rows.length,       // Total de registros (global o filtrado por cliente/usuario)
      enAlmacen: 0,
      despachados: 0,
      instalados: 0,
      desinstalados: 0,
      today: 0,
      // Conteos por eventos (escaneos) sin romper el significado actual de total/today.
      // totalScans: número de transiciones registradas (almacén, despacho, instalación, desinstalación).
      // todayScans: eventos registrados en el día.
      totalScans: 0,
      todayScans: 0
    };

    const scanStages = [
      { dateKey: 'FECHA_ALMACEN', userKey: 'USUARIO_PLANTA' },
      { dateKey: 'FECHA_DESPACHO', userKey: 'USUARIO_DESPACHO' },
      { dateKey: 'FECHA_INSTALACION', userKey: 'USUARIO_INSTALACION' },
      { dateKey: 'FECHA_DESINSTALACION', userKey: 'USUARIO_DESINSTALACION' }
    ];

    rows.forEach(row => {
      const estado = row.get('ESTADO');
      
      if (estado === 'EN ALMACEN') {
        stats.enAlmacen++;
      } else if (estado === 'DESPACHADO') {
        stats.despachados++;
      } else if (estado === 'INSTALADO') {
        stats.instalados++;
      } else if (estado === 'DESINSTALADO') {
        stats.desinstalados++;
      }
      
      // Conteo record-based (compatibilidad): si el registro tuvo algún evento hoy.
      if (row.get('FECHA_ALMACEN') === today || row.get('FECHA_DESPACHO') === today ||
          row.get('FECHA_INSTALACION') === today || row.get('FECHA_DESINSTALACION') === today) {
        stats.today++;
      }

      // Conteo event-based (escaneos): cada etapa con fecha cuenta como 1 escaneo.
      scanStages.forEach(stage => {
        const dateValue = (row.get(stage.dateKey) || '').toString().trim();
        if (!dateValue) {
          return;
        }

        // Si se pidió filtrado por usuario (solo usuarios finales), contar solo eventos hechos por ese usuario.
        if (shouldFilterByUser && normalizedUser) {
          const stageUser = normalizeUser(row.get(stage.userKey));
          if (stageUser !== normalizedUser) {
            return;
          }
        }

        stats.totalScans++;
        if (dateValue === today) {
          stats.todayScans++;
        }
      });
    });

    console.log(`📈 Estadísticas finales:`, stats);
    const payload = { success: true, data: stats };
    setToApiCache(cacheKey, payload);
    res.json(payload);

  } catch (error) {
    console.error('Error al obtener estadísticas:', formatErrorForLogging(error));
    if (cacheKey && isGoogleQuotaError(error)) {
      const payload = {
        success: false,
        error: 'Google API error - cuota excedida',
        details: error?.response?.data?.error?.message || error?.message || 'Quota exceeded'
      };
      setToApiCache(cacheKey, payload, API_QUOTA_ERROR_CACHE_TTL_MS);
    }
    return respondGoogleSheetsError(res, error, 'Error al obtener estadísticas');
  }
});

/**
 * Obtiene proyecciones de pedidos y duración de filtros
 * GET /api/projections
 */
app.get('/api/projections', async (req, res) => {
  try {
    const startTime = Date.now();
    const cliente = req.query.cliente || '';
    const authUser = req.headers['x-auth-user'] || '';
    const authPassword = req.headers['x-auth-password'] || '';

    const doc = await getGoogleSheet();

    // Validar que el usuario autenticado sea superadmin o administrador
    const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
    if (!authData) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const { tipo: authTipo, cliente: authCliente } = authData;
    const effectiveCliente = cliente || (authTipo !== 'super' ? authCliente : '');
    const cacheKey = `projections|${authTipo}|${normalizeClientForMatch(effectiveCliente)}`;
    const cached = getFromApiCache(cacheKey);
    if (cached) {
      console.log(`🔮 Proyecciones | [HIT] | ${Date.now() - startTime}ms`);
      return res.json(cached);
    }
    
    // Recopilar todos los registros solo de la hoja REGISTROS global
    const globalSheet = await getOrCreateRecordsSheet(doc);
    let allRows = await globalSheet.getRows();
    
    // Filtrar por cliente si se especifica
    if (cliente) {
      allRows = allRows.filter(row => {
        const rowCliente = row.get('CLIENTE') || '';
        return rowCliente.toUpperCase() === cliente.toUpperCase();
      });
    } else if (authTipo !== 'super') {
      // Administrador solo puede ver su cliente
      allRows = allRows.filter(row => {
        const rowCliente = row.get('CLIENTE') || '';
        return rowCliente.toUpperCase() === authCliente.toUpperCase();
      });
    }

    // PASO 1: Calcular duración promedio por (cliente, referencia) y por (cliente, placa, referencia)
    // usando registros DESINSTALADO (histórico real).
    const durationsByClientRef = {}; // Key: "cliente|referencia", Value: array de duraciones en días
    const durationsByVehicleRef = {}; // Key: "cliente|placa|referencia", Value: array de duraciones en días
    
    allRows.forEach(row => {
      const estado = row.get('ESTADO');
      const cliente = row.get('CLIENTE') || 'Sin Cliente';
      const referencia = row.get('REFERENCIA');
      const placa = row.get('PLACA') || '';
      const fechaInst = row.get('FECHA_INSTALACION');
      const fechaDesinst = row.get('FECHA_DESINSTALACION');

      // Recopilar datos de filtros desinstalados para calcular promedios
      if (estado === 'DESINSTALADO' && fechaInst && fechaDesinst) {
        const dateInst = parseSpanishDate(fechaInst);
        const dateDesinst = parseSpanishDate(fechaDesinst);
        
        if (dateInst && dateDesinst) {
          const diasInstalado = Math.round((dateDesinst - dateInst) / (1000 * 60 * 60 * 24));
          
          // Solo registrar si tiene duración válida (> 0)
          if (diasInstalado > 0) {
            const key = `${cliente}|${referencia}`;
            if (!durationsByClientRef[key]) {
              durationsByClientRef[key] = [];
            }
            durationsByClientRef[key].push(diasInstalado);

            const placaValue = (placa || '').toString().trim();
            if (placaValue) {
              const vehicleKey = `${cliente}|${placaValue}|${referencia}`;
              if (!durationsByVehicleRef[vehicleKey]) {
                durationsByVehicleRef[vehicleKey] = [];
              }
              durationsByVehicleRef[vehicleKey].push(diasInstalado);
            }
          }
        }
      }
    });

    // Calcular promedios por (cliente, referencia)
    const avgDurationByClientRef = {};
    for (const key in durationsByClientRef) {
      const durations = durationsByClientRef[key];
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      avgDurationByClientRef[key] = Math.round(avg);
    }

    // Calcular promedios por (cliente, placa, referencia)
    const avgDurationByVehicleRef = {};
    for (const key in durationsByVehicleRef) {
      const durations = durationsByVehicleRef[key];
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      avgDurationByVehicleRef[key] = Math.round(avg);
    }

    // PASO 2: Para cada filtro instalado, calcular fecha estimada de reemplazo.
    // Importante: primero intentamos usar promedio individual por VEHÍCULO (placa+referencia).
    const nextReplacements = [];
    
    allRows.forEach(row => {
      const estado = row.get('ESTADO');
      const cliente = row.get('CLIENTE') || 'Sin Cliente';
      const referencia = row.get('REFERENCIA');
      const serial = row.get('SERIAL');
      const placa = row.get('PLACA');
      const fechaInst = row.get('FECHA_INSTALACION');

      if (estado === 'INSTALADO' && fechaInst && (cliente || referencia)) {
        const dateInst = parseSpanishDate(fechaInst);
        if (dateInst) {
          const keyClientRef = `${cliente}|${referencia}`;

          const placaValue = (placa || '').toString().trim();
          const vehicleKey = placaValue ? `${cliente}|${placaValue}|${referencia}` : '';

          // Obtener duración promedio individual por vehículo (si existe), si no por (cliente, referencia), si no default.
          const avgDuration = (vehicleKey && avgDurationByVehicleRef[vehicleKey])
            ? avgDurationByVehicleRef[vehicleKey]
            : (avgDurationByClientRef[keyClientRef] || 90);

          // Calcular fecha estimada de reemplazo
          const estimatedDate = new Date(dateInst);
          estimatedDate.setDate(estimatedDate.getDate() + avgDuration);

          nextReplacements.push({
            cliente,
            referencia,
            serial,
            placa,
            fechaInstalacion: fechaInst,
            duracionPromedioDias: avgDuration,
            fechaEstimadaReemplazo: formatDateToSpanish(estimatedDate)
          });
        }
      }
    });

    // Ordenar por fecha estimada de reemplazo (ascendente)
    nextReplacements.sort((a, b) => {
      const dateA = parseSpanishDate(a.fechaEstimadaReemplazo);
      const dateB = parseSpanishDate(b.fechaEstimadaReemplazo);
      return dateA - dateB;
    });

    // Calcular estadísticas generales
    const allDurations = Object.values(durationsByClientRef).flat();
    const avgDaysDuration = allDurations.length > 0
      ? Math.round(allDurations.reduce((sum, d) => sum + d, 0) / allDurations.length)
      : 0;

    const payload = {
      success: true,
      data: {
        nextReplacements: nextReplacements,
        stats: {
          avgDaysDuration,
          totalFiltersAnalyzed: allDurations.length,
          nextReplacementsCount: nextReplacements.length
        }
      }
    };
    setToApiCache(cacheKey, payload, 300000); // 5 min cache
    console.log(`🔮 Proyecciones | [MISS] | Tiempo: ${Date.now() - startTime}ms`);
    res.json(payload);
  } catch (error) {
    console.error('Error al obtener proyecciones:', formatErrorForLogging(error));
    res.status(500).json({
      success: false,
      error: 'Error al obtener proyecciones',
      details: error.message
    });
  }
});

/**
 * Función auxiliar para parsear fechas en formato español dd/mm/yyyy
 */
/**
 * Convierte una fecha JavaScript a formato español DD/MM/YYYY
 */
function formatDateToSpanish(date) {
  if (!date) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function parseSpanishDate(dateString) {
  if (!dateString) return null;
  const parts = dateString.split('/');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0]);
  const month = parseInt(parts[1]) - 1; // Los meses en JS van de 0-11
  const year = parseInt(parts[2]);
  return new Date(year, month, day);
}

/**
 * Función auxiliar para formatear mes-año
 */
function formatMonthYear(monthYear) {
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const [year, month] = monthYear.split('-');
  return `${months[parseInt(month) - 1]} ${year}`;
}

/**
 * GET /api/rewards/users
 * Obtiene el puntaje de recompensas por usuario (vista admin/superadmin)
 */
app.get('/api/rewards/users', async (req, res) => {
  let cacheKey = null;
  try {
    const authUser = req.headers['x-auth-user'] || '';
    const authPassword = req.headers['x-auth-password'] || '';

    if (!authUser || !authPassword) {
      return res.status(401).json({
        success: false,
        error: 'Credenciales requeridas'
      });
    }

    const doc = await getGoogleSheet();
    const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
    if (!authData) {
      return res.status(401).json({
        success: false,
        error: 'No autorizado'
      });
    }

    cacheKey = `rewards-users|${authData?.tipo || ''}|${normalizeClientForMatch(authData?.cliente || '')}`;
    const cached = getFromApiCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const rewardsSheet = await getOrCreateRewardsSheet(doc);
    const rewardRows = await rewardsSheet.getRows();
    const rewardsByUser = new Map();

    rewardRows.forEach(row => {
      const key = normalizeRewardIdentifier(row.get('IDENTIFICADOR'));
      if (!key) {
        return;
      }

      rewardsByUser.set(key, {
        puntos: parseInt(row.get('PUNTOS') || '0', 10) || 0,
        instalaciones: parseInt(row.get('INSTALACIONES') || '0', 10) || 0,
        desinstalaciones: parseInt(row.get('DESINSTALACIONES') || '0', 10) || 0,
        redenciones: parseInt(row.get('REDENCIONES') || '0', 10) || 0,
        actualizadoEn: row.get('ACTUALIZADO_EN') || ''
      });
    });

    let usersRows = [];
    if (authData.tipo === 'administrador') {
      if (!authData.cliente) {
        return res.status(400).json({
          success: false,
          error: 'El administrador no tiene cliente asignado'
        });
      }
      const adminClient = normalizeClient(authData.cliente || '');
      const globalUsersSheet = await getOrCreateUsersSheet(doc);
      const globalRows = await globalUsersSheet.getRows();
      usersRows = globalRows.filter(row => {
        const rowClient = normalizeClient(row.get('CLIENTE') || '');
        return !!rowClient && rowClient === adminClient;
      });
    } else {
      const globalUsersSheet = await getOrCreateUsersSheet(doc);
      usersRows = await globalUsersSheet.getRows();
    }

    const usersPoints = usersRows
      .map(row => {
        const usuario = normalizeUser(row.get('USUARIO'));
        const tipo = normalizeType(row.get('TIPO'));
        const cliente = row.get('CLIENTE') || '';
        const rewardData = rewardsByUser.get(usuario) || {
          puntos: 0,
          instalaciones: 0,
          desinstalaciones: 0,
          redenciones: 0,
          actualizadoEn: ''
        };

        return {
          usuario,
          tipo,
          cliente,
          ...rewardData
        };
      })
      .filter(item => !!item.usuario)
      .sort((a, b) => b.puntos - a.puntos);

    const payload = {
      success: true,
      data: usersPoints,
      meta: {
        scope: authData.tipo === 'administrador' ? 'cliente' : 'global',
        cliente: authData.cliente || ''
      }
    };
    setToApiCache(cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    console.error('❌ Error al obtener recompensas por usuarios:', formatErrorForLogging(error));
    if (cacheKey && isGoogleQuotaError(error)) {
      const payload = {
        success: false,
        error: 'Google API error - cuota excedida',
        details: error?.response?.data?.error?.message || error?.message || 'Quota exceeded'
      };
      setToApiCache(cacheKey, payload, API_QUOTA_ERROR_CACHE_TTL_MS);
    }
    return respondGoogleSheetsError(res, error, 'Error al obtener recompensas por usuarios');
  }
});

/**
 * GET /api/rewards
 * Obtiene saldo e historial de recompensas de un usuario
 */
app.get('/api/rewards', async (req, res) => {
  try {
    const { identifier } = req.query;
    const authUser = (req.headers['x-auth-user'] || '').toString().trim();
    const authPassword = (req.headers['x-auth-password'] || '').toString();

    if (!authUser || !authPassword) {
      return res.status(401).json({ success: false, error: 'Credenciales requeridas' });
    }

    if (!identifier) {
      return res.status(400).json({
        success: false,
        error: 'El identificador del usuario es requerido'
      });
    }

    const doc = await getGoogleSheet();

    const authData = await findUserRowByCredentials(doc, authUser, authPassword);
    if (!authData) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const authTipo = normalizeType(authData.row.get('TIPO'));
    const normalizedAuthUser = normalizeUser(authUser);
    const normalizedIdentifier = normalizeRewardIdentifier(identifier);

    // Solo admins/superadmin pueden consultar cualquier usuario; los demás solo el suyo propio
    const isAdmin = authTipo === 'super' || authTipo === 'administrador';
    if (!isAdmin && normalizeRewardIdentifier(normalizedAuthUser) !== normalizedIdentifier) {
      return res.status(403).json({ success: false, error: 'Solo puedes consultar tus propias recompensas' });
    }
    const rewardsSheet = await getOrCreateRewardsSheet(doc);
    const historySheet = await getOrCreateRewardsHistorySheet(doc);
    const rewardRow = await getRewardBalanceRow(rewardsSheet, normalizedIdentifier);
    const historyRows = await historySheet.getRows();

    const history = historyRows
      .filter(row => normalizeRewardIdentifier(row.get('IDENTIFICADOR')) === normalizedIdentifier)
      .map(row => ({
        movimiento: row.get('MOVIMIENTO') || '',
        puntos: parseInt(row.get('PUNTOS') || '0', 10) || 0,
        referencia: row.get('REFERENCIA') || '',
        serial: row.get('SERIAL') || '',
        descripcion: row.get('DESCRIPCION') || '',
        fecha: row.get('FECHA') || ''
      }))
      .reverse();

    return res.json({
      success: true,
      data: {
        reward: rewardRow ? {
          identifier: rewardRow.get('IDENTIFICADOR') || normalizedIdentifier,
          nombre: rewardRow.get('NOMBRE') || identifier,
          puntos: parseInt(rewardRow.get('PUNTOS') || '0', 10) || 0,
          instalaciones: parseInt(rewardRow.get('INSTALACIONES') || '0', 10) || 0,
          desinstalaciones: parseInt(rewardRow.get('DESINSTALACIONES') || '0', 10) || 0,
          redenciones: parseInt(rewardRow.get('REDENCIONES') || '0', 10) || 0,
          actualizadoEn: rewardRow.get('ACTUALIZADO_EN') || ''
        } : {
          identifier: normalizedIdentifier,
          nombre: identifier,
          puntos: 0,
          instalaciones: 0,
          desinstalaciones: 0,
          redenciones: 0,
          actualizadoEn: ''
        },
        history
      }
    });
  } catch (error) {
    console.error('❌ Error al obtener recompensas:', formatErrorForLogging(error));
    res.status(500).json({
      success: false,
      error: 'Error al obtener recompensas'
    });
  }
});

/**
 * POST /api/rewards/redeem
 * Redime puntos por un premio
 */
app.post('/api/rewards/redeem', async (req, res) => {
  try {
    const { identifier, points, rewardName, referencia, serial, delivery } = req.body;
    const parsedPoints = parseInt(points, 10);

    if (!identifier || !rewardName || !Number.isFinite(parsedPoints) || parsedPoints <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Identificador, premio y puntos válidos son requeridos'
      });
    }

    const deliveryObj = delivery && typeof delivery === 'object' ? delivery : null;
    const entregaNombre = deliveryObj ? (deliveryObj.fullName || '').toString().trim() : '';
    const entregaTelefono = deliveryObj ? (deliveryObj.phone || '').toString().trim() : '';
    const entregaDireccion = deliveryObj ? (deliveryObj.address || '').toString().trim() : '';
    const entregaCiudad = deliveryObj ? (deliveryObj.city || '').toString().trim() : '';
    const entregaNotas = deliveryObj ? (deliveryObj.notes || '').toString().trim() : '';

    if (!entregaNombre || !entregaTelefono || !entregaDireccion || !entregaCiudad) {
      return res.status(400).json({
        success: false,
        error: 'Los datos de entrega son requeridos para confirmar el canje'
      });
    }

    const doc = await getGoogleSheet();
    // Nota: el 3er parámetro es el nombre a mostrar del usuario en la hoja de recompensas.
    // No debe ser el nombre del premio; dejamos vacío para conservar el nombre existente.
    const result = await redeemRewardPoints(doc, identifier, '', parsedPoints, {
      referencia,
      serial,
      descripcion: `Canje de ${rewardName}`,
      entregaNombre,
      entregaTelefono,
      entregaDireccion,
      entregaCiudad,
      entregaNotas
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Crear alertas para admin del cliente y superadmin (no bloquear el canje si falla)
    try {
      await createRewardRedemptionAlerts(doc, {
        identifier,
        rewardName,
        points: parsedPoints
      });
    } catch (error) {
      console.warn('⚠️ No se pudieron crear alertas de canje:', formatErrorForLogging(error));
    }

    return res.json({
      success: true,
      message: 'Premio redimido correctamente',
      data: result.reward
    });
  } catch (error) {
    console.error('❌ Error al redimir recompensas:', formatErrorForLogging(error));
    res.status(500).json({
      success: false,
      error: 'Error al redimir recompensas'
    });
  }
});

/**
 * GET /api/alerts
 * Retorna alertas no leídas para admin/superadmin y las marca como leídas.
 * Requiere headers: x-auth-user, x-auth-password
 */
app.get('/api/alerts', async (req, res) => {
  try {
    const authUser = req.headers['x-auth-user'];
    const authPassword = req.headers['x-auth-password'];

    if (!authUser || !authPassword) {
      return res.status(401).json({
        success: false,
        error: 'Credenciales requeridas'
      });
    }

    const doc = await getGoogleSheet();
    const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
    if (!authData) {
      return res.status(403).json({
        success: false,
        error: 'No autorizado'
      });
    }

    const alertsSheet = await getOrCreateAlertsSheet(doc);
    const rows = await alertsSheet.getRows();
    const normalizedUser = normalizeUser(authUser);
    const now = new Date().toLocaleString('es-ES');

    const unreadRows = rows
      .filter(row => normalizeUser(row.get('DESTINATARIO')) === normalizedUser)
      .filter(row => ((row.get('LEIDO') || '').toString().trim().toUpperCase() !== 'SI'))
      .slice(-50);

    const alerts = unreadRows.map(row => ({
      id: row.get('ID') || '',
      message: row.get('MENSAJE') || '',
      evento: row.get('EVENTO') || '',
      cliente: row.get('CLIENTE') || '',
      fecha: row.get('FECHA') || ''
    }));

    // Marcar como leídas
    if (unreadRows.length > 0) {
      for (const row of unreadRows) {
        row.set('LEIDO', 'SI');
        row.set('LEIDO_EN', now);
        await row.save();
      }
      // Invalidate cache immediately if we changed state
      invalidateApiCacheByPrefix(cacheKey);
    }

    const payload = { success: true, data: alerts };
    setToApiCache(cacheKey, payload, 30000); // 30s cache
    console.log(`🔔 Alertas | [MISS] | Tiempo: ${Date.now() - startTime}ms`);
    return res.json(payload);
  } catch (error) {
    console.error('❌ Error al obtener alertas:', formatErrorForLogging(error));
    res.status(500).json({
      success: false,
      error: 'Error al obtener alertas'
    });
  }
});

/**
 * Ingreso masivo de productos en almacén desde formulario manual
 * POST /api/bulk-ingress
 * Headers: x-auth-user, x-auth-password
 * Body: { referencia, serialInicial, cliente, cantidad }
 */
app.post('/api/bulk-ingress', async (req, res) => {
  try {
    const authUser = (req.headers['x-auth-user'] || '').toString().trim();
    const authPassword = (req.headers['x-auth-password'] || '').toString();

    if (!authUser || !authPassword) {
      return res.status(401).json({ success: false, error: 'Credenciales requeridas' });
    }

    const doc = await getGoogleSheet();
    const auth = await findUserRowByCredentials(doc, authUser, authPassword);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const userTipo = (auth.row.get('TIPO') || '').toString().trim().toLowerCase();
    if (!['despacho', 'administrador', 'super'].includes(userTipo)) {
      return res.status(403).json({ success: false, error: 'Sin permiso para esta acción' });
    }

    const referencia = (req.body.referencia || '').toString().trim().toUpperCase();
    const serialInicial = (req.body.serialInicial || '').toString().trim();
    const cliente = (req.body.cliente || '').toString().trim().toUpperCase();
    const cantidad = parseInt(req.body.cantidad || '0', 10);

    if (!referencia || !serialInicial || !cliente || !cantidad) {
      return res.status(400).json({ success: false, error: 'Todos los campos son requeridos' });
    }
    if (cantidad < 1 || cantidad > 500) {
      return res.status(400).json({ success: false, error: 'La cantidad debe estar entre 1 y 500' });
    }

    const globalSheet = await getOrCreateRecordsSheet(doc);
    await ensureSheetHeaderRowLoaded(globalSheet);

    // Asegurar que el cliente exista en la hoja CLIENTES
    const clientsSheet = await getOrCreateClientsSheet(doc);
    const clientsRows = await clientsSheet.getRows();
    const clientExists = clientsRows.some(row =>
      (row.get('NOMBRE') || '').trim().toUpperCase() === cliente
    );
    if (!clientExists) {
      const now = new Date().toLocaleDateString('es-ES');
      await clientsSheet.addRow({ 'NOMBRE': cliente, 'FECHA_REGISTRO': now });
    }

    const clientSheet = await getOrCreateClientRecordsSheet(doc, cliente);
    await ensureSheetHeaderRowLoaded(clientSheet);

    const now = new Date();
    const fecha = now.toLocaleDateString('es-ES');
    const hora = now.toLocaleTimeString('es-ES');
    const userEmail = auth.row.get('USUARIO') || authUser;

    const results = { created: [], skipped: [], errors: [] };

    for (let i = 0; i < cantidad; i++) {
      const serial = incrementSerial(serialInicial, i);
      try {
        const existingRecord = await findExistingRecord(globalSheet, referencia, serial);
        if (existingRecord) {
          results.skipped.push({ serial, motivo: 'Ya existe' });
          continue;
        }

        const globalRows = await globalSheet.getRows();
        await globalSheet.addRow({
          'ID': globalRows.length + 1,
          'REFERENCIA': referencia,
          'SERIAL': serial,
          'ESTADO': 'EN ALMACEN',
          'CLIENTE': cliente,
          'USUARIO_DESPACHO': '',
          'USUARIO_PLANTA': userEmail,
          'USUARIO_INSTALACION': '',
          'USUARIO_DESINSTALACION': '',
          'PLACA': '',
          'KILOMETRAJE_INSTALACION': '',
          'KILOMETRAJE_DESINSTALACION': '',
          'NOMBRE_INSTALADOR': '',
          'FECHA_ALMACEN': fecha,
          'FECHA_DESPACHO': '',
          'FECHA_INSTALACION': '',
          'FECHA_DESINSTALACION': '',
          'HORA_ALMACEN': hora,
          'HORA_DESPACHO': '',
          'HORA_INSTALACION': '',
          'HORA_DESINSTALACION': ''
        });

        const clientRows = await clientSheet.getRows();
        await clientSheet.addRow({
          'ID': clientRows.length + 1,
          'REFERENCIA': referencia,
          'SERIAL': serial,
          'ESTADO': 'EN ALMACEN',
          'CLIENTE': cliente,
          'USUARIO_DESPACHO': '',
          'USUARIO_PLANTA': userEmail,
          'USUARIO_INSTALACION': '',
          'USUARIO_DESINSTALACION': '',
          'PLACA': '',
          'KILOMETRAJE_INSTALACION': '',
          'KILOMETRAJE_DESINSTALACION': '',
          'NOMBRE_INSTALADOR': '',
          'FECHA_ALMACEN': fecha,
          'FECHA_DESPACHO': '',
          'FECHA_INSTALACION': '',
          'FECHA_DESINSTALACION': '',
          'HORA_ALMACEN': hora,
          'HORA_DESPACHO': '',
          'HORA_INSTALACION': '',
          'HORA_DESINSTALACION': ''
        });

        results.created.push({ serial });
      } catch (err) {
        console.error(`Error al crear registro ${serial}:`, formatErrorForLogging(err));
        results.errors.push({ serial, motivo: err.message || 'Error desconocido' });
      }
    }

    return res.json({
      success: true,
      referencia,
      cliente,
      totalCreados: results.created.length,
      totalOmitidos: results.skipped.length,
      totalErrores: results.errors.length,
      creados: results.created,
      omitidos: results.skipped,
      errores: results.errors
    });

  } catch (error) {
    console.error('Error en ingreso masivo:', formatErrorForLogging(error));
    return res.status(500).json({
      success: false,
      error: 'Error al procesar el ingreso masivo',
      details: error.message
    });
  }
});

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({
    success: false, 
    error: 'Ruta no encontrada' 
  });
});

// Pre-calentar la conexión con Google Sheets al iniciar para evitar el ERR_STREAM_PREMATURE_CLOSE
// en el primer request real (cold start de Render).
async function warmupGoogleSheets(maxWaitMs = 60000) {
  const start = Date.now();
  let attempt = 0;
  const delays = [2000, 4000, 6000, 8000, 10000, 15000, 15000];

  while (Date.now() - start < maxWaitMs) {
    attempt += 1;
    try {
      await getGoogleSheet();
      console.log(`✅ Conexión con Google Sheets establecida (intento ${attempt}, ${Date.now() - start}ms)`);
      return true;
    } catch (err) {
      const elapsed = Date.now() - start;
      const remaining = maxWaitMs - elapsed;
      if (remaining <= 0) break;
      const delay = Math.min(delays[attempt - 1] || 15000, remaining);
      console.warn(`⏳ Google Sheets no disponible aún (intento ${attempt}), reintentando en ${delay}ms... Error: ${err?.message || err}`);
      await sleep(delay);
    }
  }

  console.error('❌ No se pudo conectar con Google Sheets al iniciar. Las peticiones intentarán conectar por su cuenta.');
  return false;
}

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`✅ Servidor ejecutándose en http://localhost:${PORT}`);
  console.log(`📊 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🚀 API lista para recibir solicitudes`);

  // Pre-warm en background — no bloquea el servidor
  warmupGoogleSheets(60000).catch(err => {
    console.error('Error inesperado en warmup de Google Sheets:', err?.message || err);
  });
});
