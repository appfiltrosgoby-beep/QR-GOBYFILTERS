/**
 * Servidor Backend - QR Scanner App
 * Maneja las solicitudes del frontend y la integración con Google Sheets
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Validar variables de entorno críticas
const requiredEnvVars = ['GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SPREADSHEET_ID'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.warn('⚠️ ADVERTENCIA: Variables de entorno faltantes:', missingEnvVars);
  console.warn('⚠️ El servidor se iniciará pero las rutas de Google Sheets fallarán.');
  console.warn('⚠️ Por favor, configura estas variables en tu archivo .env o en Render');
}

const app = express();
const PORT = process.env.PORT || 3000;
const path = require('path');

// Middlewares
app.use(cors());
app.use(compression()); // Comprimir respuestas
app.use(bodyParser.json());

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

// Health check para Render
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Servidor funcionando correctamente' });
});

let mailTransport = null;

function getSmtpConfig() {
  const host = (process.env.SMTP_HOST || '').toString().trim();
  const port = Number.parseInt((process.env.SMTP_PORT || '').toString().trim() || '587', 10);
  const user = (process.env.SMTP_USER || '').toString().trim();
  const pass = (process.env.SMTP_PASS || '').toString();
  const from = (process.env.SMTP_FROM || user || '').toString().trim();

  const secureRaw = (process.env.SMTP_SECURE || '').toString().trim().toLowerCase();
  const secure = secureRaw ? secureRaw === 'true' : port === 465;

  return { host, port, user, pass, from, secure };
}

function assertMailConfigured() {
  const { host, port, user, pass, from } = getSmtpConfig();
  const missing = [];
  if (!host) missing.push('SMTP_HOST');
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
  const { host, port, user, pass, secure } = getSmtpConfig();

  mailTransport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });

  return mailTransport;
}

async function sendForgotPasswordConfirmationEmail({ toEmail, displayName, requestId, requestIp, userAgent }) {
  const transport = getMailTransport();
  const { from } = getSmtpConfig();

  const safeName = (displayName || '').toString().trim() || 'Usuario';
  const now = new Date();

  const subject = 'Confirmación de solicitud de restablecimiento de contraseña';
  const text = [
    `Hola ${safeName},`,
    '',
    'Recibimos una solicitud para restablecer tu contraseña en GOBY FILTERS QR.',
    'Si no fuiste tú, ignora este correo o contacta a tu administrador.',
    '',
    `ID de solicitud: ${requestId}`,
    `Fecha: ${now.toLocaleString('es-CO')}`,
    requestIp ? `IP: ${requestIp}` : null,
    userAgent ? `Navegador: ${userAgent}` : null
  ].filter(Boolean).join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.45;">
      <p>Hola <strong>${escapeHtml(safeName)}</strong>,</p>
      <p>Recibimos una solicitud para restablecer tu contraseña en <strong>GOBY FILTERS QR</strong>.</p>
      <p>Si no fuiste tú, ignora este correo o contacta a tu administrador.</p>
      <hr/>
      <p style="margin: 0;"><strong>ID de solicitud:</strong> ${escapeHtml(requestId)}</p>
      <p style="margin: 0;"><strong>Fecha:</strong> ${escapeHtml(now.toLocaleString('es-CO'))}</p>
      ${requestIp ? `<p style="margin: 0;"><strong>IP:</strong> ${escapeHtml(requestIp)}</p>` : ''}
      ${userAgent ? `<p style="margin: 0;"><strong>Navegador:</strong> ${escapeHtml(userAgent)}</p>` : ''}
    </div>
  `;

  await transport.sendMail({
    from,
    to: toEmail,
    subject,
    text,
    html
  });
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
    console.error('Error en /api/contact-request:', error);
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
    console.error('Error al validar usuario:', error);
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
        requestId,
        requestIp,
        userAgent
      });
    } catch (mailError) {
      console.error('Error enviando correo de forgot-password:', mailError);
      return res.status(500).json({ success: false, message: 'No se pudo enviar el correo de confirmación. Intenta más tarde.' });
    }

    return res.json(genericResponse);
  } catch (error) {
    console.error('Error en /api/forgot-password:', error);
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

  const emailMatches = [];
  const nameMatches = [];

  const globalSheet = await getOrCreateUsersSheet(doc);
  const globalRows = await globalSheet.getRows();
  for (const row of globalRows) {
    if (normalizeUser(row.get('USUARIO')) === normalizedUser) {
      emailMatches.push({ sheet: globalSheet, row });
    }
    if (normalizePersonNameForMatch(row.get('NOMBRE') || '') === normalizedName) {
      nameMatches.push({ sheet: globalSheet, row });
    }
  }

  await doc.loadInfo();
  for (const sheet of doc.sheetsByIndex) {
    if (!sheet.title.endsWith('_USUARIOS')) continue;
    const rows = await sheet.getRows();
    for (const row of rows) {
      if (normalizeUser(row.get('USUARIO')) === normalizedUser) {
        emailMatches.push({ sheet, row });
      }
      if (normalizePersonNameForMatch(row.get('NOMBRE') || '') === normalizedName) {
        nameMatches.push({ sheet, row });
      }
    }
  }

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
 * Crea usuario en hoja global USUARIOS con cliente asociado.
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
    if (!matchedClientRow) {
      return res.status(400).json({
        success: false,
        message: `Empresa/cliente no encontrado: ${normalizedClientInput}`
      });
    }
    const canonicalClientName = (matchedClientRow.get('NOMBRE') || '').toString().trim() || normalizedClientInput;

    const globalSheet = await getOrCreateUsersSheet(doc);

    // Validar duplicado en hoja global
    const globalRows = await globalSheet.getRows();
    const existsGlobal = globalRows.some(row => normalizeUser(row.get('USUARIO')) === normalizedEmail);
    if (existsGlobal) {
      return res.status(409).json({ success: false, message: 'El usuario ya existe' });
    }

    // Validar duplicado en hojas por cliente (si existen)
    await doc.loadInfo();
    for (const sheet of doc.sheetsByIndex) {
      if (!sheet.title.endsWith('_USUARIOS')) continue;
      const rows = await sheet.getRows();
      const exists = rows.some(row => normalizeUser(row.get('USUARIO')) === normalizedEmail);
      if (exists) {
        return res.status(409).json({ success: false, message: 'El usuario ya existe' });
      }
    }

    await globalSheet.addRow({
      'NOMBRE': normalizedName,
      'TELEFONO': normalizedPhone,
      'USUARIO': normalizedEmail,
      'TIPO': normalizedTipo,
      'CONTRASEÑA': password,
      'CLIENTE': canonicalClientName
    });

    return res.json({ success: true, message: 'Usuario registrado correctamente' });
  } catch (error) {
    console.error('Error al registrar usuario:', error);
    return res.status(500).json({ success: false, message: 'Error al registrar usuario' });
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
    console.error('Error al obtener perfil:', error);
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
    console.error('Error al actualizar perfil:', error);
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
    const globalSheet = await getOrCreateUsersSheet(doc);

    // Calcular escaneos por usuario desde la hoja REGISTROS global.
    // Un "escaneo" cuenta por etapa con fecha (almacén, despacho, instalación, desinstalación).
    const countsByUser = Object.create(null);
    const recordsSheet = await getOrCreateRecordsSheet(doc);
    let recordRows = await recordsSheet.getRows();
    if (authTipo !== 'super' && authCliente) {
      const normalizedAuthClient = normalizeClientForMatch(authCliente);
      recordRows = recordRows.filter(row => normalizeClientForMatch(row.get('CLIENTE') || '') === normalizedAuthClient);
    }
    for (const row of recordRows) {
      accumulateUserScanCountsFromRecordRow(row, countsByUser);
    }

    await doc.loadInfo();
    const allUsers = [];
    
    if (authTipo === 'super') {
      // Superadmin solo ve usuarios de la hoja global USUARIOS
      const globalRows = await globalSheet.getRows();
      for (const row of globalRows) {
        const userValue = normalizeUser(row.get('USUARIO'));
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
      const globalRows = await globalSheet.getRows();
      const rows = globalRows.filter(row => {
        const rowClient = normalizeClientForMatch(row.get('CLIENTE') || '');
        return !!rowClient && rowClient === normalizedAuthClient;
      });
      for (const row of rows) {
        const userValue = normalizeUser(row.get('USUARIO'));
        allUsers.push({
          usuario: userValue,
          tipo: normalizeType(row.get('TIPO')),
          cliente: row.get('CLIENTE') || '',
          escaneos: countsByUser[userValue] || 0
        });
      }
    }

    res.json({ success: true, data: allUsers });
  } catch (error) {
    console.error('Error al listar usuarios:', error);
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
    console.error('Error al crear usuario:', error);
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
        await doc.loadInfo();
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
      console.error('Error al eliminar usuario:', error);
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
      await doc.loadInfo();
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
      console.error('Error al actualizar usuario:', error);
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

const RECORDS_SHEET_TITLE = 'REGISTROS';
const USERS_SHEET_TITLE = 'USUARIOS';
const REWARDS_SHEET_TITLE = 'RECOMPENSAS';
const REWARDS_HISTORY_SHEET_TITLE = 'RECOMPENSAS_HISTORIAL';
const ALERTS_SHEET_TITLE = 'ALERTAS';
const CONTACT_REQUESTS_SHEET_TITLE = 'SOLICITUDES';
const SUPERADMIN_1_EMAIL = process.env.SUPERADMIN_1_EMAIL || '';
const SUPERADMIN_2_EMAIL = process.env.SUPERADMIN_2_EMAIL || '';

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

/**
 * Inicializa y autentica la conexión con Google Sheets
 * @returns {GoogleSpreadsheet} Documento de Google Sheets autenticado
 */
async function getGoogleSheet() {
  try {
    // Validar variables de entorno
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_SPREADSHEET_ID) {
      throw new Error('Variables de entorno de Google Sheets no configuradas');
    }

    // Configuración de autenticación JWT
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: SCOPES,
    });

    // Conectar al documento
    const doc = new GoogleSpreadsheet(
      process.env.GOOGLE_SPREADSHEET_ID,
      serviceAccountAuth
    );

    await doc.loadInfo();
    return doc;
  } catch (error) {
    console.error('Error al conectar con Google Sheets:', error);
    throw error;
  }
}

/**
 * Inicializa la hoja de cálculo con encabezados si no existen
 * @param {Object} sheet - Hoja de Google Sheets
 */
async function initializeRecordsSheet(sheet) {
  await sheet.loadHeaderRow();
  
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
      await sheet.loadHeaderRow(); // Recargar headers
    }
  }
}

/**
 * Inicializa la hoja de usuarios con encabezados si no existen
 * @param {Object} sheet - Hoja de Google Sheets
 */
async function initializeUsersSheet(sheet) {
  await sheet.loadHeaderRow();

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
    await sheet.loadHeaderRow();
  }
}

async function initializeContactRequestsSheet(sheet) {
  await sheet.loadHeaderRow();

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
    await sheet.loadHeaderRow();
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

  await sheet.loadHeaderRow();
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

async function initializeRewardsSheet(sheet) {
  await sheet.loadHeaderRow();

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
    await sheet.loadHeaderRow();
  }
}

async function initializeRewardsHistorySheet(sheet) {
  await sheet.loadHeaderRow();

  const requiredHeaders = [
    'IDENTIFICADOR',
    'MOVIMIENTO',
    'PUNTOS',
    'REFERENCIA',
    'SERIAL',
    'DESCRIPCION',
    'FECHA'
  ];

  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow(requiredHeaders);
    return;
  }

  const missingHeaders = requiredHeaders.filter(header => !sheet.headerValues.includes(header));
  if (missingHeaders.length > 0) {
    await sheet.setHeaderRow([...sheet.headerValues, ...missingHeaders]);
    await sheet.loadHeaderRow();
  }
}

async function initializeAlertsSheet(sheet) {
  await sheet.loadHeaderRow();

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
    await sheet.loadHeaderRow();
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
        'FECHA'
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

  await doc.loadInfo();
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
    'FECHA': now
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

  await doc.loadInfo();
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

  await sheet.loadHeaderRow();
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
  await doc.loadInfo();
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

// ============================================
// RUTAS DE LA API
// ============================================

/**
 * Ruta de prueba - Verifica que el servidor está funcionando
 */
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Servidor funcionando correctamente',
    timestamp: new Date().toISOString()
  });
});

/**
 * Obtiene lista de clientes
 * GET /api/clients
 */
app.get('/api/clients', async (req, res) => {
  try {
    const doc = await getGoogleSheet();
    const sheet = await getOrCreateClientsSheet(doc);
    const rows = await sheet.getRows();

    const clients = rows.map(row => ({
      nombre: row.get('NOMBRE') || ''
    })).filter(c => c.nombre.trim() !== '');

    res.json({ 
      success: true, 
      data: clients
    });
  } catch (error) {
    console.error('Error al obtener clientes:', error);
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
    await doc.loadInfo();
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
    console.error('Error al registrar cliente:', error);
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
    
    await doc.loadInfo();
    
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
    console.error('Error al actualizar cliente:', error);
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
    await doc.loadInfo();
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
    console.error('Error al eliminar cliente:', error);
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
    await globalSheet.loadHeaderRow();
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
        await currentClientSheet.loadHeaderRow(); // Asegurar headers cargados
        existingCurrentClientRecord = await findExistingRecord(currentClientSheet, referencia, serial);
      }
      
      // Obtener la hoja del cliente original (si es diferente)
      let originalClientSheet = null;
      let existingOriginalClientRecord = null;
      if (recordClient && recordClient !== normalizedUserClient && recordClient !== effectiveClient) {
        originalClientSheet = await getOrCreateClientRecordsSheet(doc, recordClient);
        await originalClientSheet.loadHeaderRow(); // Asegurar headers cargados
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
        await clientSheet.loadHeaderRow();
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
    console.error('Error al guardar QR:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error al guardar en Google Sheets',
      details: error.message 
    });
  }
});

/**
 * Obtiene los últimos registros de QR escaneados
 * GET /api/recent-scans?limit=10&superadmin=true
 */
app.get('/api/recent-scans', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const cliente = req.query.cliente || '';
    const isSuperadminRequest = req.query.superadmin === 'true';
    const userEmail = req.query.userEmail || '';
    
    const doc = await getGoogleSheet();
    let rows = [];

    if (cliente) {
      // Filtrar por cliente específico
      const sheet = await getOrCreateClientRecordsSheet(doc, cliente);
      rows = await sheet.getRows();
    } else if (isSuperadminRequest) {
      // Superadmin: obtener registros de la hoja global REGISTROS (no cargar todos los clientes)
      // Esto evita exceder límites de API al no iterar por todas las hojas
      const globalSheet = await getOrCreateRecordsSheet(doc);
      rows = await globalSheet.getRows();
    } else {
      // Usuario regular: obtener registros globales
      const sheet = await getOrCreateRecordsSheet(doc);
      rows = await sheet.getRows();
    }

    if (userEmail && !isSuperadminRequest && !cliente) {
      rows = rows.filter(row => isUserInRecord(row, userEmail));
    }

    const recentRows = rows.slice(-limit).reverse();

    const data = recentRows.map(row => ({
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
    }));

    res.json({ success: true, data });

  } catch (error) {
    console.error('Error al obtener registros:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error al obtener registros',
      details: error.message 
    });
  }
});

/**
 * Obtiene estadísticas de escaneos
 * GET /api/stats
 */
app.get('/api/stats', async (req, res) => {
  try {
    const cliente = req.query.cliente || '';
    const userEmail = req.query.userEmail || '';
    const normalizedUser = normalizeUser(userEmail);
    
    const doc = await getGoogleSheet();

    let rows = [];

    if (cliente) {
      // Para stats filtradas por cliente, usar la hoja del cliente (fuente por-cliente)
      const clientSheet = await getOrCreateClientRecordsSheet(doc, cliente);
      rows = await clientSheet.getRows();
      console.log(`📊 Stats API: Registros en hoja cliente "${cliente}": ${rows.length}`);
    } else {
      // Default: hoja REGISTROS global
      const globalSheet = await getOrCreateRecordsSheet(doc);
      rows = await globalSheet.getRows();
      console.log(`📊 Stats API: Total de registros en REGISTROS: ${rows.length}`);

      if (userEmail) {
        rows = rows.filter(row => isUserInRecord(row, userEmail));
        console.log(`👤 Filtrado por usuario "${userEmail}": ${rows.length} registros`);
      }
    }
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

        // Si se pidió filtrado por usuario, contar solo eventos hechos por ese usuario.
        if (normalizedUser) {
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
    res.json({ success: true, data: stats });

  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error al obtener estadísticas',
      details: error.message 
    });
  }
});

/**
 * Obtiene proyecciones de pedidos y duración de filtros
 * GET /api/projections
 */
app.get('/api/projections', async (req, res) => {
  try {
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

    // PASO 1: Calcular duración promedio por (cliente, referencia) usando registros desinstalados
    const durationsByClientRef = {}; // Key: "cliente|referencia", Value: array de duraciones en días
    
    allRows.forEach(row => {
      const estado = row.get('ESTADO');
      const cliente = row.get('CLIENTE') || 'Sin Cliente';
      const referencia = row.get('REFERENCIA');
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

    // PASO 2: Para cada filtro instalado, calcular fecha estimada de reemplazo
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
          const key = `${cliente}|${referencia}`;
          
          // Obtener duración promedio para esta (cliente, referencia), default 90 días si no hay histórico
          const avgDuration = avgDurationByClientRef[key] || 90;

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

    res.json({
      success: true,
      data: {
        nextReplacements: nextReplacements,
        stats: {
          avgDaysDuration,
          totalFiltersAnalyzed: allDurations.length,
          nextReplacementsCount: nextReplacements.length
        }
      }
    });

  } catch (error) {
    console.error('Error al obtener proyecciones:', error);
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
 * POST /api/save-installer
 * Guarda el nombre del instalador en la hoja REGISTROS
 */
app.post('/api/save-installer', async (req, res) => {
  try {
    const { installerName } = req.body;

    if (!installerName || typeof installerName !== 'string' || !installerName.trim()) {
      return res.status(400).json({
        success: false,
        error: 'El nombre del instalador es requerido'
      });
    }

    // Conectar con Google Sheets
    const auth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
      ],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
    await doc.loadInfo();

    // Obtener la hoja REGISTROS
    const registrosSheet = await getOrCreateRecordsSheet(doc);
    await registrosSheet.loadHeaderRow();

    // Agregar fila con el nombre del instalador y timestamp
    const timestamp = new Date().toLocaleString('es-ES', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    await registrosSheet.addRow({
      'NOMBRE_INSTALADOR': installerName.trim(),
      'FECHA_ALMACEN': timestamp.split(' ')[0],
      'HORA_ALMACEN': timestamp.split(' ')[1]
    });

    console.log(`✅ Nombre del instalador guardado: ${installerName}`);
    res.json({
      success: true,
      message: 'Nombre del instalador guardado correctamente',
      installerName: installerName.trim()
    });

  } catch (error) {
    console.error('❌ Error al guardar el nombre del instalador:', error);
    res.status(500).json({
      success: false,
      error: 'Error al guardar el nombre del instalador'
    });
  }
});

/**
 * GET /api/rewards/users
 * Obtiene el puntaje de recompensas por usuario (vista admin/superadmin)
 */
app.get('/api/rewards/users', async (req, res) => {
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

    return res.json({
      success: true,
      data: usersPoints,
      meta: {
        scope: authData.tipo === 'administrador' ? 'cliente' : 'global',
        cliente: authData.cliente || ''
      }
    });
  } catch (error) {
    console.error('❌ Error al obtener recompensas por usuarios:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener recompensas por usuarios'
    });
  }
});

/**
 * GET /api/rewards
 * Obtiene saldo e historial de recompensas de un usuario
 */
app.get('/api/rewards', async (req, res) => {
  try {
    const { identifier } = req.query;

    if (!identifier) {
      return res.status(400).json({
        success: false,
        error: 'El identificador del usuario es requerido'
      });
    }

    const doc = await getGoogleSheet();
    const rewardsSheet = await getOrCreateRewardsSheet(doc);
    const historySheet = await getOrCreateRewardsHistorySheet(doc);
    const normalizedIdentifier = normalizeRewardIdentifier(identifier);
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
    console.error('❌ Error al obtener recompensas:', error);
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
    const { identifier, points, rewardName, referencia, serial } = req.body;
    const parsedPoints = parseInt(points, 10);

    if (!identifier || !rewardName || !Number.isFinite(parsedPoints) || parsedPoints <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Identificador, premio y puntos válidos son requeridos'
      });
    }

    const doc = await getGoogleSheet();
    // Nota: el 3er parámetro es el nombre a mostrar del usuario en la hoja de recompensas.
    // No debe ser el nombre del premio; dejamos vacío para conservar el nombre existente.
    const result = await redeemRewardPoints(doc, identifier, '', parsedPoints, {
      referencia,
      serial,
      descripcion: `Canje de ${rewardName}`
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
      console.warn('⚠️ No se pudieron crear alertas de canje:', error);
    }

    return res.json({
      success: true,
      message: 'Premio redimido correctamente',
      data: result.reward
    });
  } catch (error) {
    console.error('❌ Error al redimir recompensas:', error);
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
    for (const row of unreadRows) {
      row.set('LEIDO', 'SI');
      row.set('LEIDO_EN', now);
      await row.save();
    }

    return res.json({ success: true, data: alerts });
  } catch (error) {
    console.error('❌ Error al obtener alertas:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener alertas'
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

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`✅ Servidor ejecutándose en http://localhost:${PORT}`);
  console.log(`📊 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🚀 API lista para recibir solicitudes`);
});
