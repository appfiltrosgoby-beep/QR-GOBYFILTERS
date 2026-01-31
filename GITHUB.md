# 📤 Instrucciones para Subir a GitHub

## 🎯 Pasos Rápidos

### 1️⃣ Verificar Archivos

Antes de subir, asegúrate de que tu proyecto tiene:

✅ **Archivos necesarios:**
- `server.js` - Servidor backend
- `package.json` - Dependencias
- `public/` - Archivos del frontend
- `.gitignore` - Archivos a ignorar
- `README.md` - Documentación
- `render.yaml` - Configuración de Render
- `.env.example` - Plantilla de variables

❌ **Archivos que NO se deben subir:**
- `.env` - (ya está en .gitignore)
- `node_modules/` - (ya está en .gitignore)
- Archivos JSON de credenciales

### 2️⃣ Crear Repositorio en GitHub

1. Ve a https://github.com/new
2. **Nombre del repositorio:** `qr-scanner-goby` (o el que prefieras)
3. **Visibilidad:** Privado (recomendado)
4. **NO marques** "Initialize this repository with a README"
5. Haz clic en **"Create repository"**

### 3️⃣ Subir el Código

Abre PowerShell o Git Bash en la carpeta del proyecto:

```bash
# Verificar que Git está instalado
git --version

# Si no está instalado, descárgalo de: https://git-scm.com/

# Inicializar repositorio Git (si no está ya inicializado)
git init

# Verificar archivos que se van a subir
git status

# Agregar todos los archivos
git add .

# Verificar nuevamente (asegúrate que .env NO aparezca)
git status

# Hacer el primer commit
git commit -m "Initial commit: QR Scanner App"

# Conectar con GitHub (reemplaza TU_USUARIO y NOMBRE_REPO)
git remote add origin https://github.com/TU_USUARIO/qr-scanner-goby.git

# Cambiar a rama main
git branch -M main

# Subir los archivos
git push -u origin main
```

### 4️⃣ Verificar en GitHub

1. Ve a tu repositorio en GitHub
2. Verifica que los archivos estén ahí
3. **IMPORTANTE:** Asegúrate que el archivo `.env` NO esté visible
4. Si ves `.env`, elimínalo inmediatamente:

```bash
# Eliminar .env del repositorio (pero mantenerlo local)
git rm --cached .env
git commit -m "Remove .env from repository"
git push origin main
```

## 🔐 Seguridad

### ✅ Verificar .gitignore

El archivo `.gitignore` debe contener:

```
node_modules/
.env
.env.local
.env.production
*.log
credentials.json
service-account.json
```

### ⚠️ Si subiste accidentalmente credenciales:

1. **Elimina el archivo del repo:**
   ```bash
   git rm --cached .env
   git commit -m "Remove sensitive file"
   git push origin main
   ```

2. **Cambia las credenciales inmediatamente:**
   - Genera una nueva clave en Google Cloud
   - Actualiza tu `.env` local
   - Actualiza las variables en Render

3. **Limpia el historial (si es necesario):**
   ```bash
   git filter-branch --force --index-filter \
   "git rm --cached --ignore-unmatch .env" \
   --prune-empty --tag-name-filter cat -- --all
   ```

## 📝 Comandos Útiles de Git

### Hacer cambios posteriores:

```bash
# Ver estado de archivos
git status

# Agregar archivos modificados
git add .

# O agregar archivos específicos
git add archivo.js

# Hacer commit con mensaje descriptivo
git commit -m "Descripción de los cambios"

# Subir cambios
git push origin main
```

### Ver historial:

```bash
# Ver commits recientes
git log --oneline

# Ver cambios en archivos
git diff
```

### Deshacer cambios:

```bash
# Deshacer cambios locales (no commiteados)
git checkout -- archivo.js

# Volver al commit anterior
git reset --soft HEAD~1
```

## 🔄 Siguiente Paso: Desplegar en Render

Una vez que tu código esté en GitHub:

1. Ve a [render.com](https://render.com)
2. Conecta tu cuenta de GitHub
3. Selecciona el repositorio
4. Sigue la guía en [DEPLOY.md](DEPLOY.md)

## 🆘 Solución de Problemas

### ❌ Error: "Permission denied"

**Solución:** Configura tu autenticación de GitHub

```bash
# Usar HTTPS con token personal
# O configurar SSH (recomendado)
ssh-keygen -t ed25519 -C "tu@email.com"
# Agrega la clave a GitHub: Settings → SSH Keys
```

### ❌ Error: "Repository not found"

**Solución:** Verifica la URL

```bash
# Ver remotes configurados
git remote -v

# Cambiar URL si es necesario
git remote set-url origin https://github.com/USUARIO_CORRECTO/REPO_CORRECTO.git
```

### ❌ Archivos demasiado grandes

**Solución:** Git tiene límite de 100MB por archivo

```bash
# Ver archivos grandes
find . -type f -size +50M

# Agregar a .gitignore si no son necesarios
```

### ⚠️ Mensaje: ".env" aparece en cambios

**Esto es NORMAL la primera vez**, pero NO debe subirse:

1. Verifica que `.env` esté en `.gitignore`
2. Si ya está, ejecuta:
   ```bash
   git rm --cached .env
   git commit -m "Stop tracking .env"
   ```

## ✅ Checklist Final

Antes de considerar que está todo listo:

- [ ] El código está en GitHub
- [ ] El archivo `.env` NO está en el repositorio
- [ ] `.gitignore` está configurado correctamente
- [ ] El repositorio es privado (recomendado)
- [ ] `package.json` tiene los scripts correctos
- [ ] `render.yaml` está incluido
- [ ] `.env.example` está incluido (sin valores reales)
- [ ] README.md explica el proyecto

## 🎉 ¡Listo para Desplegar!

Ahora puedes continuar con [DEPLOY.md](DEPLOY.md) para publicar en Render.

---

**Ayuda adicional:**
- [GitHub Docs](https://docs.github.com/es)
- [Git Cheat Sheet](https://education.github.com/git-cheat-sheet-education.pdf)
