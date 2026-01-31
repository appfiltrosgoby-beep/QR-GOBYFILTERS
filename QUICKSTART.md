# 🚀 Guía Rápida de Inicio

Esta guía te llevará paso a paso para tener la aplicación funcionando en **menos de 10 minutos**.

## ⚡ Inicio Rápido

### 1️⃣ Instalar Node.js (si no lo tienes)

Descarga e instala desde: https://nodejs.org/ (versión LTS recomendada)

Verifica la instalación:
```bash
node --version
npm --version
```

### 2️⃣ Instalar Dependencias

Abre una terminal en la carpeta del proyecto y ejecuta:

```bash
npm install
```

Esto instalará todas las librerías necesarias.

### 3️⃣ Configurar Google Sheets API

#### A. Crear Proyecto en Google Cloud

1. Ve a: https://console.cloud.google.com/
2. Clic en "Nuevo Proyecto"
3. Nombre: "QR Scanner" → Crear

#### B. Habilitar API

1. En el menú ☰ → "APIs y servicios" → "Biblioteca"
2. Busca: "Google Sheets API"
3. Haz clic en "HABILITAR"

#### C. Crear Service Account

1. Menú ☰ → "APIs y servicios" → "Credenciales"
2. "Crear credenciales" → "Cuenta de servicio"
3. Nombre: `qr-scanner`
4. Rol: "Editor" → Continuar → Listo

#### D. Descargar Credenciales

1. Haz clic en la cuenta de servicio que creaste
2. Pestaña "Claves"
3. "Agregar clave" → "Crear clave nueva" → JSON
4. Se descargará un archivo JSON
5. **¡GUÁRDALO EN LUGAR SEGURO!**

#### E. Crear Hoja de Cálculo

1. Ve a: https://sheets.google.com
2. Crear hoja nueva
3. Nombre: "Escaneos QR"
4. Copia el ID de la URL:
   ```
   https://docs.google.com/spreadsheets/d/[COPIA_ESTE_ID]/edit
   ```

#### F. Compartir la Hoja

1. Botón "Compartir" en la hoja
2. Pega el email del archivo JSON (campo `client_email`)
3. Permiso: "Editor"
4. Desmarca "Notificar"
5. Compartir

### 4️⃣ Configurar Variables de Entorno

Crea un archivo llamado `.env` en la carpeta del proyecto:

```env
GOOGLE_SPREADSHEET_ID=tu_id_de_la_hoja_aqui
GOOGLE_CLIENT_EMAIL=email_del_archivo_json@proyecto.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nTuClavePrivada\n-----END PRIVATE KEY-----
PORT=3000
```

**Dónde obtener cada valor:**
- `GOOGLE_SPREADSHEET_ID`: Del paso 3E (ID en la URL)
- `GOOGLE_CLIENT_EMAIL`: Abre el JSON descargado, copia el valor de `client_email`
- `GOOGLE_PRIVATE_KEY`: Del JSON, copia el valor completo de `private_key`

**⚠️ IMPORTANTE:** La clave privada debe tener `\n` en lugar de saltos de línea reales.

### 5️⃣ Iniciar la Aplicación

```bash
npm start
```

Verás algo como:
```
✅ Servidor ejecutándose en http://localhost:3000
📊 Ambiente: development
🚀 API lista para recibir solicitudes
```

### 6️⃣ Abrir en el Navegador

1. Abre tu navegador
2. Ve a: http://localhost:3000
3. Acepta los permisos de cámara
4. ¡Listo! Escanea tu primer QR

## 📱 Usar desde Móvil

Para escanear desde tu teléfono en la misma red:

1. Averigua la IP de tu computadora:
   - **Windows**: `ipconfig` → busca "IPv4"
   - **Mac/Linux**: `ifconfig` → busca "inet"
   
2. En tu móvil, abre: `http://TU_IP:3000`
   - Ejemplo: `http://192.168.1.100:3000`

3. Acepta permisos de cámara

**Nota:** Para HTTPS (requerido por algunos navegadores), usa ngrok o deploy en producción.

## 🔧 Solución de Problemas Rápidos

### ❌ Error: "Cannot find module"
```bash
npm install
```

### ❌ Error: "Error al conectar con Google Sheets"
- Verifica que el ID de la hoja sea correcto
- Confirma que compartiste la hoja con el service account
- Revisa que la clave privada tenga `\n` correctos

### ❌ Error: "No se detectaron cámaras"
- Otorga permisos de cámara en el navegador
- Verifica que ninguna otra app esté usando la cámara
- En móvil/producción requiere HTTPS

### ❌ Puerto 3000 en uso
Cambia el puerto en `.env`:
```env
PORT=8080
```

## 📖 Próximos Pasos

- Lee el [README.md](README.md) completo para más detalles
- Personaliza los colores en `public/styles.css`
- Despliega en producción (ver guía en README)

## 💡 Consejos

✅ **Seguridad:** Nunca subas el archivo `.env` a Git
✅ **Backup:** Descarga regularmente tu hoja de Google Sheets
✅ **Actualizaciones:** Ejecuta `npm audit` periódicamente

---

¿Problemas? Revisa la sección "Testing y Debugging" del README.md
