/**
 * Servidor Backend - QR Scanner App
 * Maneja las solicitudes del frontend y la integración con Google Sheets
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

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
app.use(bodyParser.json());

// Debug: Log de rutas
const publicPath = path.join(__dirname, 'public');
console.log('📁 Public path:', publicPath);

// Servir archivos estáticos desde public
app.use(express.static(publicPath));

// Health check para Render
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Servidor funcionando correctamente' });
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
    const sheet = await getOrCreateUsersSheet(doc);

    const normalizedUser = normalizeUser(usuario);
    const normalizedType = normalizeType(tipo);

    const userRow = await validateUserCredentials(sheet, normalizedUser, password);

    if (!userRow) {
      return res.json({ success: false, message: 'Usuario no autorizado' });
    }

    const storedType = normalizeType(userRow.get('TIPO'));

    if (storedType !== normalizedType) {
      // Permitir que superadmin ingrese por el flujo de administrador
      if (!(storedType === 'super' && normalizedType === 'administrador')) {
        return res.json({ success: false, message: 'Tipo no autorizado' });
      }
    }

    // Determinar el rol basado en el TIPO del usuario
    let role = 'user';
    if (storedType === 'super') {
      role = 'superadmin';
    } else if (storedType === 'administrador') {
      role = 'admin';
    }
    
    // Validar que los usuarios con TIPO SUPER sean los correos autorizados
    if (storedType === 'super' && !isSuperadminUser(normalizedUser)) {
      return res.json({ success: false, message: 'Usuario no autorizado como superadmin' });
    }

    return res.json({ success: true, tipo: storedType, usuario: normalizedUser, role });
  } catch (error) {
    console.error('Error al validar usuario:', error);
    res.status(500).json({ success: false, error: 'Error al validar usuario' });
  }
});

/**
 * Lista usuarios (solo superadmin)
 * GET /api/users
 */
app.get('/api/users', async (req, res) => {
  try {
    const doc = await getGoogleSheet();
    const sheet = await getOrCreateUsersSheet(doc);

    const authUser = req.headers['x-auth-user'] || '';
    const authPassword = req.headers['x-auth-password'] || '';
    const authRow = await validateUserCredentials(sheet, authUser, authPassword);

    if (!authRow || !isSuperadminUser(authUser)) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const rows = await sheet.getRows();

    const data = rows.map(row => ({
      usuario: normalizeUser(row.get('USUARIO')),
      tipo: normalizeType(row.get('TIPO')),
      cliente: row.get('CLIENTE') || ''
    }));

    res.json({ success: true, data });
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

    if (!normalizedUser || !normalizedType || !password) {
      return res.status(400).json({ success: false, message: 'Usuario, tipo y contraseña son requeridos' });
    }

    if (!['administrador', 'mecanico', 'super'].includes(normalizedType)) {
      return res.status(400).json({ success: false, message: 'Tipo inválido' });
    }
    
    // Validar que solo los correos autorizados puedan tener TIPO SUPER
    if (normalizedType === 'super' && !isSuperadminUser(normalizedUser)) {
      return res.status(400).json({ success: false, message: 'Este usuario no puede ser superadmin' });
    }

    const doc = await getGoogleSheet();
    const sheet = await getOrCreateUsersSheet(doc);

    const authRow = await validateUserCredentials(sheet, authUser, authPassword);
    if (!authRow || !isSuperadminUser(authUser)) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const rows = await sheet.getRows();
    const existingRow = rows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);

    if (existingRow) {
      existingRow.set('TIPO', normalizedType);
      existingRow.set('CONTRASEÑA', password);
      existingRow.set('CLIENTE', cliente || '');
      await existingRow.save();

      return res.json({ success: true, message: 'Usuario actualizado' });
    }

    await sheet.addRow({
      'USUARIO': normalizedUser,
      'TIPO': normalizedType,
      'CONTRASEÑA': password,
      'CLIENTE': cliente || ''
    });

    res.json({ success: true, message: 'Usuario creado' });
  } catch (error) {
    console.error('Error al crear usuario:', error);
    res.status(500).json({ success: false, error: 'Error al crear usuario' });
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
const SUPERADMIN_1_EMAIL = process.env.SUPERADMIN_1_EMAIL || '';
const SUPERADMIN_2_EMAIL = process.env.SUPERADMIN_2_EMAIL || '';

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
  
  // Si no hay encabezados, crearlos
  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow([
      'ID',
      'REFERENCIA',
      'SERIAL',
      'ESTADO',
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
      'HORA_DESINSTALACION'
    ]);
  }
}

/**
 * Inicializa la hoja de usuarios con encabezados si no existen
 * @param {Object} sheet - Hoja de Google Sheets
 */
async function initializeUsersSheet(sheet) {
  await sheet.loadHeaderRow();

  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow([
      'USUARIO',
      'TIPO',
      'CONTRASEÑA',
      'CLIENTE'
    ]);
  }
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
        'HORA_DESINSTALACION'
      ]
    });
  }

  await initializeRecordsSheet(sheet);
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

function normalizeUser(user) {
  return (user || '').trim().toLowerCase();
}

function normalizeType(type) {
  return (type || '').trim().toLowerCase();
}

function isSuperadminUser(usuario) {
  const normalizedUser = normalizeUser(usuario);
  return normalizedUser === normalizeUser(SUPERADMIN_1_EMAIL) ||
         normalizedUser === normalizeUser(SUPERADMIN_2_EMAIL);
}

async function validateUserCredentials(sheet, usuario, password) {
  const rows = await sheet.getRows();
  const normalizedUser = normalizeUser(usuario);
  const userRow = rows.find(row => normalizeUser(row.get('USUARIO')) === normalizedUser);

  if (!userRow) {
    return null;
  }

  const storedPassword = (userRow.get('CONTRASEÑA') || '').toString();
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
 * Guarda un código QR escaneado en Google Sheets
 * POST /api/save-qr
 * Body: { qrContent }
 */
app.post('/api/save-qr', async (req, res) => {
  try {
    const { qrContent, userEmail } = req.body;

    // Validación de datos
    if (!qrContent) {
      return res.status(400).json({ 
        success: false, 
        error: 'El contenido del QR es requerido' 
      });
    }

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

    // Conectar a Google Sheets
    const doc = await getGoogleSheet();
    const sheet = await getOrCreateRecordsSheet(doc);

    // Buscar si ya existe un registro con esta REFERENCIA y SERIAL
    const existingRecord = await findExistingRecord(sheet, referencia, serial);
    const now = new Date();
    const fecha = now.toLocaleDateString('es-ES');
    const hora = now.toLocaleTimeString('es-ES');

    if (existingRecord) {
      // Registro existente: determinar siguiente estado
      const currentState = existingRecord.get('ESTADO');
      
      if (currentState === 'EN ALMACEN') {
        // SEGUNDO ESCANEO: Actualizar a DESPACHADO
        existingRecord.set('ESTADO', 'DESPACHADO');
        existingRecord.set('FECHA_DESPACHO', fecha);
        existingRecord.set('HORA_DESPACHO', hora);
        await existingRecord.save();

        return res.json({ 
          success: true, 
          action: 'dispatched',
          message: '🚚 Producto marcado como DESPACHADO',
          data: {
            id: existingRecord.get('ID'),
            referencia,
            serial,
            estado: 'DESPACHADO',
            fechaAlmacen: existingRecord.get('FECHA_ALMACEN'),
            fechaDespacho: fecha
          }
        });
      } else if (currentState === 'DESPACHADO') {
        // TERCER ESCANEO: Actualizar a INSTALADO
        existingRecord.set('ESTADO', 'INSTALADO');
        existingRecord.set('USUARIO_INSTALACION', userEmail || '');
        existingRecord.set('FECHA_INSTALACION', fecha);
        existingRecord.set('HORA_INSTALACION', hora);
        await existingRecord.save();

        return res.json({ 
          success: true, 
          action: 'installed',
          message: '🔧 Producto marcado como INSTALADO',
          data: {
            id: existingRecord.get('ID'),
            referencia,
            serial,
            estado: 'INSTALADO',
            fechaAlmacen: existingRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingRecord.get('FECHA_DESPACHO'),
            fechaInstalacion: fecha,
            usuarioInstalacion: userEmail
          }
        });
      } else if (currentState === 'INSTALADO') {
        // CUARTO ESCANEO: Actualizar a DESINSTALADO
        existingRecord.set('ESTADO', 'DESINSTALADO');
        existingRecord.set('USUARIO_DESINSTALACION', userEmail || '');
        existingRecord.set('FECHA_DESINSTALACION', fecha);
        existingRecord.set('HORA_DESINSTALACION', hora);
        await existingRecord.save();

        return res.json({ 
          success: true, 
          action: 'uninstalled',
          message: '📤 Producto marcado como DESINSTALADO',
          data: {
            id: existingRecord.get('ID'),
            referencia,
            serial,
            estado: 'DESINSTALADO',
            fechaAlmacen: existingRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingRecord.get('FECHA_DESPACHO'),
            fechaInstalacion: existingRecord.get('FECHA_INSTALACION'),
            fechaDesinstalacion: fecha,
            usuarioDesinstalacion: userEmail
          }
        });
      } else {
        // Ya fue DESINSTALADO, no permitir más escaneos
        return res.json({ 
          success: true, 
          action: 'already_completed',
          message: '⚠️ Este producto ya completó todo el ciclo (DESINSTALADO)',
          data: {
            referencia,
            serial,
            estado: currentState,
            fechaAlmacen: existingRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingRecord.get('FECHA_DESPACHO'),
            fechaInstalacion: existingRecord.get('FECHA_INSTALACION'),
            fechaDesinstalacion: existingRecord.get('FECHA_DESINSTALACION')
          }
        });
      }
    } else {
      // PRIMER ESCANEO: Crear nuevo registro EN ALMACEN
      const rows = await sheet.getRows();
      const nextId = rows.length + 1;

      await sheet.addRow({
        'ID': nextId,
        'REFERENCIA': referencia,
        'SERIAL': serial,
        'ESTADO': 'EN ALMACEN',
        'USUARIO_PLANTA': userEmail || '',
        'USUARIO_INSTALACION': '',
        'USUARIO_DESINSTALACION': '',
        'FECHA_ALMACEN': fecha,
        'FECHA_DESPACHO': '',
        'FECHA_INSTALACION': '',
        'FECHA_DESINSTALACION': '',
        'HORA_ALMACEN': hora,
        'HORA_DESPACHO': '',
        'HORA_INSTALACION': '',
        'HORA_DESINSTALACION': ''
      });

      res.json({ 
        success: true, 
        action: 'stored',
        message: '✅ Producto registrado EN ALMACEN',
        data: {
          id: nextId,
          referencia,
          serial,
          estado: 'EN ALMACEN',
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
 * GET /api/recent-scans?limit=10
 */
app.get('/api/recent-scans', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const doc = await getGoogleSheet();
    const sheet = await getOrCreateRecordsSheet(doc);

    const rows = await sheet.getRows();
    const recentRows = rows.slice(-limit).reverse();

    const data = recentRows.map(row => ({
      id: row.get('ID'),
      referencia: row.get('REFERENCIA'),
      serial: row.get('SERIAL'),
      estado: row.get('ESTADO'),
      usuarioPlanta: row.get('USUARIO_PLANTA'),
      usuarioInstalacion: row.get('USUARIO_INSTALACION'),
      usuarioDesinstalacion: row.get('USUARIO_DESINSTALACION'),
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
    const doc = await getGoogleSheet();
    const sheet = await getOrCreateRecordsSheet(doc);

    const rows = await sheet.getRows();
    const today = new Date().toLocaleDateString('es-ES');

    const stats = {
      total: rows.length,
      enAlmacen: 0,
      despachados: 0,
      instalados: 0,
      desinstalados: 0,
      today: 0
    };

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
      
      if (row.get('FECHA_ALMACEN') === today || row.get('FECHA_DESPACHO') === today || 
          row.get('FECHA_INSTALACION') === today || row.get('FECHA_DESINSTALACION') === today) {
        stats.today++;
      }
    });

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
