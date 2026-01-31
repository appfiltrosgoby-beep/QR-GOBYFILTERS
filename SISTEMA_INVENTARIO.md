# 📦 Sistema de Inventario con QR

## 📋 Descripción del Sistema

Este sistema está diseñado para gestionar el flujo de productos en un almacén mediante códigos QR. Cada producto tiene una **REFERENCIA** y un **SERIAL** que se escanean en dos momentos diferentes:

1. **Entrada al almacén** → Estado: `EN ALMACEN`
2. **Despacho/Salida** → Estado: `DESPACHADO`

## 🏷️ Formato del Código QR

Los códigos QR deben contener la información en el siguiente formato:

```
REFERENCIA|SERIAL
```

### Ejemplos válidos:
- `OG971390|202630010002`
- `REF12345|SN987654321`
- `PROD-A01|2026-0001`

**⚠️ Importante:** 
- Los dos valores están separados por el símbolo pipe (`|`)
- Ambos campos son obligatorios
- No debe haber espacios adicionales

## 📊 Estructura de la Hoja de Cálculo

La aplicación crea automáticamente una hoja de Google Sheets con las siguientes columnas:

| Columna | Descripción | Ejemplo |
|---------|-------------|---------|
| `ID` | Identificador único secuencial | 1, 2, 3... |
| `REFERENCIA` | Código de referencia del producto | OG971390 |
| `SERIAL` | Número de serie del producto | 202630010002 |
| `ESTADO` | Estado actual | EN ALMACEN / DESPACHADO |
| `FECHA_ALMACEN` | Fecha de entrada al almacén | 30/01/2026 |
| `FECHA_DESPACHO` | Fecha de despacho | 31/01/2026 |
| `HORA_ALMACEN` | Hora de entrada | 14:30:00 |
| `HORA_DESPACHO` | Hora de despacho | 16:45:00 |

## 🔄 Flujo de Trabajo

### Primer Escaneo - Entrada al Almacén

Cuando escaneas un QR por primera vez:

1. Se crea un nuevo registro en Google Sheets
2. Se guarda la REFERENCIA y SERIAL del producto
3. Se establece el ESTADO como `EN ALMACEN`
4. Se registra FECHA_ALMACEN y HORA_ALMACEN automáticamente
5. FECHA_DESPACHO y HORA_DESPACHO quedan vacíos

**Respuesta visual:**
- ✅ Notificación: "Producto registrado EN ALMACEN"
- Badge azul: 📦 EN ALMACEN
- Se muestra la información del producto

### Segundo Escaneo - Despacho

Cuando escaneas el mismo QR por segunda vez:

1. El sistema busca el registro existente por REFERENCIA y SERIAL
2. Actualiza el ESTADO a `DESPACHADO`
3. Registra FECHA_DESPACHO y HORA_DESPACHO
4. FECHA_ALMACEN y HORA_ALMACEN se mantienen sin cambios

**Respuesta visual:**
- 📦 Notificación: "Producto marcado como DESPACHADO"
- Badge verde: 🚚 DESPACHADO
- Se muestran ambas fechas (almacén y despacho)

### Tercer Escaneo (y siguientes)

Si escaneas un producto que ya está DESPACHADO:

1. El sistema detecta que ya fue despachado
2. **No modifica** ningún dato
3. Muestra una advertencia

**Respuesta visual:**
- ⚠️ Notificación: "Producto ya fue DESPACHADO"
- Se muestra la información histórica completa

## 📱 Interfaz de Usuario

### Panel de Escaneo

- **Indicador de formato**: Muestra "Formato: REFERENCIA|SERIAL"
- **Botón Iniciar Escaneo**: Activa la cámara
- **Selector de cámara**: Permite elegir entre cámaras disponibles
- **Estado en tiempo real**: Muestra el progreso del escaneo
- **Último resultado**: Muestra detalles del último QR escaneado

### Panel de Registros Recientes

Tabla con las últimas 20 operaciones:
- ID único
- Referencia del producto
- Serial
- Estado actual (con badge de color)
- Fecha de entrada al almacén
- Fecha de despacho (si aplica)

### Estadísticas

- **Total escaneados**: Cantidad total de productos únicos
- **Hoy**: Operaciones realizadas hoy
- **En Almacén**: Productos actualmente en almacén (📦)
- **Despachados**: Productos ya despachados (🚚)

## 🎨 Indicadores Visuales

### Estados con Colores

| Estado | Color | Emoji | Significado |
|--------|-------|-------|-------------|
| EN ALMACEN | Azul | 📦 | Producto en inventario |
| DESPACHADO | Verde | 🚚 | Producto despachado |

### Notificaciones

- ✅ **Verde**: Operación exitosa
- ⚠️ **Amarillo**: Advertencia (ya despachado)
- ❌ **Rojo**: Error (formato inválido, problema de conexión)

## 💾 Exportación de Datos

Puedes exportar todos los registros a un archivo CSV con el botón "Exportar":

**Nombre del archivo:** `inventario-qr-YYYY-MM-DD.csv`

**Contenido:**
```csv
ID,Referencia,Serial,Estado,Fecha Almacén,Hora Almacén,Fecha Despacho,Hora Despacho
1,OG971390,202630010002,DESPACHADO,30/01/2026,14:30:00,31/01/2026,16:45:00
2,REF12345,SN987654,EN ALMACEN,30/01/2026,15:20:00,,
```

Este archivo puede abrirse en:
- Microsoft Excel
- Google Sheets
- LibreOffice Calc
- Cualquier editor de texto

## 🔍 Casos de Uso Comunes

### Recepción de Mercancía

1. Al recibir productos, escanea cada código QR
2. El sistema registra automáticamente la entrada
3. Revisa la tabla para confirmar que todos fueron registrados
4. Exporta un reporte si necesitas documentación

### Despacho de Pedidos

1. Al preparar un pedido, escanea los productos a despachar
2. El sistema actualiza automáticamente a DESPACHADO
3. Las estadísticas se actualizan en tiempo real
4. Puedes ver qué productos ya fueron despachados

### Auditoría de Inventario

1. Revisa la tabla de registros recientes
2. Filtra por estado usando las estadísticas
3. Exporta los datos para análisis externo
4. Consulta directamente la hoja de Google Sheets

### Control de Tiempos

- **Tiempo en almacén**: Diferencia entre FECHA_ALMACEN y FECHA_DESPACHO
- **Velocidad de rotación**: Cantidad de productos despachados vs en almacén
- **Reporte diario**: Exporta al final del día para registro

## 🚨 Solución de Problemas

### Error: "Formato de QR inválido"

**Causa:** El QR no tiene el formato correcto

**Solución:** 
- Verifica que el QR contenga: `REFERENCIA|SERIAL`
- Asegúrate de usar el símbolo pipe (`|`)
- No incluyas espacios adicionales

### Error: "Error al guardar en Google Sheets"

**Causa:** Problema de conexión con Google Sheets

**Solución:**
- Verifica que el servidor esté ejecutándose
- Confirma que las credenciales en `.env` sean correctas
- Revisa que compartiste la hoja con el service account

### Advertencia: "Producto ya fue DESPACHADO"

**Causa:** Estás escaneando un producto por tercera vez

**Solución:**
- Esto es normal y esperado
- El sistema protege los datos históricos
- Si necesitas modificar, hazlo directamente en Google Sheets

## 📈 Análisis con Google Sheets

Puedes crear análisis adicionales en la hoja de cálculo:

### Tiempo promedio en almacén

```excel
=PROMEDIO(DIAS(FECHA_DESPACHO, FECHA_ALMACEN))
```

### Productos pendientes de despacho

```excel
=CONTAR.SI(ESTADO, "EN ALMACEN")
```

### Tasa de rotación diaria

```excel
=CONTAR.SI.CONJUNTO(FECHA_DESPACHO, HOY())
```

## 🔐 Seguridad y Respaldo

### Respaldo Automático

Google Drive respalda automáticamente tu hoja de cálculo. Para descargas manuales:

1. Abre la hoja en Google Sheets
2. Archivo → Descargar → Excel (.xlsx) o CSV

### Control de Acceso

- El service account tiene acceso de "Editor"
- Puedes compartir la hoja con otros usuarios
- Configura permisos según necesites (Ver/Comentar/Editar)

### Historial de Versiones

Google Sheets mantiene historial completo:

1. Archivo → Historial de versiones
2. Puedes restaurar versiones anteriores
3. Ver quién hizo cambios y cuándo

## 📞 Soporte

Para más información, consulta:
- [README.md](README.md) - Documentación técnica completa
- [QUICKSTART.md](QUICKSTART.md) - Guía de inicio rápido

---

**Sistema desarrollado para gestión eficiente de inventario** 📦✨
