/**
 * QR Scanner Pro - JavaScript Principal
 * Gestiona el escaneo de QR, comunicación con el backend y la interfaz de usuario
 */

// ============================================
// CONFIGURACIÓN Y VARIABLES GLOBALES
// ============================================

const API_URL = window.location.origin;
let html5QrCode = null;
let isScanning = false;
let selectedCameraId = null;
let currentUserRole = null; // 'user' o 'admin'
let currentUserEmail = null; // Email del usuario logueado
let allStatsData = []; // Guardar todos los datos de estadísticas para filtrado
let currentFilteredData = []; // Guardar datos filtrados actual

// Elementos del DOM
const elements = {
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    scannerStatus: document.getElementById('scannerStatus'),
    lastResult: document.getElementById('lastResult'),
    resultType: document.getElementById('resultType'),
    resultData: document.getElementById('resultData'),
    resultMeta: document.getElementById('resultMeta'),
    clearResult: document.getElementById('clearResult'),
    recordsBody: document.getElementById('recordsBody'),
    refreshBtn: document.getElementById('refreshBtn'),
    exportBtn: document.getElementById('exportBtn'),
    totalScans: document.getElementById('totalScans'),
    todayScans: document.getElementById('todayScans'),
    statsContainer: document.getElementById('statsContainer'),
    toastContainer: document.getElementById('toastContainer'),
    loginModal: document.getElementById('loginModal'),
    loginUserBtn: document.getElementById('loginUserBtn'),
    loginAdminBtn: document.getElementById('loginAdminBtn'),
    userEmailForm: document.getElementById('userEmailForm'),
    userEmail: document.getElementById('userEmail'),
    submitUserBtn: document.getElementById('submitUserBtn'),
    cancelUserBtn: document.getElementById('cancelUserBtn'),
    emailError: document.getElementById('emailError'),
    adminPasswordForm: document.getElementById('adminPasswordForm'),
    adminPassword: document.getElementById('adminPassword'),
    submitAdminBtn: document.getElementById('submitAdminBtn'),
    cancelAdminBtn: document.getElementById('cancelAdminBtn'),
    passwordError: document.getElementById('passwordError'),
    logoutBtn: document.getElementById('logoutBtn'),
    currentRole: document.getElementById('currentRole')
};

// ============================================
// SISTEMA DE AUTENTICACIÓN
// ============================================

/**
 * Inicializa el sistema de autenticación
 */
function initAuth() {
    const savedRole = localStorage.getItem('userRole');
    const savedEmail = localStorage.getItem('userEmail');
    
    if (savedRole) {
        currentUserRole = savedRole;
        if (savedEmail) {
            currentUserEmail = savedEmail;
        }
        applyRolePermissions();
        elements.loginModal.style.display = 'none';
    } else {
        elements.loginModal.style.display = 'flex';
    }
}

/**
 * Mostrar formulario de email para usuario
 */
function showUserEmailForm() {
    elements.loginUserBtn.parentElement.style.display = 'none';
    elements.userEmailForm.classList.remove('hidden');
    elements.userEmail.focus();
}

/**
 * Cancelar login de usuario
 */
function cancelUserLogin() {
    elements.userEmailForm.classList.add('hidden');
    elements.loginUserBtn.parentElement.style.display = 'block';
    elements.userEmail.value = '';
    elements.emailError.textContent = '';
}

/**
 * Validar email del usuario
 */
function validateUserEmail() {
    const email = elements.userEmail.value.trim();
    
    // Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email) {
        elements.emailError.textContent = 'Por favor ingresa tu correo';
        return;
    }
    if (!emailRegex.test(email)) {
        elements.emailError.textContent = 'Por favor ingresa un correo válido';
        return;
    }
    
    // Guardar email y continuar con login
    currentUserEmail = email;
    localStorage.setItem('userEmail', email);
    loginAsUser();
}

/**
 * Login como usuario (sin contraseña)
 */
function loginAsUser() {
    currentUserRole = 'user';
    localStorage.setItem('userRole', 'user');
    applyRolePermissions();
    elements.loginModal.style.display = 'none';
    elements.userEmailForm.classList.add('hidden');
    elements.userEmail.value = '';
    elements.emailError.textContent = '';
    showToast(`Bienvenido ${currentUserEmail}`, 'success');
}

/**
 * Mostrar formulario de contraseña para admin
 */
function showAdminPasswordForm() {
    elements.loginUserBtn.parentElement.style.display = 'none';
    elements.adminPasswordForm.classList.remove('hidden');
    elements.adminPassword.focus();
}

/**
 * Cancelar login de admin
 */
function cancelAdminLogin() {
    elements.loginUserBtn.parentElement.style.display = 'block';
    elements.adminPasswordForm.classList.add('hidden');
    elements.adminPassword.value = '';
    elements.passwordError.classList.add('hidden');
}

/**
 * Validar contraseña de administrador
 */
async function validateAdminPassword() {
    const password = elements.adminPassword.value.trim();
    
    if (!password) {
        showPasswordError('Por favor ingresa la contraseña');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/validate-admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentUserRole = 'admin';
            localStorage.setItem('userRole', 'admin');
            applyRolePermissions();
            elements.loginModal.style.display = 'none';
            elements.adminPassword.value = '';
            elements.adminPasswordForm.classList.add('hidden');
            showToast('Bienvenido Administrador', 'success');
        } else {
            showPasswordError('Contraseña incorrecta');
        }
    } catch (error) {
        console.error('Error al validar contraseña:', error);
        showPasswordError('Error al validar. Intenta de nuevo.');
    }
}

/**
 * Mostrar error de contraseña
 */
function showPasswordError(message) {
    elements.passwordError.textContent = message;
    elements.passwordError.classList.remove('hidden');
    elements.adminPassword.classList.add('error');
}

/**
 * Cerrar sesión
 */
function logout() {
    localStorage.removeItem('userRole');
    localStorage.removeItem('userEmail');
    currentUserRole = null;
    currentUserEmail = null;
    
    // Resetear modal al estado inicial
    const modalBody = elements.loginUserBtn.parentElement;
    modalBody.style.display = 'flex';
    elements.adminPasswordForm.classList.add('hidden');
    elements.userEmailForm.classList.add('hidden');
    elements.adminPassword.value = '';
    elements.userEmail.value = '';
    elements.passwordError.classList.add('hidden');
    elements.emailError.textContent = '';
    elements.adminPassword.classList.remove('error');
    
    // Mostrar modal
    elements.loginModal.style.display = 'flex';
    
    // Regresar a vista de escáner
    switchView('scannerView');
}

/**
 * Aplicar permisos según el rol
 */
function applyRolePermissions() {
    // Actualizar badge de rol
    const roleText = currentUserRole === 'admin' ? 'Admin' : 'Usuario';
    const displayText = currentUserRole === 'admin' ? roleText : (currentUserEmail || roleText);
    elements.currentRole.textContent = displayText;
    elements.currentRole.className = `role-badge ${currentUserRole}`;
    
    // Ocultar/mostrar vista de estadísticas
    const statsNavBtn = document.querySelector('[data-view="statsView"]');
    
    if (currentUserRole === 'user') {
        // Usuario: ocultar estadísticas
        if (statsNavBtn) {
            statsNavBtn.style.display = 'none';
        }
        // Si está en vista de estadísticas, redirigir a escáner
        if (document.getElementById('statsView').classList.contains('active')) {
            switchView('scannerView');
        }
    } else {
        // Admin: mostrar todo
        if (statsNavBtn) {
            statsNavBtn.style.display = 'flex';
        }
    }
}

// ============================================
// NAVEGACIÓN ENTRE VISTAS
// ============================================

/**
 * Cambia entre las diferentes vistas de la aplicación
 */
function switchView(viewId) {
    // Ocultar todas las vistas
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });
    
    // Mostrar la vista seleccionada
    const targetView = document.getElementById(viewId);
    if (targetView) {
        targetView.classList.add('active');
    }
    
    // Actualizar botones de navegación
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const activeBtn = document.querySelector(`[data-view="${viewId}"]`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }
    
    // Cargar datos según la vista
    if (viewId === 'recordsView') {
        loadRecentScans();
    } else if (viewId === 'statsView') {
        loadStats();
    }
}

// Event listeners para navegación
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        const viewId = btn.getAttribute('data-view');
        switchView(viewId);
    });
});

// ============================================
// INICIALIZACIÓN
// ============================================

/**
 * Inicializa la aplicación cuando el DOM está listo
 */
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Iniciando QR Scanner Pro...');
    
    // Inicializar sistema de autenticación
    initAuth();
    
    // Inicializar escáner
    html5QrCode = new Html5Qrcode("reader");
    
    // Cargar cámaras disponibles
    await loadCameras();
    
    // Configurar event listeners
    setupEventListeners();
    
    // Cargar datos iniciales si está autenticado
    if (currentUserRole) {
        await loadRecentScans();
        if (currentUserRole === 'admin') {
            await loadStats();
        }
    }
    
    // Actualizar datos cada 30 segundos
    setInterval(async () => {
        if (!isScanning && currentUserRole) {
            await loadRecentScans();
            await loadStats();
        }
    }, 30000);
    
    showToast('Aplicación lista para escanear', 'success');
});

/**
 * Configura todos los event listeners
 */
function setupEventListeners() {
    // Event listeners de escaneo
    elements.startBtn.addEventListener('click', startScanning);
    elements.stopBtn.addEventListener('click', stopScanning);
    elements.clearResult.addEventListener('click', clearLastResult);
    elements.refreshBtn.addEventListener('click', () => {
        loadRecentScans();
        if (currentUserRole === 'admin') {
            loadStats();
        }
    });
    elements.exportBtn.addEventListener('click', exportToCSV);
    
    // Event listeners de autenticación
    elements.loginUserBtn.addEventListener('click', showUserEmailForm);
    elements.loginAdminBtn.addEventListener('click', showAdminPasswordForm);
    elements.submitUserBtn.addEventListener('click', validateUserEmail);
    elements.cancelUserBtn.addEventListener('click', cancelUserLogin);
    elements.submitAdminBtn.addEventListener('click', validateAdminPassword);
    elements.cancelAdminBtn.addEventListener('click', cancelAdminLogin);
    elements.logoutBtn.addEventListener('click', logout);
    
    // Enter en campo de email
    elements.userEmail.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            validateUserEmail();
        }
    });
    
    // Limpiar error al escribir email
    elements.userEmail.addEventListener('input', () => {
        elements.emailError.textContent = '';
    });
    
    // Enter en campo de contraseña
    elements.adminPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            validateAdminPassword();
        }
    });
    
    // Limpiar error al escribir
    elements.adminPassword.addEventListener('input', () => {
        elements.passwordError.classList.add('hidden');
        elements.adminPassword.classList.remove('error');
    });
    
    // Event listeners de estadísticas
    const filterReferencia = document.getElementById('filterReferencia');
    const exportStatsBtn = document.getElementById('exportStatsBtn');
    
    if (filterReferencia) {
        filterReferencia.addEventListener('change', (e) => {
            filterStatsByReferencia(e.target.value);
        });
    }
    
    if (exportStatsBtn) {
        exportStatsBtn.addEventListener('click', exportStatsToCSV);
    }
}

// ============================================
// GESTIÓN DE CÁMARAS
// ============================================

/**
 * Carga las cámaras disponibles en el dispositivo
 */
async function loadCameras() {
    try {
        const devices = await Html5Qrcode.getCameras();
        
        if (devices && devices.length > 0) {
            // Seleccionar la cámara trasera por defecto (si existe)
            const backCamera = devices.find(d => 
                d.label.toLowerCase().includes('back') || 
                d.label.toLowerCase().includes('trasera')
            );
            
            selectedCameraId = backCamera ? backCamera.id : devices[0].id;
            
            console.log(`✅ ${devices.length} cámara(s) detectada(s)`);
        } else {
            showToast('No se detectaron cámaras', 'error');
        }
    } catch (error) {
        console.error('Error al cargar cámaras:', error);
        showToast('Error al acceder a las cámaras', 'error');
    }
}

/**
 * Maneja el cambio de cámara seleccionada
 */
function handleCameraChange(event) {
    selectedCameraId = event.target.value;
    
    if (isScanning) {
        stopScanning();
        setTimeout(() => startScanning(), 500);
    }
}

// ============================================
// CONTROL DEL ESCÁNER
// ============================================

/**
 * Inicia el escaneo de códigos QR
 */
async function startScanning() {
    if (!selectedCameraId) {
        showToast('Por favor selecciona una cámara', 'warning');
        return;
    }
    
    try {
        const config = {
            fps: 10,
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1.0
        };
        
        await html5QrCode.start(
            selectedCameraId,
            config,
            onQRCodeScanned,
            onScanError
        );
        
        isScanning = true;
        updateScannerUI(true);
        updateStatus('🔍 Escaneando... Apunta la cámara al código QR', 'scanning');
        
    } catch (error) {
        console.error('Error al iniciar escáner:', error);
        showToast('No se pudo iniciar el escáner', 'error');
        updateScannerUI(false);
    }
}

/**
 * Detiene el escaneo de códigos QR
 */
async function stopScanning() {
    try {
        await html5QrCode.stop();
        isScanning = false;
        updateScannerUI(false);
        updateStatus('Escáner detenido', 'stopped');
    } catch (error) {
        console.error('Error al detener escáner:', error);
    }
}

/**
 * Callback cuando se escanea un código QR exitosamente
 */
async function onQRCodeScanned(decodedText, decodedResult) {
    console.log('✅ QR detectado:', decodedText);
    console.log('Contenido completo:', decodedText);
    console.log('Longitud:', decodedText.length);
    
    // Pausar temporalmente el escaneo
    await stopScanning();
    
    // Validar que no esté vacío
    if (!decodedText || decodedText.trim() === '') {
        showToast('⚠️ QR vacío o inválido', 'warning');
        updateStatus('❌ QR vacío detectado', 'error');
        setTimeout(() => startScanning(), 2000);
        return;
    }
    
    // Guardar el QR
    await saveQRCode(decodedText);
    
    // Reanudar escaneo después de 2 segundos
    setTimeout(() => {
        if (!isScanning) {
            startScanning();
        }
    }, 2000);
}

/**
 * Callback cuando hay un error en el escaneo (normal si no detecta QR)
 */
function onScanError(errorMessage) {
    // No mostrar errores comunes de "no QR detectado"
    // Solo logear errores importantes
    if (!errorMessage.includes('No MultiFormat Readers')) {
        console.debug('Scan error:', errorMessage);
    }
}

/**
 * Actualiza la interfaz según el estado del escáner
 */
function updateScannerUI(scanning) {
    elements.startBtn.disabled = scanning;
    elements.stopBtn.disabled = !scanning;
    
    if (scanning) {
        elements.startBtn.classList.add('disabled');
        elements.stopBtn.classList.remove('disabled');
    } else {
        elements.startBtn.classList.remove('disabled');
        elements.stopBtn.classList.add('disabled');
    }
}

/**
 * Actualiza el mensaje de estado del escáner
 */
function updateStatus(message, type = 'info') {
    elements.scannerStatus.textContent = message;
    elements.scannerStatus.className = `scanner-status ${type}`;
}

// ============================================
// GESTIÓN DE DATOS
// ============================================

/**
 * Guarda un código QR escaneado en el backend
 */
async function saveQRCode(qrContent) {
    try {
        updateStatus('💾 Guardando...', 'saving');
        
        const response = await fetch(`${API_URL}/api/save-qr`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                qrContent,
                userEmail: currentUserEmail
            })
        });

        const contentType = response.headers.get('content-type') || '';
        const responseText = await response.text();

        // Verificar si la respuesta es válida
        if (!response.ok) {
            // Intentar obtener detalles del error
            let errorMessage = `Error del servidor: ${response.status}`;
            try {
                if (contentType.includes('application/json') && responseText) {
                    const errorData = JSON.parse(responseText);
                    errorMessage = errorData.error || errorMessage;
                }

                // Si el error es de formato, mostrar el contenido del QR
                if (response.status === 400) {
                    console.log('📋 Contenido QR escaneado:', qrContent);
                    showToast(`⚠️ Formato inválido. QR: "${qrContent.substring(0, 40)}..."`, 'warning');
                    updateStatus(`⚠️ ${errorMessage}`, 'warning');
                    return;
                }
            } catch (e) {
                console.log('Error al parsear respuesta de error:', e);
            }

            // Si no es JSON, dar pista útil
            if (!contentType.includes('application/json')) {
                const hint = responseText.includes('<!DOCTYPE html>')
                    ? 'La respuesta parece HTML (sitio estático o ruta incorrecta).'
                    : 'La respuesta no es JSON.';
                throw new Error(`${errorMessage}. ${hint}`);
            }

            throw new Error(errorMessage);
        }

        // Intentar parsear JSON
        let result;
        try {
            if (!contentType.includes('application/json')) {
                throw new Error('Respuesta no es JSON');
            }
            result = JSON.parse(responseText);
        } catch (jsonError) {
            console.error('Error al parsear JSON:', jsonError);
            console.log('📋 Contenido QR que causó el error:', qrContent);
            console.log('📋 Respuesta del servidor:', responseText);
            showToast(`⚠️ QR detectado: "${qrContent.substring(0, 40)}..."`, 'warning');
            throw new Error('El servidor no devolvió una respuesta válida');
        }
        
        if (result.success) {
            const action = result.action;
            
            if (action === 'stored') {
                // Primer escaneo - EN ALMACEN
                showToast('✅ Producto registrado EN ALMACEN', 'success');
                updateStatus(`✅ ${result.data.referencia} | ${result.data.serial} - EN ALMACEN`, 'success');
                displayLastResult(result.data, 'EN ALMACEN');
            } else if (action === 'dispatched') {
                // Segundo escaneo - DESPACHADO
                showToast('📦 Producto marcado como DESPACHADO', 'success');
                updateStatus(`📦 ${result.data.referencia} | ${result.data.serial} - DESPACHADO`, 'success');
                displayLastResult(result.data, 'DESPACHADO');
            } else if (action === 'already_dispatched') {
                // Ya fue despachado antes
                showToast('⚠️ Producto ya fue DESPACHADO', 'warning');
                updateStatus(`⚠️ ${result.data.referencia} | ${result.data.serial} - Ya despachado`, 'warning');
                displayLastResult(result.data, 'DESPACHADO');
            }
            
            // Actualizar registros y estadísticas
            await loadRecentScans();
            await loadStats();
        } else {
            throw new Error(result.error || 'Error desconocido');
        }
        
    } catch (error) {
        console.error('Error al guardar QR:', error);
        showToast('Error: ' + error.message, 'error');
        updateStatus('❌ Error al guardar', 'error');
    }
}

/**
 * Carga los registros recientes desde el backend
 */
async function loadRecentScans() {
    try {
        const response = await fetch(`${API_URL}/api/recent-scans?limit=20`);
        const result = await response.json();
        
        if (result.success && result.data.length > 0) {
            displayRecords(result.data);
        } else {
            elements.recordsBody.innerHTML = `
                <tr>
                    <td colspan="6" class="no-data">No hay registros para mostrar</td>
                </tr>
            `;
        }
    } catch (error) {
        console.error('Error al cargar registros:', error);
        showToast('Error al cargar registros', 'error');
    }
}

/**
 * Carga las estadísticas desde el backend
 */
async function loadStats() {
    try {
        // Obtener estadísticas generales
        const response = await fetch(`${API_URL}/api/stats`);
        const result = await response.json();
        
        if (result.success) {
            displayStats(result.data);
        }
        
        // Obtener todos los registros para mostrar en tabla
        const scansResponse = await fetch(`${API_URL}/api/recent-scans?limit=10000`);
        const scansResult = await scansResponse.json();
        
        if (scansResult.success) {
            allStatsData = scansResult.data || [];
            displayStatsTable(allStatsData);
            populateReferenciasSelect(); // Llenar el select con referencias únicas
        }
    } catch (error) {
        console.error('Error al cargar estadísticas:', error);
        showToast('Error al cargar estadísticas', 'error');
    }
}

// ============================================
// INTERFAZ DE USUARIO
// ============================================

/**
 * Muestra el último resultado escaneado
 */
function displayLastResult(data, estado) {
    const estadoClass = estado === 'EN ALMACEN' ? 'almacen' : 'despachado';
    const estadoEmoji = estado === 'EN ALMACEN' ? '📦' : '🚚';
    
    elements.resultType.innerHTML = `<span class="type-badge type-${estadoClass}">${estadoEmoji} ${estado}</span>`;
    
    elements.resultData.innerHTML = `
        <div class="qr-details">
            <div class="qr-field">
                <strong>Referencia:</strong> ${data.referencia}
            </div>
            <div class="qr-field">
                <strong>Serial:</strong> ${data.serial}
            </div>
            <div class="qr-field">
                <strong>Fecha Almacén:</strong> ${data.fechaAlmacen || 'N/A'}
            </div>
            ${data.fechaDespacho ? `<div class="qr-field"><strong>Fecha Despacho:</strong> ${data.fechaDespacho}</div>` : ''}
        </div>
    `;
    
    const now = new Date();
    elements.resultMeta.textContent = `Escaneado: ${now.toLocaleString('es-ES')}`;
    
    elements.lastResult.classList.remove('hidden');
}

/**
 * Limpia el último resultado mostrado
 */
function clearLastResult() {
    elements.lastResult.classList.add('hidden');
}

/**
 * Muestra los registros en la tabla
 */
function displayRecords(records) {
    elements.recordsBody.innerHTML = records.map(record => {
        const estadoClass = record.estado === 'EN ALMACEN' ? 'almacen' : 'despachado';
        const estadoEmoji = record.estado === 'EN ALMACEN' ? '📦' : '🚚';
        
        return `
            <tr>
                <td><span class="id-badge">#${record.id}</span></td>
                <td class="content-cell"><strong>${record.referencia}</strong></td>
                <td class="content-cell">${record.serial}</td>
                <td><span class="type-badge type-${estadoClass}">${estadoEmoji} ${record.estado}</span></td>
                <td>${record.fechaAlmacen} <small>${record.horaAlmacen || ''}</small></td>
                <td>${record.fechaDespacho || '-'} <small>${record.horaDespacho || ''}</small></td>
            </tr>
        `;
    }).join('');
}

/**
 * Muestra las estadísticas
 */
/**
 * Calcula las estadísticas basadas en los datos filtrados
 */
function calculateStats(data) {
    const total = data.length;
    const enAlmacen = data.filter(row => row.estado === 'EN ALMACEN').length;
    const despachados = data.filter(row => row.estado === 'DESPACHADO').length;
    
    return {
        total,
        enAlmacen,
        despachados,
        today: 0 // El today se mantiene del original
    };
}

/**
 * Actualiza las estadísticas mostradas basadas en los datos filtrados
 */
function updateDisplayStats(data) {
    const stats = calculateStats(data);
    
    const statsData = [
        { label: 'En Almacén', count: stats.enAlmacen, emoji: '📦', class: 'almacen' },
        { label: 'Despachados', count: stats.despachados, emoji: '🚚', class: 'despachado' }
    ];
    
    elements.statsContainer.innerHTML = statsData.map(stat => {
        const percentage = stats.total > 0 ? ((stat.count / stats.total) * 100).toFixed(1) : 0;
        
        return `
            <div class="stat-card">
                <div class="stat-icon">${stat.emoji}</div>
                <div class="stat-info">
                    <div class="stat-type">${stat.label}</div>
                    <div class="stat-count">${stat.count}</div>
                    <div class="stat-percentage">${percentage}%</div>
                </div>
                <div class="stat-bar">
                    <div class="stat-bar-fill stat-bar-${stat.class}" style="width: ${percentage}%"></div>
                </div>
            </div>
        `;
    }).join('');
}

function displayStats(stats) {
    elements.totalScans.textContent = stats.total;
    elements.todayScans.textContent = stats.today;
    
    const statsData = [
        { label: 'En Almacén', count: stats.enAlmacen, emoji: '📦', class: 'almacen' },
        { label: 'Despachados', count: stats.despachados, emoji: '🚚', class: 'despachado' }
    ];
    
    elements.statsContainer.innerHTML = statsData.map(stat => {
        const percentage = stats.total > 0 ? ((stat.count / stats.total) * 100).toFixed(1) : 0;
        
        return `
            <div class="stat-card">
                <div class="stat-icon">${stat.emoji}</div>
                <div class="stat-info">
                    <div class="stat-type">${stat.label}</div>
                    <div class="stat-count">${stat.count}</div>
                    <div class="stat-percentage">${percentage}%</div>
                </div>
                <div class="stat-bar">
                    <div class="stat-bar-fill stat-bar-${stat.class}" style="width: ${percentage}%"></div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Muestra la tabla de registros en la vista de estadísticas
 */
function displayStatsTable(data) {
    const statsTableBody = document.getElementById('statsTableBody');
    const totalCount = document.getElementById('totalCount');
    const totalLabel = document.getElementById('totalLabel');
    
    // Guardar datos filtrados actuales
    currentFilteredData = data;
    
    // Actualizar estadísticas (almacén, despachados)
    updateDisplayStats(data);
    
    // Actualizar total y label
    if (totalCount) {
        totalCount.textContent = data.length;
    }
    
    // Actualizar label dinámico
    if (totalLabel) {
        const selectedRef = document.getElementById('filterReferencia').value;
        if (selectedRef) {
            totalLabel.textContent = `Total de Registros - ${selectedRef}`;
        } else {
            totalLabel.textContent = 'Total de Registros';
        }
    }
    
    if (!data || data.length === 0) {
        statsTableBody.innerHTML = '<tr><td colspan="5" class="no-data">No hay datos para mostrar</td></tr>';
        return;
    }
    
    statsTableBody.innerHTML = data.map(row => `
        <tr>
            <td>${row.referencia || 'N/A'}</td>
            <td>${row.serial || 'N/A'}</td>
            <td>
                <span class="type-badge type-${row.estado === 'EN ALMACEN' ? 'almacen' : 'despachado'}">
                    ${row.estado || 'N/A'}
                </span>
            </td>
            <td>${row.fechaAlmacen || 'N/A'}</td>
            <td>${row.fechaDespacho || 'N/A'}</td>
        </tr>
    `).join('');
}

/**
 * Llena el select de referencias únicas
 */
function populateReferenciasSelect() {
    const filterSelect = document.getElementById('filterReferencia');
    
    if (!filterSelect || !allStatsData.length) return;
    
    // Obtener referencias únicas
    const referencias = [...new Set(allStatsData.map(row => row.referencia).filter(Boolean))].sort();
    
    // Guardar la opción "Todas"
    const currentValue = filterSelect.value;
    
    // Reconstruir opciones
    filterSelect.innerHTML = '<option value="">Todas las referencias</option>';
    referencias.forEach(ref => {
        const option = document.createElement('option');
        option.value = ref;
        option.textContent = ref;
        filterSelect.appendChild(option);
    });
    
    // Restaurar selección
    filterSelect.value = currentValue;
}

/**
 * Filtra los registros de estadísticas por referencia (select)
 */
function filterStatsByReferencia(referencia = '') {
    let filtered = allStatsData;
    
    if (referencia) {
        filtered = allStatsData.filter(row => row.referencia === referencia);
    }
    
    displayStatsTable(filtered);
}

/**
 * Exporta los datos de estadísticas a CSV
 */
function exportStatsToCSV() {
    if (!currentFilteredData || currentFilteredData.length === 0) {
        showToast('No hay datos para exportar', 'warning');
        return;
    }
    
    // Headers del CSV (sin ID)
    const headers = ['REFERENCIA', 'SERIAL', 'ESTADO', 'FECHA_ALMACEN', 'FECHA_DESPACHO', 'HORA_ALMACEN', 'HORA_DESPACHO'];
    
    // Datos (sin ID)
    const rows = currentFilteredData.map(row => [
        row.referencia || '',
        row.serial || '',
        row.estado || '',
        row.fechaAlmacen || '',
        row.fechaDespacho || '',
        row.horaAlmacen || '',
        row.horaDespacho || ''
    ]);
    
    // Crear contenido CSV
    let csvContent = headers.join(',') + '\n';
    rows.forEach(row => {
        csvContent += row.map(cell => `"${cell}"`).join(',') + '\n';
    });
    
    // Crear y descargar archivo
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    // Nombre del archivo con referencia si está filtrada
    const selectedRef = document.getElementById('filterReferencia').value;
    const filename = selectedRef 
        ? `estadisticas-${selectedRef}-${new Date().toISOString().split('T')[0]}.csv`
        : `estadisticas-${new Date().toISOString().split('T')[0]}.csv`;
    
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast('Datos exportados exitosamente', 'success');
}

/**
 * Muestra una notificación toast
 */
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    elements.toastContainer.appendChild(toast);
    
    // Animar entrada
    setTimeout(() => toast.classList.add('show'), 100);
    
    // Remover después de 3 segundos
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * Exporta los registros a un archivo CSV
 */
async function exportToCSV() {
    try {
        const response = await fetch(`${API_URL}/api/recent-scans?limit=1000`);
        const result = await response.json();
        
        if (!result.success || result.data.length === 0) {
            showToast('No hay datos para exportar', 'warning');
            return;
        }
        
        // Crear CSV
        const headers = ['ID', 'Referencia', 'Serial', 'Estado', 'Fecha Almacén', 'Hora Almacén', 'Fecha Despacho', 'Hora Despacho'];
        const rows = result.data.map(r => [
            r.id, 
            `"${r.referencia}"`, 
            `"${r.serial}"`, 
            r.estado,
            r.fechaAlmacen, 
            r.horaAlmacen || '',
            r.fechaDespacho || '', 
            r.horaDespacho || ''
        ]);
        
        const csv = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');
        
        // Descargar archivo
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `inventario-qr-${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
        
        showToast('Archivo CSV descargado', 'success');
        
    } catch (error) {
        console.error('Error al exportar:', error);
        showToast('Error al exportar datos', 'error');
    }
}

// ============================================
// FUNCIONES AUXILIARES
// ============================================

/**
 * Trunca un texto largo
 */
function truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}
