# 🚀 Guía de Despliegue en Render

Esta guía te ayudará a desplegar la aplicación QR Scanner en Render paso a paso.

## 📋 Requisitos Previos

- ✅ Cuenta en [Render](https://render.com) (gratis)
- ✅ Cuenta en [GitHub](https://github.com)
- ✅ Google Cloud Service Account configurado (ver QUICKSTART.md)
- ✅ Google Spreadsheet creado y compartido

## 🔧 Pasos para el Despliegue

### 1️⃣ Preparar el Repositorio de GitHub

#### A. Crear Repositorio en GitHub

1. Ve a https://github.com/new
2. Nombre del repositorio: `qr-scanner-goby` (o el que prefieras)
3. Visibilidad: **Privado** (recomendado por seguridad)
4. NO inicialices con README (ya existe uno)
5. Haz clic en "Create repository"

#### B. Subir el Código a GitHub

Abre una terminal en la carpeta del proyecto y ejecuta:

```bash
# Inicializar Git (si no está inicializado)
git init

# Agregar todos los archivos
git add .

# Hacer el primer commit
git commit -m "Initial commit - QR Scanner App"

# Conectar con tu repositorio remoto
git remote add origin https://github.com/TU_USUARIO/qr-scanner-goby.git

# Cambiar a la rama main (si estás en master)
git branch -M main

# Subir los archivos
git push -u origin main
```

**⚠️ IMPORTANTE:** El archivo `.env` NO se subirá a GitHub (está en .gitignore). Esto es correcto por seguridad.

### 2️⃣ Configurar Render

#### A. Crear Nuevo Web Service

1. Inicia sesión en https://dashboard.render.com
2. Haz clic en **"New +"** → **"Web Service"**
3. Conecta tu cuenta de GitHub si aún no lo has hecho
4. Selecciona el repositorio `qr-scanner-goby`
5. Haz clic en **"Connect"**

#### B. Configurar el Servicio

Completa los campos:

- **Name:** `qr-scanner-goby` (o el nombre que prefieras)
- **Region:** Selecciona la más cercana a ti
- **Branch:** `main`
- **Root Directory:** (déjalo vacío)
- **Runtime:** `Node`
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Instance Type:** `Free` (o el que prefieras)

#### C. Configurar Variables de Entorno

En la sección **"Environment Variables"**, agrega las siguientes variables:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `GOOGLE_SPREADSHEET_ID` | Tu ID de Google Sheets (SOLO EL ID, no la URL completa) |
| `GOOGLE_CLIENT_EMAIL` | Email del service account |
| `GOOGLE_PRIVATE_KEY` | Clave privada completa (con \n) |

**📌 Cómo obtener el SPREADSHEET_ID:**
- URL: `https://docs.google.com/spreadsheets/d/1s_FQTFPij0RXNHooRjpw_Tlo9opKHWd2wsn1gi6Huf8/edit`
- ID: `1s_FQTFPij0RXNHooRjpw_Tlo9opKHWd2wsn1gi6Huf8` ← Copia solo esta parte

**⚠️ IMPORTANTE para GOOGLE_PRIVATE_KEY:**
- Copia la clave COMPLETA del archivo JSON de credenciales
- Debe incluir `-----BEGIN PRIVATE KEY-----` y `-----END PRIVATE KEY-----`
- Mantén los `\n` en lugar de saltos de línea reales
- Ejemplo: `"-----BEGIN PRIVATE KEY-----\nMIIEvQI...\n-----END PRIVATE KEY-----\n"`

#### D. Finalizar Despliegue

1. Revisa toda la configuración
2. Haz clic en **"Create Web Service"**
3. Render comenzará a:
   - Clonar tu repositorio
   - Instalar dependencias (`npm install`)
   - Iniciar el servidor (`npm start`)

⏱️ El primer despliegue toma 2-5 minutos.

### 3️⃣ Verificar el Despliegue

#### A. Ver Logs

1. En el dashboard de Render, ve a la pestaña **"Logs"**
2. Deberías ver:
   ```
   ✅ Servidor ejecutándose en http://0.0.0.0:XXXX
   📊 Ambiente: production
   🚀 API lista para recibir solicitudes
   ```

#### B. Probar la Aplicación

1. Render te dará una URL pública: `https://qr-scanner-goby.onrender.com`
2. Abre esa URL en tu navegador
3. Prueba escanear un código QR
4. Verifica que los datos se guarden en Google Sheets

#### C. Verificar Health Check

Abre: `https://tu-app.onrender.com/api/health`

Deberías ver:
```json
{
  "status": "OK",
  "message": "Servidor funcionando correctamente",
  "timestamp": "2026-01-31T..."
}
```

## 📱 Usar desde Móvil

La URL de Render funciona con HTTPS automáticamente, por lo que puedes:

1. Abrir la URL desde cualquier dispositivo móvil
2. Aceptar permisos de cámara
3. Escanear códigos QR directamente

## 🔄 Actualizar la Aplicación

Cuando hagas cambios en el código:

```bash
# Agregar cambios
git add .

# Hacer commit
git commit -m "Descripción de los cambios"

# Subir a GitHub
git push origin main
```

Render detectará los cambios automáticamente y desplegará la nueva versión.

## ⚙️ Configuración Avanzada

### Custom Domain (Opcional)

Si tienes un dominio propio:

1. En Render, ve a **"Settings"** → **"Custom Domain"**
2. Agrega tu dominio
3. Configura los DNS según las instrucciones

### Auto-Deploy

Por defecto, Render hace auto-deploy cuando subes cambios a `main`. Para desactivarlo:

1. **"Settings"** → **"Auto-Deploy"**
2. Cambia a "Manual"

## 🐛 Solución de Problemas

### ❌ Error: "Application failed to start"

**Solución:**
- Revisa los logs en Render
- Verifica que todas las variables de entorno estén configuradas
- Asegúrate de que `npm start` funcione localmente

### ❌ Error: "Cannot connect to Google Sheets"

**Soluciones:**
1. Verifica que el `GOOGLE_SPREADSHEET_ID` sea SOLO el ID, no la URL completa
2. Confirma que compartiste la hoja con `GOOGLE_CLIENT_EMAIL`
3. Revisa que `GOOGLE_PRIVATE_KEY` incluya los saltos de línea `\n`

### ❌ Error: "Port already in use"

**No es un problema en Render**
- Render asigna el puerto automáticamente
- El código ya usa `process.env.PORT`

### ❌ La aplicación se duerme después de 15 minutos

**Explicación:**
- El plan Free de Render duerme los servicios inactivos
- El primer request después de dormir toma 30-60 segundos

**Soluciones:**
- Upgrade a plan Starter ($7/mes) para tenerlo siempre activo
- O acepta el delay ocasional (gratis)

## 💡 Recomendaciones de Seguridad

✅ **DO:**
- Mantén el repositorio privado si contiene lógica de negocio sensible
- Usa variables de entorno para todos los secretos
- Rota las credenciales periódicamente
- Revisa los logs regularmente

❌ **DON'T:**
- NUNCA subas el archivo `.env` a GitHub
- NUNCA hagas commits con credenciales
- NUNCA compartas las variables de entorno públicamente

## 📊 Monitoreo

Render ofrece:
- **Logs en tiempo real**: Ver todas las solicitudes
- **Metrics**: CPU, memoria, requests
- **Alertas**: Configura notificaciones por email

## 💰 Costos

### Plan Free
- ✅ Perfecto para desarrollo y pruebas
- ✅ 750 horas/mes gratuitas
- ⚠️ Se duerme después de 15 min de inactividad
- ⚠️ Tiempo de arranque en frío: 30-60 seg

### Plan Starter ($7/mes)
- ✅ Siempre activo
- ✅ Sin tiempo de arranque
- ✅ 100GB de transferencia

## 🆘 Soporte

Si tienes problemas:
1. Revisa la [documentación de Render](https://render.com/docs)
2. Consulta los logs en el dashboard
3. Verifica que la aplicación funcione localmente primero

---

**¡Listo!** Tu aplicación QR Scanner está desplegada y accesible desde cualquier lugar del mundo 🌍
