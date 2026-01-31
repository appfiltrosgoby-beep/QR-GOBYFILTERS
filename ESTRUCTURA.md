# 📁 Estructura del Proyecto

## 🗂️ Archivos y Carpetas

```
qr-scanner-goby/
│
├── 📂 public/                      # Frontend - Archivos estáticos
│   ├── index.html                 # Interfaz principal de usuario
│   ├── app.js                     # Lógica JavaScript del cliente
│   └── styles.css                 # Estilos CSS
│
├── 📄 server.js                   # Servidor backend (Node.js + Express)
├── 📦 package.json                # Dependencias y configuración npm
│
├── 🔧 .env                        # Variables de entorno (NO SUBIR A GIT)
├── 📋 .env.example                # Plantilla de variables de entorno
├── 🚫 .gitignore                  # Archivos ignorados por Git
│
├── ⚙️ render.yaml                 # Configuración para Render.com
├── 🔌 jsconfig.json               # Configuración JavaScript
│
├── 📖 README.md                   # Documentación principal
├── 🚀 QUICKSTART.md               # Guía de inicio rápido
├── 🌐 DEPLOY.md                   # Guía de despliegue en Render
├── 📤 GITHUB.md                   # Instrucciones para GitHub
├── 📊 SISTEMA_INVENTARIO.md       # Documentación del sistema
├── ✅ VERIFICACION.md             # Checklist de verificación
└── 📁 ESTRUCTURA.md               # Este archivo
```

## 📄 Descripción de Archivos

### 🎨 Frontend (public/)

**index.html**
- Interfaz de usuario principal
- Secciones: scanner, estadísticas, registros
- Responsive design
- Integración con html5-qrcode

**app.js**
- Manejo del escáner QR
- Comunicación con el backend (API REST)
- Actualización de estadísticas en tiempo real
- Exportación de datos a CSV

**styles.css**
- Diseño moderno y profesional
- Responsive para móvil y desktop
- Animaciones y transiciones
- Variables CSS para fácil personalización

### 🔧 Backend

**server.js**
- Servidor Express en el puerto 3000
- API REST con endpoints:
  - `GET /api/health` - Estado del servidor
  - `POST /api/save-qr` - Guardar escaneo
  - `GET /api/recent-scans` - Obtener registros
  - `GET /api/stats` - Estadísticas
- Integración con Google Sheets API
- Autenticación JWT
- Middleware de CORS y body-parser

### 📦 Configuración

**package.json**
- Dependencias de producción:
  - `express`: Framework web
  - `googleapis`: API de Google Sheets
  - `dotenv`: Variables de entorno
  - `cors`: Seguridad cross-origin
  - `body-parser`: Parseo de JSON
- Dependencias de desarrollo:
  - `nodemon`: Auto-reload en desarrollo
- Scripts:
  - `npm start`: Inicia el servidor
  - `npm run dev`: Modo desarrollo con nodemon

**.env** (NO SUBIR A GIT)
- `GOOGLE_SPREADSHEET_ID`: ID de la hoja
- `GOOGLE_CLIENT_EMAIL`: Email del service account
- `GOOGLE_PRIVATE_KEY`: Clave privada
- `PORT`: Puerto del servidor
- `NODE_ENV`: Ambiente (development/production)

**.env.example**
- Plantilla pública sin credenciales
- Incluye instrucciones de configuración
- Seguro para subir a Git

**.gitignore**
- Excluye archivos sensibles y temporales
- `node_modules/`, `.env`, logs, etc.

**render.yaml**
- Configuración automática para Render
- Define build y start commands
- Lista variables de entorno necesarias
- Health check endpoint

**jsconfig.json**
- Configuración de JavaScript para VS Code
- Autocompletado mejorado

### 📚 Documentación

**README.md**
- Documentación principal completa
- Instalación y configuración
- Arquitectura del sistema
- Guías de uso y debugging
- Enlaces a otras guías

**QUICKSTART.md**
- Guía rápida de inicio
- Ideal para comenzar en minutos
- Pasos simplificados
- Troubleshooting básico

**DEPLOY.md**
- Guía completa de despliegue en Render
- Paso a paso detallado
- Configuración de variables
- Solución de problemas comunes
- Mejores prácticas

**GITHUB.md**
- Instrucciones para subir a GitHub
- Comandos Git esenciales
- Verificación de seguridad
- Solución de problemas

**SISTEMA_INVENTARIO.md**
- Explicación del sistema de inventario
- Flujo de estados
- Casos de uso

**VERIFICACION.md**
- Checklist de verificación
- Testing y validación

**ESTRUCTURA.md**
- Este archivo
- Mapa del proyecto

## 🔄 Flujo de Trabajo

### Desarrollo Local

1. Clonar/descargar proyecto
2. `npm install` - Instalar dependencias
3. Configurar `.env` con credenciales
4. `npm run dev` - Iniciar en modo desarrollo
5. Abrir http://localhost:3000

### Despliegue a Producción

1. Verificar que `.gitignore` esté correcto
2. Subir código a GitHub (ver GITHUB.md)
3. Conectar Render con GitHub (ver DEPLOY.md)
4. Configurar variables de entorno en Render
5. Deploy automático

### Actualizar Aplicación

1. Hacer cambios en el código
2. Probar localmente (`npm run dev`)
3. Commit: `git commit -m "mensaje"`
4. Push: `git push origin main`
5. Render hace auto-deploy

## 📊 Arquitectura de Datos

### Google Sheets Structure

```
| ID | REFERENCIA | SERIAL | ESTADO | FECHA_ALMACEN | FECHA_DESPACHO | HORA_ALMACEN | HORA_DESPACHO |
|----|-----------|--------|---------|---------------|----------------|--------------|---------------|
| 1  | OG971390  | 202... | EN ALMACEN | 31/01/2026 |              | 14:30:25    |              |
| 2  | OG971391  | 202... | DESPACHADO | 31/01/2026 | 31/01/2026   | 14:35:10    | 16:20:45     |
```

### Estados del Producto

1. **Primer Escaneo**: Producto registrado como `EN ALMACEN`
2. **Segundo Escaneo**: Actualizado a `DESPACHADO`
3. **Escaneos posteriores**: Advertencia (no modifica)

## 🔐 Seguridad

### Archivos NUNCA Subir a Git
- ❌ `.env` - Credenciales reales
- ❌ `node_modules/` - Dependencias
- ❌ Archivos JSON de credenciales
- ❌ Logs con información sensible

### Archivos SÍ Subir a Git
- ✅ `.env.example` - Plantilla
- ✅ `package.json` - Configuración
- ✅ Código fuente
- ✅ Documentación
- ✅ `.gitignore`
- ✅ `render.yaml`

## 🚀 URLs y Endpoints

### Desarrollo Local
- **App**: http://localhost:3000
- **Health**: http://localhost:3000/api/health
- **Stats**: http://localhost:3000/api/stats

### Producción (Render)
- **App**: https://qr-scanner-goby.onrender.com
- **Health**: https://qr-scanner-goby.onrender.com/api/health
- **Stats**: https://qr-scanner-goby.onrender.com/api/stats

## 📝 Checklist de Archivos Requeridos

Antes de desplegar, verifica que tienes:

- [x] `server.js` - Backend
- [x] `package.json` - Dependencias
- [x] `public/index.html` - Frontend
- [x] `public/app.js` - Lógica cliente
- [x] `public/styles.css` - Estilos
- [x] `.env.example` - Plantilla
- [x] `.gitignore` - Exclusiones
- [x] `render.yaml` - Config Render
- [x] `README.md` - Docs principal
- [x] `DEPLOY.md` - Guía despliegue

## 🆘 Ayuda Rápida

- **Configuración inicial**: Ver QUICKSTART.md
- **Subir a GitHub**: Ver GITHUB.md
- **Desplegar en Render**: Ver DEPLOY.md
- **Documentación completa**: Ver README.md
- **Problemas**: Revisar logs y secciones de troubleshooting

---

**Última actualización**: Enero 2026
**Versión**: 1.0.0
