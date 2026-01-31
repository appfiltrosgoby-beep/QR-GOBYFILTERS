# ✅ Checklist Pre-Deploy

## 📋 Verificación Antes de Subir a GitHub

### 🔒 Seguridad

- [ ] El archivo `.env` contiene credenciales reales y NO debe subirse
- [ ] El archivo `.env.example` NO contiene credenciales reales
- [ ] El archivo `.gitignore` incluye `.env`
- [ ] No hay archivos JSON de credenciales en el proyecto
- [ ] No hay claves privadas en el código fuente

### 📦 Archivos Esenciales

- [ ] `server.js` existe y está completo
- [ ] `package.json` tiene las dependencias correctas
- [ ] `public/index.html` está presente
- [ ] `public/app.js` está presente
- [ ] `public/styles.css` está presente
- [ ] `.gitignore` está configurado
- [ ] `render.yaml` está incluido
- [ ] `README.md` existe

### ⚙️ Configuración

- [ ] `package.json` tiene script `"start": "node server.js"`
- [ ] `package.json` especifica versión de Node >= 16
- [ ] Las variables de entorno están documentadas en `.env.example`
- [ ] El puerto se obtiene de `process.env.PORT`

### 📝 Documentación

- [ ] README.md describe el proyecto
- [ ] QUICKSTART.md está incluido
- [ ] DEPLOY.md tiene instrucciones de despliegue
- [ ] GITHUB.md tiene instrucciones de Git

---

## 🌐 Verificación Antes de Desplegar en Render

### 🔧 GitHub

- [ ] El código está en GitHub
- [ ] El repositorio es privado (recomendado)
- [ ] `.env` NO está en el repositorio
- [ ] Todos los archivos necesarios están presentes
- [ ] El último commit incluye todos los cambios

### 🎛️ Variables de Entorno

Prepara estas variables para configurar en Render:

- [ ] `GOOGLE_SPREADSHEET_ID` - ¿Tienes el ID correcto (solo el ID, no la URL)?
- [ ] `GOOGLE_CLIENT_EMAIL` - ¿Tienes el email del service account?
- [ ] `GOOGLE_PRIVATE_KEY` - ¿Tienes la clave privada completa?
- [ ] `NODE_ENV` - Se configurará como `production`

### 📊 Google Sheets

- [ ] La hoja de Google Sheets está creada
- [ ] El ID de la hoja es correcto
- [ ] La hoja está compartida con el email del service account
- [ ] El service account tiene permisos de "Editor"
- [ ] La API de Google Sheets está habilitada en Google Cloud

### 🔑 Google Cloud

- [ ] Proyecto de Google Cloud creado
- [ ] Google Sheets API habilitada
- [ ] Service Account creado
- [ ] Archivo JSON de credenciales descargado
- [ ] Las credenciales son válidas

---

## 🧪 Verificación Post-Deploy

### ✅ Render Dashboard

- [ ] El build se completó sin errores
- [ ] El servicio está "Running" (verde)
- [ ] Los logs muestran "Servidor ejecutándose"
- [ ] No hay errores en los logs

### 🌍 Aplicación en Producción

- [ ] La URL de Render abre la aplicación
- [ ] El endpoint `/api/health` responde OK
- [ ] La cámara se activa correctamente
- [ ] Se puede escanear un código QR
- [ ] Los datos se guardan en Google Sheets
- [ ] Las estadísticas se actualizan
- [ ] Los registros se muestran correctamente

### 📱 Pruebas Funcionales

#### Primer Escaneo
- [ ] Escanear QR formato: `REFERENCIA|SERIAL`
- [ ] Aparece mensaje: "Producto registrado EN ALMACEN"
- [ ] Se crea registro en Google Sheets
- [ ] Estado es "EN ALMACEN"
- [ ] Fecha y hora se registran correctamente

#### Segundo Escaneo (mismo QR)
- [ ] Escanear el mismo QR nuevamente
- [ ] Aparece mensaje: "Producto marcado como DESPACHADO"
- [ ] El registro se actualiza en Google Sheets
- [ ] Estado cambia a "DESPACHADO"
- [ ] Fecha y hora de despacho se registran

#### Tercer Escaneo (mismo QR)
- [ ] Escanear el mismo QR por tercera vez
- [ ] Aparece advertencia: "Ya fue DESPACHADO anteriormente"
- [ ] No se modifica el registro existente

### 📊 Verificación de Datos

- [ ] Los datos en Google Sheets son correctos
- [ ] Las fechas tienen formato adecuado
- [ ] Las horas se registran correctamente
- [ ] No hay columnas vacías inesperadas
- [ ] El ID es secuencial

---

## 🔍 Pruebas de Dispositivos

### 💻 Desktop
- [ ] Chrome - Funciona correctamente
- [ ] Firefox - Funciona correctamente
- [ ] Edge - Funciona correctamente
- [ ] Safari - Funciona correctamente

### 📱 Móvil
- [ ] Android Chrome - Funciona correctamente
- [ ] iOS Safari - Funciona correctamente
- [ ] La cámara se activa sin problemas
- [ ] El escaneo es rápido y preciso

---

## ⚡ Performance

- [ ] El servidor responde en < 2 segundos
- [ ] El escaneo es fluido
- [ ] La interfaz es responsive
- [ ] No hay lags visibles
- [ ] Las imágenes cargan rápido

---

## 🐛 Debugging

### Si algo falla, verifica:

**Error de conexión a Google Sheets:**
- [ ] ¿El SPREADSHEET_ID es correcto (solo el ID)?
- [ ] ¿La hoja está compartida con el service account?
- [ ] ¿El GOOGLE_PRIVATE_KEY tiene los `\n` correctos?
- [ ] ¿La API está habilitada en Google Cloud?

**Error "Cannot find module":**
- [ ] ¿Ejecutaste `npm install`?
- [ ] ¿El `package.json` está completo?
- [ ] ¿Las dependencias se instalaron correctamente?

**Error de puerto:**
- [ ] ¿Render asigna el puerto automáticamente?
- [ ] ¿El código usa `process.env.PORT || 3000`?

**Cámara no funciona:**
- [ ] ¿La URL usa HTTPS? (Render lo da automático)
- [ ] ¿Diste permisos de cámara en el navegador?
- [ ] ¿Otra app está usando la cámara?

---

## 📝 Notas Finales

### Antes de Marcar como Completo:

1. **Prueba completa de extremo a extremo**
   - Escanea al menos 3 QRs diferentes
   - Verifica que todos se registren correctamente
   - Comprueba las estadísticas

2. **Revisa los logs de Render**
   - No debe haber errores
   - Los requests deben aparecer

3. **Comparte la URL**
   - Prueba desde otro dispositivo
   - Pide a alguien más que pruebe

4. **Documenta la URL de producción**
   - Guárdala en un lugar seguro
   - Compártela con el equipo

### 🎉 Si Todo Está en Verde:

**¡FELICITACIONES! Tu aplicación está lista para producción.**

### URLs Importantes:

- **App en producción**: https://tu-app.onrender.com
- **Repositorio GitHub**: https://github.com/tu-usuario/qr-scanner-goby
- **Google Sheets**: https://docs.google.com/spreadsheets/d/TU_ID/edit
- **Render Dashboard**: https://dashboard.render.com

---

**Última revisión**: Antes de cada deploy
**Mantén este checklist actualizado**
