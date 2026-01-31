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

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Configuración de Google Sheets
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

/**
 * Inicializa y autentica la conexión con Google Sheets
 * @returns {GoogleSpreadsheet} Documento de Google Sheets autenticado
 */
async function getGoogleSheet() {
  try {
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
async function initializeSheet(sheet) {
  await sheet.loadHeaderRow();
  
  // Si no hay encabezados, crearlos
  if (!sheet.headerValues || sheet.headerValues.length === 0) {
    await sheet.setHeaderRow([
      'ID',
      'REFERENCIA',
      'SERIAL',
      'ESTADO',
      'FECHA_ALMACEN',
      'FECHA_DESPACHO',
      'HORA_ALMACEN',
      'HORA_DESPACHO'
    ]);
  }
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
    const { qrContent } = req.body;

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
      return res.status(400).json({ 
        success: false, 
        error: 'Formato de QR inválido. Use: REFERENCIA|SERIAL' 
      });
    }

    const { referencia, serial } = parsedData;

    // Conectar a Google Sheets
    const doc = await getGoogleSheet();
    let sheet = doc.sheetsByIndex[0];

    // Si no existe la hoja, crearla
    if (!sheet) {
      sheet = await doc.addSheet({ 
        title: 'Escaneos QR',
        headerValues: [
          'ID',
          'REFERENCIA',
          'SERIAL',
          'ESTADO',
          'FECHA_ALMACEN',
          'FECHA_DESPACHO',
          'HORA_ALMACEN',
          'HORA_DESPACHO'
        ]
      });
    }

    await initializeSheet(sheet);

    // Buscar si ya existe un registro con esta REFERENCIA y SERIAL
    const existingRecord = await findExistingRecord(sheet, referencia, serial);
    const now = new Date();
    const fecha = now.toLocaleDateString('es-ES');
    const hora = now.toLocaleTimeString('es-ES');

    if (existingRecord) {
      // SEGUNDO ESCANEO: Actualizar a DESPACHADO
      const currentState = existingRecord.get('ESTADO');
      
      if (currentState === 'DESPACHADO') {
        return res.json({ 
          success: true, 
          action: 'already_dispatched',
          message: '⚠️ Este producto ya fue DESPACHADO anteriormente',
          data: {
            referencia,
            serial,
            estado: currentState,
            fechaAlmacen: existingRecord.get('FECHA_ALMACEN'),
            fechaDespacho: existingRecord.get('FECHA_DESPACHO')
          }
        });
      }

      // Actualizar estado a DESPACHADO
      existingRecord.set('ESTADO', 'DESPACHADO');
      existingRecord.set('FECHA_DESPACHO', fecha);
      existingRecord.set('HORA_DESPACHO', hora);
      await existingRecord.save();

      res.json({ 
        success: true, 
        action: 'dispatched',
        message: '📦 Producto marcado como DESPACHADO',
        data: {
          id: existingRecord.get('ID'),
          referencia,
          serial,
          estado: 'DESPACHADO',
          fechaAlmacen: existingRecord.get('FECHA_ALMACEN'),
          fechaDespacho: fecha
        }
      });

    } else {
      // PRIMER ESCANEO: Crear nuevo registro EN ALMACEN
      const rows = await sheet.getRows();
      const nextId = rows.length + 1;

      await sheet.addRow({
        'ID': nextId,
        'REFERENCIA': referencia,
        'SERIAL': serial,
        'ESTADO': 'EN ALMACEN',
        'FECHA_ALMACEN': fecha,
        'FECHA_DESPACHO': '',
        'HORA_ALMACEN': hora,
        'HORA_DESPACHO': ''
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
    const sheet = doc.sheetsByIndex[0];
    
    if (!sheet) {
      return res.json({ success: true, data: [] });
    }

    const rows = await sheet.getRows();
    const recentRows = rows.slice(-limit).reverse();

    const data = recentRows.map(row => ({
      id: row.get('ID'),
      referencia: row.get('REFERENCIA'),
      serial: row.get('SERIAL'),
      estado: row.get('ESTADO'),
      fechaAlmacen: row.get('FECHA_ALMACEN'),
      fechaDespacho: row.get('FECHA_DESPACHO'),
      horaAlmacen: row.get('HORA_ALMACEN'),
      horaDespacho: row.get('HORA_DESPACHO')
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
    const sheet = doc.sheetsByIndex[0];
    
    if (!sheet) {
      return res.json({ 
        success: true, 
        data: { 
          total: 0, 
          enAlmacen: 0, 
          despachados: 0,
          today: 0 
        } 
      });
    }

    const rows = await sheet.getRows();
    const today = new Date().toLocaleDateString('es-ES');

    const stats = {
      total: rows.length,
      enAlmacen: 0,
      despachados: 0,
      today: 0
    };

    rows.forEach(row => {
      const estado = row.get('ESTADO');
      
      if (estado === 'EN ALMACEN') {
        stats.enAlmacen++;
      } else if (estado === 'DESPACHADO') {
        stats.despachados++;
      }
      
      if (row.get('FECHA_ALMACEN') === today || row.get('FECHA_DESPACHO') === today) {
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
