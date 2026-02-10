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
    const normalizedUser = normalizeUser(usuario);
    const normalizedType = normalizeType(tipo);

    // Buscar usuario en hoja global (para superadmins)
    let userRow = null;
    let userClient = '';
    const globalSheet = await getOrCreateUsersSheet(doc);
    userRow = await validateUserCredentials(globalSheet, normalizedUser, password);
    
    if (userRow) {
      userClient = userRow.get('CLIENTE') || '';
    } else {
      // Buscar en todas las hojas de clientes
      await doc.loadInfo();
      for (const sheet of doc.sheetsByIndex) {
        if (sheet.title.endsWith('_USUARIOS')) {
          userRow = await validateUserCredentials(sheet, normalizedUser, password);
          if (userRow) {
            userClient = userRow.get('CLIENTE') || '';
            break;
          }
        }
      }
    }

    if (!userRow) {
      return res.json({ success: false, message: 'Usuario no autorizado' });
    }

    const storedType = normalizeType(userRow.get('TIPO'));

    // Validar tipo de usuario según el flujo de login
    if (normalizedType === 'user') {
      // Flujo "usuarios": acepta mecánico y planta
      if (!['mecanico', 'planta'].includes(storedType)) {
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
    }
    // planta es un tipo de usuario que inicia sesión como 'user' (mecánico)
    
    return res.json({ 
      success: true, 
      tipo: storedType, 
      usuario: normalizedUser, 
      role,
      cliente: userClient 
    });
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

    const authUser = req.headers['x-auth-user'] || '';
    const authPassword = req.headers['x-auth-password'] || '';
    
    // Validar que el usuario autenticado sea superadmin o administrador
    const authData = await validateAdminOrSuperadminCredentials(doc, authUser, authPassword);
    if (!authData) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }

    const { tipo: authTipo, cliente: authCliente } = authData;
    const globalSheet = await getOrCreateUsersSheet(doc);

    await doc.loadInfo();
    const allUsers = [];
    
    if (authTipo === 'super') {
      // Superadmin puede ver todos los usuarios de todas las hojas
      // Agregar usuarios de la hoja global (superadmins)
      const globalRows = await globalSheet.getRows();
      for (const row of globalRows) {
        allUsers.push({
          usuario: normalizeUser(row.get('USUARIO')),
          tipo: normalizeType(row.get('TIPO')),
          cliente: row.get('CLIENTE') || ''
        });
      }
      
      // Agregar usuarios de todas las hojas de clientes
      for (const sheet of doc.sheetsByIndex) {
        if (sheet.title.endsWith('_USUARIOS') && sheet.title !== 'USUARIOS') {
          const rows = await sheet.getRows();
          for (const row of rows) {
            allUsers.push({
              usuario: normalizeUser(row.get('USUARIO')),
              tipo: normalizeType(row.get('TIPO')),
              cliente: row.get('CLIENTE') || ''
            });
          }
        }
      }
    } else {
      // Administrador solo puede ver usuarios de su cliente
      const clientSheet = await getOrCreateClientUsersSheet(doc, authCliente);
      const rows = await clientSheet.getRows();
      for (const row of rows) {
        allUsers.push({
          usuario: normalizeUser(row.get('USUARIO')),
          tipo: normalizeType(row.get('TIPO')),
          cliente: row.get('CLIENTE') || ''
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

    if (!['administrador', 'mecanico', 'planta', 'super'].includes(normalizedType)) {
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
      if (normalizedClient !== authCliente) {
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

      // Validaciones para administrador
      if (authTipo === 'administrador') {
        // Admin no puede eliminar superadmins
        if (userTipo === 'super') {
          return res.status(403).json({ success: false, message: 'No autorizado para eliminar superadmins' });
        }
        // Admin solo puede eliminar usuarios de su cliente
        if (userCliente !== authCliente) {
          return res.status(403).json({ success: false, message: 'Solo puede eliminar usuarios de su cliente' });
        }
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
        if (normalizedClient !== authCliente) {
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
  
  const requiredHeaders = [
    'ID',
    'REFERENCIA',
    'SERIAL',
    'ESTADO',
    'CLIENTE',
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
  ];
  
  // Si no hay encabezados, crearlos
  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow(requiredHeaders);
  } else {
    // Verificar si falta la columna CLIENTE y agregarla
    if (!sheet.headerValues.includes('CLIENTE')) {
      console.log('⚠️ Agregando columna CLIENTE a hoja:', sheet.title);
      await sheet.setHeaderRow([...sheet.headerValues.slice(0, 4), 'CLIENTE', ...sheet.headerValues.slice(4)]);
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
        'CLIENTE',
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

function normalizeClient(client) {
  return (client || '').trim().toUpperCase();
}

function isSuperadminUser(usuario) {
  const normalizedUser = normalizeUser(usuario);
  return normalizedUser === normalizeUser(SUPERADMIN_1_EMAIL) ||
         normalizedUser === normalizeUser(SUPERADMIN_2_EMAIL);
}

function isSuperadminRow(row) {
  return normalizeType(row.get('TIPO')) === 'super';
}

/**
 * Valida credenciales de administrador o superadmin y retorna el row con información
 * @param {GoogleSpreadsheet} doc
 * @param {string} usuario
 * @param {string} password
 * @returns {Promise<{row: Object, tipo: string, cliente: string} | null>}
 */
async function validateAdminOrSuperadminCredentials(doc, usuario, password) {
  const globalSheet = await getOrCreateUsersSheet(doc);
  const normalizedUser = normalizeUser(usuario);
  
  // Buscar primero en hoja global
  let userRow = await validateUserCredentials(globalSheet, normalizedUser, password);
  
  if (!userRow) {
    // Buscar en hojas de clientes
    await doc.loadInfo();
    for (const sheet of doc.sheetsByIndex) {
      if (sheet.title.endsWith('_USUARIOS')) {
        userRow = await validateUserCredentials(sheet, normalizedUser, password);
        if (userRow) {
          break;
        }
      }
    }
  }
  
  if (!userRow) {
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
  const globalSheet = await getOrCreateUsersSheet(doc);
  const normalizedUser = normalizeUser(usuario);
  
  // Buscar primero en hoja global
  let userRow = await validateUserCredentials(globalSheet, normalizedUser, password);
  
  if (!userRow) {
    // Buscar en hojas de clientes
    await doc.loadInfo();
    for (const sheet of doc.sheetsByIndex) {
      if (sheet.title.endsWith('_USUARIOS')) {
        userRow = await validateUserCredentials(sheet, normalizedUser, password);
        if (userRow) {
          break;
        }
      }
    }
  }
  
  // Verificar que sea superadmin
  if (!userRow || !isSuperadminRow(userRow)) {
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
  
  let sheet = doc.sheetsByTitle[sheetTitle];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: sheetTitle,
      headerValues: [
        'USUARIO',
        'TIPO',
        'CONTRASEÑA',
        'CLIENTE'
      ]
    });
    console.log(`✅ Creada hoja de usuarios para cliente: ${sheetTitle}`);
  }

  await sheet.loadHeaderRow();
  return sheet;
}

/**
 * Obtiene o crea la hoja de registros de un cliente específico
 * @param {GoogleSpreadsheet} doc
 * @param {string} cliente - Nombre del cliente
 */
async function getOrCreateClientRecordsSheet(doc, cliente) {
  const normalizedClient = normalizeClient(cliente);
  const sheetTitle = `${normalizedClient}_REGISTROS`;
  
  let sheet = doc.sheetsByTitle[sheetTitle];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: sheetTitle,
      headerValues: [
        'ID',
        'REFERENCIA',
        'SERIAL',
        'ESTADO',
        'CLIENTE',
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
 * Guarda un código QR escaneado en Google Sheets
 * POST /api/save-qr
 * Body: { qrContent }
 */
app.post('/api/save-qr', async (req, res) => {
  try {
    const { qrContent, userEmail, userClient } = req.body;

    // Validación de datos
    if (!qrContent) {
      return res.status(400).json({ 
        success: false, 
        error: 'El contenido del QR es requerido' 
      });
    }

    if (!userClient) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cliente es requerido' 
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

    // Conectar a Google Sheets y obtener la hoja REGISTROS global (fuente única de verdad)
    const doc = await getGoogleSheet();
    const globalSheet = await getOrCreateRecordsSheet(doc);

    // Buscar si ya existe un registro con esta REFERENCIA y SERIAL en la hoja REGISTROS global
    const existingGlobalRecord = await findExistingRecord(globalSheet, referencia, serial);
    const now = new Date();
    const fecha = now.toLocaleDateString('es-ES');
    const hora = now.toLocaleTimeString('es-ES');

    if (existingGlobalRecord) {
      // Registro existente: determinar siguiente estado
      // La trazabilidad es por serial, independiente del usuario que escanee
      const currentState = existingGlobalRecord.get('ESTADO');
      const recordClient = existingGlobalRecord.get('CLIENTE'); // Cliente original del registro
      
      // Obtener la hoja del cliente original para sincronizar
      const clientSheet = await getOrCreateClientRecordsSheet(doc, recordClient);
      const existingClientRecord = await findExistingRecord(clientSheet, referencia, serial);
      
      if (currentState === 'EN ALMACEN') {
        // SEGUNDO ESCANEO: Actualizar a DESPACHADO
        existingGlobalRecord.set('ESTADO', 'DESPACHADO');
        existingGlobalRecord.set('FECHA_DESPACHO', fecha);
        existingGlobalRecord.set('HORA_DESPACHO', hora);
        await existingGlobalRecord.save();

        // Actualizar también en hoja del cliente original
        if (existingClientRecord) {
          existingClientRecord.set('ESTADO', 'DESPACHADO');
          existingClientRecord.set('FECHA_DESPACHO', fecha);
          existingClientRecord.set('HORA_DESPACHO', hora);
          await existingClientRecord.save();
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
            cliente: recordClient,
            fechaAlmacen: existingGlobalRecord.get('FECHA_ALMACEN'),
            fechaDespacho: fecha
          }
        });
      } else if (currentState === 'DESPACHADO') {
        // TERCER ESCANEO: Actualizar a INSTALADO
        existingGlobalRecord.set('ESTADO', 'INSTALADO');
        existingGlobalRecord.set('USUARIO_INSTALACION', userEmail || '');
        existingGlobalRecord.set('FECHA_INSTALACION', fecha);
        existingGlobalRecord.set('HORA_INSTALACION', hora);
        await existingGlobalRecord.save();

        // Actualizar también en hoja del cliente original
        if (existingClientRecord) {
          existingClientRecord.set('ESTADO', 'INSTALADO');
          existingClientRecord.set('USUARIO_INSTALACION', userEmail || '');
          existingClientRecord.set('FECHA_INSTALACION', fecha);
          existingClientRecord.set('HORA_INSTALACION', hora);
          await existingClientRecord.save();
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
            cliente: recordClient,
            fechaAlmacen: existingGlobalRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingGlobalRecord.get('FECHA_DESPACHO'),
            fechaInstalacion: fecha,
            usuarioInstalacion: userEmail
          }
        });
      } else if (currentState === 'INSTALADO') {
        // CUARTO ESCANEO: Actualizar a DESINSTALADO
        existingGlobalRecord.set('ESTADO', 'DESINSTALADO');
        existingGlobalRecord.set('USUARIO_DESINSTALACION', userEmail || '');
        existingGlobalRecord.set('FECHA_DESINSTALACION', fecha);
        existingGlobalRecord.set('HORA_DESINSTALACION', hora);
        await existingGlobalRecord.save();

        // Actualizar también en hoja del cliente original
        if (existingClientRecord) {
          existingClientRecord.set('ESTADO', 'DESINSTALADO');
          existingClientRecord.set('USUARIO_DESINSTALACION', userEmail || '');
          existingClientRecord.set('FECHA_DESINSTALACION', fecha);
          existingClientRecord.set('HORA_DESINSTALACION', hora);
          await existingClientRecord.save();
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
            cliente: recordClient,
            fechaAlmacen: existingGlobalRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingGlobalRecord.get('FECHA_DESPACHO'),
            fechaInstalacion: existingGlobalRecord.get('FECHA_INSTALACION'),
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
            cliente: recordClient,
            fechaAlmacen: existingGlobalRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingGlobalRecord.get('FECHA_DESPACHO'),
            fechaInstalacion: existingGlobalRecord.get('FECHA_INSTALACION'),
            fechaDesinstalacion: existingGlobalRecord.get('FECHA_DESINSTALACION')
          }
        });
      }
    } else {
      // PRIMER ESCANEO: Crear nuevo registro EN ALMACEN
      // El registro se crea en REGISTROS global y en la hoja del cliente
      const clientSheet = await getOrCreateClientRecordsSheet(doc, userClient);
      const clientRows = await clientSheet.getRows();
      const globalRows = await globalSheet.getRows();
      const nextClientId = clientRows.length + 1;
      const nextGlobalId = globalRows.length + 1;

      const newRecordData = {
        'REFERENCIA': referencia,
        'SERIAL': serial,
        'ESTADO': 'EN ALMACEN',
        'CLIENTE': userClient,
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
      };

      // Guardar en hoja global REGISTROS (fuente única de verdad)
      await globalSheet.addRow({
        'ID': nextGlobalId,
        ...newRecordData
      });

      // Guardar también en hoja del cliente
      await clientSheet.addRow({
        'ID': nextClientId,
        ...newRecordData
      });

      res.json({ 
        success: true, 
        action: 'stored',
        message: '✅ Producto registrado EN ALMACEN',
        data: {
          id: nextGlobalId,
          referencia,
          serial,
          estado: 'EN ALMACEN',
          cliente: userClient,
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
    
    const doc = await getGoogleSheet();
    let recentRows = [];

    if (cliente) {
      // Filtrar por cliente específico
      const sheet = await getOrCreateClientRecordsSheet(doc, cliente);
      const rows = await sheet.getRows();
      recentRows = rows.slice(-limit).reverse();
    } else if (isSuperadminRequest) {
      // Superadmin: obtener registros de TODOS los clientes
      await doc.loadInfo();
      const allRows = [];
      
      // Obtener registros de la hoja global REGISTROS
      const globalSheet = await getOrCreateRecordsSheet(doc);
      const globalRows = await globalSheet.getRows();
      allRows.push(...globalRows);
      
      // Obtener registros de las hojas de clientes
      for (const sheet of doc.sheetsByIndex) {
        if (sheet.title.endsWith('_REGISTROS') && sheet.title !== 'REGISTROS') {
          const rows = await sheet.getRows();
          allRows.push(...rows);
        }
      }
      
      // Ordenar por ID descendente y tomar los últimos limit
      recentRows = allRows.sort((a, b) => {
        const idA = parseInt(a.get('ID')) || 0;
        const idB = parseInt(b.get('ID')) || 0;
        return idB - idA;
      }).slice(0, limit);
    } else {
      // Usuario regular: obtener registros de su hoja de cliente
      const sheet = await getOrCreateRecordsSheet(doc);
      const rows = await sheet.getRows();
      recentRows = rows.slice(-limit).reverse();
    }

    const data = recentRows.map(row => ({
      id: row.get('ID'),
      referencia: row.get('REFERENCIA'),
      serial: row.get('SERIAL'),
      estado: row.get('ESTADO'),
      cliente: row.get('CLIENTE'),
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
    const cliente = req.query.cliente || '';
    
    const doc = await getGoogleSheet();
    let sheet;
    
    if (cliente) {
      sheet = await getOrCreateClientRecordsSheet(doc, cliente);
    } else {
      sheet = await getOrCreateRecordsSheet(doc);
    }

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
