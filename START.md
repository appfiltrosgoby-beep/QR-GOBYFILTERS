# 🚀 INICIO RÁPIDO - 3 PASOS

## Para Empezar Localmente

### 1️⃣ Instalar Dependencias
```bash
npm install
```

### 2️⃣ Configurar Variables
Edita el archivo `.env` con tus credenciales de Google

### 3️⃣ Iniciar Servidor
```bash
npm start
```

Abre: http://localhost:3000

---

## Para Desplegar en Render

### 1️⃣ Subir a GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU_USUARIO/qr-scanner-goby.git
git push -u origin main
```

Ver guía completa en [GITHUB.md](GITHUB.md)

### 2️⃣ Conectar Render
1. Ve a [render.com](https://render.com)
2. Conecta tu repositorio de GitHub
3. Selecciona "Web Service"

### 3️⃣ Configurar Variables
En Render, agrega estas variables de entorno:
- `GOOGLE_SPREADSHEET_ID`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `NODE_ENV=production`

Ver guía completa en [DEPLOY.md](DEPLOY.md)

---

## 📚 Documentación Completa

- **[QUICKSTART.md](QUICKSTART.md)** - Configuración inicial detallada
- **[GITHUB.md](GITHUB.md)** - Cómo subir a GitHub
- **[DEPLOY.md](DEPLOY.md)** - Desplegar en Render paso a paso
- **[README.md](README.md)** - Documentación técnica completa
- **[CHECKLIST.md](CHECKLIST.md)** - Verificación pre-deploy
- **[ESTRUCTURA.md](ESTRUCTURA.md)** - Estructura del proyecto

---

## ⚡ Comandos Útiles

```bash
# Desarrollo con auto-reload
npm run dev

# Producción
npm start

# Ver estado de Git
git status

# Subir cambios
git add .
git commit -m "Descripción"
git push origin main
```

---

## 🆘 Problemas Comunes

**Error de conexión a Google Sheets:**
- Verifica que el ID de la hoja sea correcto
- Asegúrate de compartir la hoja con el service account

**Cámara no funciona:**
- Usa HTTPS (automático en Render)
- Da permisos de cámara en el navegador

**Puerto en uso:**
- Cambia el puerto en `.env` a otro número

---

## ✅ Verificación Rápida

Tu app está lista cuando:
- ✅ `npm start` funciona sin errores
- ✅ http://localhost:3000 abre la aplicación
- ✅ Puedes escanear un QR
- ✅ Los datos aparecen en Google Sheets

---

**¿Necesitas ayuda?** Revisa las guías detalladas arriba 👆
