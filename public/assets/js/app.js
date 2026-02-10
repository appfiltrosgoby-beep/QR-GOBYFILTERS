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
let currentUserRole = null; // 'user', 'admin', 'superadmin', 'dispatch'
let currentUsername = null; // Usuario logueado
let currentUserPassword = null; // Contraseña del usuario logueado (admin/superadmin)
let currentUserClient = null; // Cliente del usuario logueado
let currentUserType = null; // Tipo de usuario: 'mecanico', 'despacho', 'administrador', 'super'
let allStatsData = []; // Guardar todos los datos de estadísticas para filtrado
let currentFilteredData = []; // Guardar datos filtrados actual
let editingUser = null; // Usuario que se está editando (para el formulario de usuarios)
let allRecordsData = []; // Guardar todos los registros para filtrado
let allUsersData = []; // Guardar todos los usuarios para filtrado

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
    userLoginForm: document.getElementById('userLoginForm'),
    userUsername: document.getElementById('userUsername'),
    userPassword: document.getElementById('userPassword'),
    submitUserBtn: document.getElementById('submitUserBtn'),
    cancelUserBtn: document.getElementById('cancelUserBtn'),
    userError: document.getElementById('userError'),
    adminLoginForm: document.getElementById('adminLoginForm'),
    adminUsername: document.getElementById('adminUsername'),
    adminPassword: document.getElementById('adminPassword'),
    submitAdminEmailBtn: document.getElementById('submitAdminEmailBtn'),
    cancelAdminEmailBtn: document.getElementById('cancelAdminEmailBtn'),
    adminError: document.getElementById('adminError'),
    passwordError: document.getElementById('passwordError'),
    logoutBtn: document.getElementById('logoutBtn'),
    currentRole: document.getElementById('currentRole'),
    newUserUsername: document.getElementById('newUserUsername'),
    newUserPassword: document.getElementById('newUserPassword'),
    newUserClient: document.getElementById('newUserClient'),
    newUserType: document.getElementById('newUserType'),
    createUserBtn: document.getElementById('createUserBtn'),
    updateUserBtn: document.getElementById('updateUserBtn'),
    cancelEditBtn: document.getElementById('cancelEditBtn'),
    userFormError: document.getElementById('userFormError'),
    refreshUsersBtn: document.getElementById('refreshUsersBtn'),
    usersBody: document.getElementById('usersBody'),
    clientSelectorContainer: document.getElementById('clientSelectorContainer'),
    selectedClient: document.getElementById('selectedClient')
};

// ============================================
// SISTEMA DE AUTENTICACIÓN
// ============================================

/**
 * Inicializa el sistema de autenticación
 */
function initAuth() {
    const savedRole = localStorage.getItem('userRole');
    const savedUserName = localStorage.getItem('userName') || localStorage.getItem('userEmail');
    const savedPassword = sessionStorage.getItem('userPassword');
    const savedClient = localStorage.getItem('userClient');
    
    if (savedRole) {
        if (savedRole === 'superadmin' && !savedPassword) {
            localStorage.removeItem('userRole');
            localStorage.removeItem('userName');
            localStorage.removeItem('userClient');
            elements.loginModal.style.display = 'flex';
            return;
        }

        currentUserRole = savedRole;
        if (savedUserName) {
            currentUsername = savedUserName;
        }
        if (savedPassword) {
            currentUserPassword = savedPassword;
        }
        if (savedClient) {
            currentUserClient = savedClient;
        }
        applyRolePermissions();
        elements.loginModal.style.display = 'none';
    } else {
        elements.loginModal.style.display = 'flex';
    }
}

/**
 * Mostrar formulario de email para usuario (mecánico o despacho)
 */
function showUserEmailForm() {
    elements.loginUserBtn.parentElement.style.display = 'none';
    elements.adminLoginForm.classList.add('hidden');
    elements.userLoginForm.classList.remove('hidden');
    elements.userError.classList.add('hidden');
    currentLoginType = 'user'; // Acepta mecánico y despacho
    elements.userUsername.focus();
}

/**
 * Mostrar formulario de email para administrador
 */
function showAdminEmailForm() {
    elements.loginUserBtn.parentElement.style.display = 'none';
    elements.userLoginForm.classList.add('hidden');
    elements.adminLoginForm.classList.remove('hidden');
    elements.adminError.classList.add('hidden');
    elements.adminUsername.focus();
}

/**
 * Cancelar login de usuario
 */
function cancelUserLogin() {
    elements.userLoginForm.classList.add('hidden');
    elements.loginUserBtn.parentElement.style.display = 'block';
    elements.userUsername.value = '';
    elements.userPassword.value = '';
    elements.userError.textContent = '';
    elements.userError.classList.add('hidden');
}

/**
 * Cancelar login de admin por email
 */
function cancelAdminEmailLogin() {
    elements.adminLoginForm.classList.add('hidden');
    elements.loginUserBtn.parentElement.style.display = 'block';
    elements.adminUsername.value = '';
    elements.adminPassword.value = '';
    elements.adminError.textContent = '';
    elements.adminError.classList.add('hidden');
}

/**
 * Validar email del usuario
 */
async function validateUserLogin() {
    const usuario = elements.userUsername.value.trim();
    const password = elements.userPassword.value.trim();

    if (!usuario || !password) {
        elements.userError.textContent = 'Usuario y contraseña son requeridos';
        elements.userError.classList.remove('hidden');
        return;
    }

    const result = await validateCredentials(usuario, currentLoginType, password);
    if (!result.success) {
        elements.userError.textContent = result.message || 'Credenciales inválidas';
        elements.userError.classList.remove('hidden');
        return;
    }

    currentUsername = usuario;
    currentUserPassword = password;
    currentUserClient = result.cliente || '';
    currentUserRole = result.role || 'user'; // Guardar el rol retornado
    currentUserType = result.tipo || 'mecanico'; // Guardar el tipo del usuario
    localStorage.setItem('userName', usuario);
    localStorage.setItem('userClient', result.cliente || '');
    localStorage.setItem('userRole', currentUserRole);
    localStorage.setItem('userType', currentUserType);
    sessionStorage.setItem('userPassword', password);
    
    // Aplicar permisos según el tipo de usuario
    applyRolePermissions();
    
    // Cerrar modal de login
    elements.loginModal.style.display = 'none';
    elements.userLoginForm.classList.add('hidden');
    elements.userUsername.value = '';
    elements.userPassword.value = '';
    elements.userError.textContent = '';
    elements.userError.classList.add('hidden');
    showToast(`Bienvenido ${currentUsername || 'Usuario'}`, 'success');
}

/**
 * Validar email del administrador
 */
async function validateAdminLogin() {
    const usuario = elements.adminUsername.value.trim();
    const password = elements.adminPassword.value.trim();

    if (!usuario || !password) {
        elements.adminError.textContent = 'Usuario y contraseña son requeridos';
        elements.adminError.classList.remove('hidden');
        return;
    }

    const result = await validateCredentials(usuario, 'administrador', password);
    if (!result.success) {
        elements.adminError.textContent = result.message || 'Credenciales inválidas';
        elements.adminError.classList.remove('hidden');
        return;
    }

    currentUsername = usuario;
    currentUserPassword = password;
    currentUserClient = result.cliente || '';
    localStorage.setItem('userName', usuario);
    localStorage.setItem('userClient', result.cliente || '');
    sessionStorage.setItem('userPassword', password);
    if (result.role === 'superadmin') {
        currentUserRole = 'superadmin';
        localStorage.setItem('userRole', 'superadmin');
        applyRolePermissions();
        elements.loginModal.style.display = 'none';
        elements.adminLoginForm.classList.add('hidden');
        elements.adminUsername.value = '';
        elements.adminPassword.value = '';
        elements.adminError.textContent = '';
        elements.adminError.classList.add('hidden');
        showToast('Bienvenido Superadmin', 'success');
        return;
    }
    loginAsAdmin();
}

/**
 * Login como admin
 */
function loginAsAdmin() {
    currentUserRole = 'admin';
    localStorage.setItem('userRole', 'admin');
    applyRolePermissions();
    elements.loginModal.style.display = 'none';
    elements.adminLoginForm.classList.add('hidden');
    elements.adminUsername.value = '';
    elements.adminPassword.value = '';
    elements.adminError.textContent = '';
    elements.adminError.classList.add('hidden');
    showToast('Bienvenido Administrador', 'success');
}

/**
 * Valida email contra el backend y rol
 */
async function validateCredentials(usuario, tipo, password) {
    try {
        const response = await fetch(`${API_URL}/api/validate-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, tipo, password })
        });

        const data = await response.json();
        if (data && data.success) {
            return { 
                success: true, 
                role: data.role || 'user',
                tipo: data.tipo || 'mecanico',
                cliente: data.cliente || ''
            };
        }
        return { success: false, message: data && data.message ? data.message : '' };
    } catch (error) {
        console.error('Error validando usuario:', error);
        showToast('Error al validar usuario', 'error');
        return { success: false };
    }
}

/**
 * Login como usuario (sin contraseña)
 */


/**
 * Cerrar sesión
 */
function logout() {
    localStorage.removeItem('userRole');
    localStorage.removeItem('userName');
    localStorage.removeItem('userClient');
    sessionStorage.removeItem('userPassword');
    currentUserRole = null;
    currentUsername = null;
    currentUserPassword = null;
    currentUserClient = null;
    
    // Resetear modal al estado inicial
    const modalBody = elements.loginUserBtn.parentElement;
    modalBody.style.display = 'flex';
    elements.adminLoginForm.classList.add('hidden');
    elements.userLoginForm.classList.add('hidden');
    elements.adminUsername.value = '';
    elements.adminPassword.value = '';
    elements.userUsername.value = '';
    elements.userPassword.value = '';
    elements.passwordError.classList.add('hidden');
    elements.userError.textContent = '';
    elements.userError.classList.add('hidden');
    elements.adminError.textContent = '';
    elements.adminError.classList.add('hidden');
    
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
    let roleText = 'Usuario';
    if (currentUserRole === 'superadmin') {
        roleText = 'Superadmin';
    } else if (currentUserRole === 'admin') {
        roleText = 'Admin';
    } else if (currentUserRole === 'dispatch' && currentUserType === 'despacho') {
        roleText = 'Despacho';
    } else if (currentUserRole === 'user' && currentUserType === 'mecanico') {
        roleText = 'Mecánico';
    }
    
    const displayText = (currentUserRole === 'user' || currentUserRole === 'dispatch')
        ? (currentUsername || roleText)
        : roleText;
    elements.currentRole.textContent = displayText;
    elements.currentRole.className = `role-badge ${currentUserRole}`;
    
    // Ocultar/mostrar vistas
    const statsNavBtn = document.querySelector('[data-view="statsView"]');
    const usersNavBtn = document.querySelector('[data-view="usersView"]');
    const scannerNavBtn = document.querySelector('[data-view="scannerView"]');
    
    if (currentUserRole === 'user' && currentUserType === 'mecanico') {
        // Usuario mecánico: ocultar estadísticas y usuarios, mostrar escáner sin selector
        if (statsNavBtn) {
            statsNavBtn.style.display = 'none';
        }
        if (usersNavBtn) {
            usersNavBtn.style.display = 'none';
        }
        if (scannerNavBtn) {
            scannerNavBtn.style.display = 'flex';
        }
        // Ocultar selector de cliente para mecánicos
        if (elements.clientSelectorContainer) {
            elements.clientSelectorContainer.classList.add('hidden');
        }
        // Si está en vista de estadísticas/usuarios, redirigir a escáner
        if (document.getElementById('statsView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('usersView').classList.contains('active')) {
            switchView('scannerView');
        }
    } else if (currentUserRole === 'dispatch' && currentUserType === 'despacho') {
        // Usuario despacho: ocultar estadísticas y usuarios, mostrar selector de cliente
        if (statsNavBtn) {
            statsNavBtn.style.display = 'none';
        }
        if (usersNavBtn) {
            usersNavBtn.style.display = 'none';
        }
        if (scannerNavBtn) {
            scannerNavBtn.style.display = 'flex';
        }
        // Mostrar selector de cliente para usuarios despacho
        if (elements.clientSelectorContainer) {
            elements.clientSelectorContainer.classList.remove('hidden');
            loadClientsSelect();
        }
        // Si está en vista de estadísticas/usuarios, redirigir a escáner
        if (document.getElementById('statsView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('usersView').classList.contains('active')) {
            switchView('scannerView');
        }
    } else if (currentUserRole === 'admin') {
        // Admin: ocultar estadísticas y selector, mostrar escáner, registros y usuarios
        if (statsNavBtn) {
            statsNavBtn.style.display = 'none';
        }
        if (usersNavBtn) {
            usersNavBtn.style.display = 'flex';
        }
        if (scannerNavBtn) {
            scannerNavBtn.style.display = 'flex';
        }
        // Ocultar selector de cliente para admins
        if (elements.clientSelectorContainer) {
            elements.clientSelectorContainer.classList.add('hidden');
        }
        // Si está en vista de estadísticas, redirigir a escáner
        if (document.getElementById('statsView').classList.contains('active')) {
            switchView('scannerView');
        }
        
        // Ocultar formulario de crear usuarios (solo pueden ver)
        const userForm = document.querySelector('.user-form');
        if (userForm) {
            userForm.style.display = 'none';
        }
    } else {
        // Superadmin: mostrar estadísticas, registros y usuarios (ocultar escáner)
        if (statsNavBtn) {
            statsNavBtn.style.display = 'flex';
        }
        if (usersNavBtn) {
            usersNavBtn.style.display = 'flex';
        }
        if (scannerNavBtn) {
            scannerNavBtn.style.display = 'none';
        }
        // Ocultar selector de cliente para superadmin
        if (elements.clientSelectorContainer) {
            elements.clientSelectorContainer.classList.add('hidden');
        }
        if (document.getElementById('scannerView').classList.contains('active')) {
            switchView('recordsView');
        }
        
        // Mostrar formulario de crear usuarios (solo superadmin)
        const userForm = document.querySelector('.user-form');
        if (userForm) {
            userForm.style.display = 'block';
        }
    }
    
    // Mostrar/ocultar filtros de cliente según el rol (para todos los roles)
    const filterClienteRecords = document.getElementById('filterClienteRecords');
    const filterClienteUsers = document.getElementById('filterClienteUsers');
    const filterClienteStats = document.getElementById('filterClienteStats');
    
    if (filterClienteRecords) {
        filterClienteRecords.style.display = currentUserRole === 'superadmin' ? 'inline-block' : 'none';
    }
    if (filterClienteUsers) {
        filterClienteUsers.style.display = currentUserRole === 'superadmin' ? 'inline-block' : 'none';
    }
    if (filterClienteStats) {
        filterClienteStats.style.display = currentUserRole === 'superadmin' ? 'inline-block' : 'none';
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
    } else if (viewId === 'usersView') {
        loadUsers();
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
        if (currentUserRole === 'admin' || currentUserRole === 'superadmin') {
            await loadStats();
        }
    }
    
    // Actualizar datos cada 30 segundos
    setInterval(async () => {
        if (!isScanning && currentUserRole) {
            await loadRecentScans();
            if (currentUserRole === 'admin' || currentUserRole === 'superadmin') {
                await loadStats();
            }
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
        if (currentUserRole === 'admin' || currentUserRole === 'superadmin') {
            loadStats();
        }
    });
    elements.exportBtn.addEventListener('click', exportToCSV);
    
    // Event listeners de autenticación
    elements.loginUserBtn.addEventListener('click', showUserEmailForm);
    elements.loginDispatchBtn.addEventListener('click', showDispatchEmailForm);
    elements.loginAdminBtn.addEventListener('click', showAdminEmailForm);
    elements.submitUserBtn.addEventListener('click', validateUserLogin);
    elements.cancelUserBtn.addEventListener('click', cancelUserLogin);
    elements.submitAdminEmailBtn.addEventListener('click', validateAdminLogin);
    elements.cancelAdminEmailBtn.addEventListener('click', cancelAdminEmailLogin);
    elements.logoutBtn.addEventListener('click', logout);
    
    // Enter en campo de usuario (mecánico)
    elements.userUsername.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            validateUserLogin();
        }
    });

    elements.userPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            validateUserLogin();
        }
    });

    // Limpiar error al escribir usuario/contraseña
    elements.userUsername.addEventListener('input', () => {
        elements.userError.textContent = '';
        elements.userError.classList.add('hidden');
    });
    elements.userPassword.addEventListener('input', () => {
        elements.userError.textContent = '';
        elements.userError.classList.add('hidden');
    });
    
    // Enter en campo de usuario admin
    elements.adminUsername.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            validateAdminLogin();
        }
    });

    elements.adminPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            validateAdminLogin();
        }
    });

    // Limpiar error al escribir admin
    elements.adminUsername.addEventListener('input', () => {
        elements.adminError.textContent = '';
        elements.adminError.classList.add('hidden');
    });
    elements.adminPassword.addEventListener('input', () => {
        elements.adminError.textContent = '';
        elements.adminError.classList.add('hidden');
    });

    // Event listeners de gestión de usuarios
    if (elements.createUserBtn) {
        elements.createUserBtn.addEventListener('click', createUser);

        if (elements.updateUserBtn) {
            elements.updateUserBtn.addEventListener('click', updateUser);
        }

        if (elements.cancelEditBtn) {
            elements.cancelEditBtn.addEventListener('click', cancelEditUser);
        }
    }

    if (elements.newUserUsername) {
        elements.newUserUsername.addEventListener('input', () => {
            elements.userFormError.classList.add('hidden');
            elements.userFormError.textContent = '';
        });
    }

    if (elements.refreshUsersBtn) {
        elements.refreshUsersBtn.addEventListener('click', loadUsers);
    }
    
    // Event listeners de estadísticas
    const filterReferencia = document.getElementById('filterReferencia');
    const exportStatsBtn = document.getElementById('exportStatsBtn');
    const filterClienteRecords = document.getElementById('filterClienteRecords');
    const filterClienteUsers = document.getElementById('filterClienteUsers');
    const filterClienteStats = document.getElementById('filterClienteStats');
    
    if (filterReferencia) {
        filterReferencia.addEventListener('change', (e) => {
            filterStats();
        });
    }
    
    if (filterClienteRecords) {
        filterClienteRecords.addEventListener('change', (e) => {
            filterRecordsByCliente(e.target.value);
        });
    }
    
    if (filterClienteUsers) {
        filterClienteUsers.addEventListener('change', (e) => {
            filterUsersByCliente(e.target.value);
        });
    }
    
    if (filterClienteStats) {
        filterClienteStats.addEventListener('change', (e) => {
            filterStats();
        });
    }
    
    if (exportStatsBtn) {
        exportStatsBtn.addEventListener('click', exportStatsToCSV);
    }

    // Event listener para toggle de contraseña (delegado)
    document.addEventListener('click', (e) => {
        const toggleBtn = e.target.closest('.toggle-password-btn');
        if (!toggleBtn) return;

        e.preventDefault();
        const targetId = toggleBtn.getAttribute('data-target');
        const passwordInput = document.getElementById(targetId);

        if (passwordInput) {
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                toggleBtn.classList.add('visible');
            } else {
                passwordInput.type = 'password';
                toggleBtn.classList.remove('visible');
            }
        }
    });
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
    if (currentUserRole === 'superadmin') {
        showToast('El superadmin no tiene permiso para escanear', 'warning');
        return;
    }
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
 * Carga la lista de clientes en el selector
 */
async function loadClientsSelect() {
    try {
        const response = await fetch(`${API_URL}/api/clients`);
        const result = await response.json();

        if (result.success && result.data) {
            // Limpiar opciones excepto la primera
            elements.selectedClient.innerHTML = '<option value="">-- Seleccionar Cliente --</option>';
            
            // Agregar opciones de clientes
            result.data.forEach(client => {
                const option = document.createElement('option');
                option.value = client.nombre;
                option.textContent = client.nombre;
                elements.selectedClient.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error al cargar clientes:', error);
        showToast('⚠️ Error al cargar lista de clientes', 'warning');
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
        
        // Para usuarios despacho: validar que haya seleccionado cliente
        let userClientToUse = currentUserClient;
        if (currentUserRole === 'dispatch') {
            userClientToUse = elements.selectedClient.value;
            if (!userClientToUse) {
                showToast('⚠️ Debes seleccionar un cliente antes de escanear', 'warning');
                updateStatus('⚠️ Selecciona un cliente', 'warning');
                return;
            }
        }
        
        const response = await fetch(`${API_URL}/api/save-qr`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                qrContent,
                userEmail: currentUsername,
                userClient: userClientToUse,
                userTipo: currentUserType
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
                showToast('� Producto marcado como DESPACHADO', 'success');
                updateStatus(`🚚 ${result.data.referencia} | ${result.data.serial} - DESPACHADO`, 'success');
                displayLastResult(result.data, 'DESPACHADO');
            } else if (action === 'installed') {
                // Tercer escaneo - INSTALADO
                showToast('🔧 Producto marcado como INSTALADO', 'success');
                updateStatus(`🔧 ${result.data.referencia} | ${result.data.serial} - INSTALADO`, 'success');
                displayLastResult(result.data, 'INSTALADO');
            } else if (action === 'uninstalled') {
                // Cuarto escaneo - DESINSTALADO
                showToast('📤 Producto marcado como DESINSTALADO', 'success');
                updateStatus(`📤 ${result.data.referencia} | ${result.data.serial} - DESINSTALADO`, 'success');
                displayLastResult(result.data, 'DESINSTALADO');
            } else if (action === 'already_completed') {
                // Ya completó todo el ciclo
                showToast('⚠️ Producto ya completó todo el ciclo', 'warning');
                updateStatus(`⚠️ ${result.data.referencia} | ${result.data.serial} - Ciclo completo`, 'warning');
                displayLastResult(result.data, result.data.estado);
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
        const clientParam = currentUserRole === 'superadmin' ? '&superadmin=true' : (currentUserClient ? `&cliente=${encodeURIComponent(currentUserClient)}` : '');
        const response = await fetch(`${API_URL}/api/recent-scans?limit=20${clientParam}`);
        const result = await response.json();
        
        if (result.success && result.data.length > 0) {
            allRecordsData = result.data;
            populateClientesSelectRecords();
            filterRecordsByCliente(''); // Mostrar todos inicialmente
        } else {
            allRecordsData = [];
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
        // Obtener estadísticas del cliente
        const clientParam = currentUserClient ? `?cliente=${encodeURIComponent(currentUserClient)}` : '';
        const response = await fetch(`${API_URL}/api/stats${clientParam}`);
        const result = await response.json();
        
        if (result.success) {
            displayStats(result.data);
        }
        
        // Obtener todos los registros para mostrar en tabla
        // Superadmin ve todo, admin/user ven solo su cliente
        const scansParam = currentUserRole === 'superadmin' 
            ? '&superadmin=true' 
            : (currentUserClient ? `&cliente=${encodeURIComponent(currentUserClient)}` : '');
        const scansResponse = await fetch(`${API_URL}/api/recent-scans?limit=10000${scansParam}`);
        const scansResult = await scansResponse.json();
        
        if (scansResult.success) {
            allStatsData = scansResult.data || [];
            displayStatsTable(allStatsData);
            populateReferenciasSelect(); // Llenar el select con referencias únicas
            populateClientesSelectStats(); // Llenar el select con clientes únicos
        }
    } catch (error) {
        console.error('Error al cargar estadísticas:', error);
        showToast('Error al cargar estadísticas', 'error');
    }
}

// ============================================
// GESTIÓN DE USUARIOS (SUPERADMIN)
// ============================================

/**
 * Crea o actualiza un usuario
 */
async function createUser() {
    const usuario = elements.newUserUsername.value.trim();
    const password = elements.newUserPassword.value.trim();
    const cliente = elements.newUserClient.value.trim().toUpperCase();
    const tipo = elements.newUserType.value;

    if (!usuario || !password) {
        elements.userFormError.textContent = 'Usuario y contraseña son requeridos';
        elements.userFormError.classList.remove('hidden');
        return;
    }

    if (!cliente && tipo !== 'super') {
        elements.userFormError.textContent = 'El campo Cliente es requerido (excepto para Super Admin)';
        elements.userFormError.classList.remove('hidden');
        return;
    }

    if (!currentUserPassword || currentUserRole !== 'superadmin') {
        elements.userFormError.textContent = 'No autorizado. Inicia sesión como superadmin.';
        elements.userFormError.classList.remove('hidden');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                usuario,
                tipo,
                password,
                cliente: currentUserRole === 'admin' ? currentUserClient : cliente,
                authUser: currentUsername,
                authPassword: currentUserPassword
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast('Usuario creado exitosamente', 'success');
            elements.newUserUsername.value = '';
            elements.newUserPassword.value = '';
            elements.newUserClient.value = '';
            elements.userFormError.classList.add('hidden');
            await loadUsers();
        } else {
            elements.userFormError.textContent = result.message || 'No se pudo crear el usuario';
            elements.userFormError.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error al crear usuario:', error);
        elements.userFormError.textContent = 'Error al crear usuario';
        elements.userFormError.classList.remove('hidden');
    }
}

/**
 * Actualiza un usuario existente
 */
async function updateUser() {
    if (!editingUser) {
        showToast('No hay usuario en edición', 'error');
        return;
    }

    const password = elements.newUserPassword.value.trim();
    const cliente = elements.newUserClient.value.trim().toUpperCase();
    const tipo = elements.newUserType.value;

    if (!password) {
        elements.userFormError.textContent = 'Contraseña es requerida';
        elements.userFormError.classList.remove('hidden');
        return;
    }

    if (!cliente && tipo !== 'super') {
        elements.userFormError.textContent = 'El campo Cliente es requerido (excepto para Super Admin)';
        elements.userFormError.classList.remove('hidden');
        return;
    }

    if (!currentUserPassword || currentUserRole !== 'superadmin') {
        elements.userFormError.textContent = 'No autorizado. Inicia sesión como superadmin.';
        elements.userFormError.classList.remove('hidden');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/users/${encodeURIComponent(editingUser)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tipo,
                password,
                cliente,
                authUser: currentUsername,
                authPassword: currentUserPassword
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast('Usuario actualizado exitosamente', 'success');
            cancelEditUser();
            await loadUsers();
        } else {
            elements.userFormError.textContent = result.message || 'No se pudo actualizar el usuario';
            elements.userFormError.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        elements.userFormError.textContent = 'Error al actualizar usuario';
        elements.userFormError.classList.remove('hidden');
    }
}

/**
 * Prepara el formulario para editar un usuario
 */
function editUser(usuario, tipo, cliente) {
    editingUser = usuario;
    
    elements.newUserUsername.value = usuario;
    elements.newUserUsername.disabled = true;
    elements.newUserPassword.value = '';
    elements.newUserClient.value = cliente || '';
    elements.newUserType.value = tipo || 'mecanico';
    
    elements.createUserBtn.classList.add('hidden');
    elements.updateUserBtn.classList.remove('hidden');
    elements.cancelEditBtn.classList.remove('hidden');
    
    elements.userFormError.classList.add('hidden');
    
    // Scroll al formulario
    document.getElementById('usersView').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Cancela la edición de usuario
 */
function cancelEditUser() {
    editingUser = null;
    
    elements.newUserUsername.value = '';
    elements.newUserUsername.disabled = false;
    elements.newUserPassword.value = '';
    elements.newUserClient.value = '';
    elements.newUserType.value = 'administrador';
    
    elements.createUserBtn.classList.remove('hidden');
    elements.updateUserBtn.classList.add('hidden');
    elements.cancelEditBtn.classList.add('hidden');
    
    elements.userFormError.classList.add('hidden');
}

/**
 * Elimina un usuario
 */
async function deleteUser(usuario) {
    if (!confirm(`¿Estás seguro de eliminar al usuario "${usuario}"?`)) {
        return;
    }

    if (!currentUserPassword || currentUserRole !== 'superadmin') {
        showToast('No autorizado', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/users/${encodeURIComponent(usuario)}`, {
            method: 'DELETE',
            headers: {
                'x-auth-user': currentUsername || '',
                'x-auth-password': currentUserPassword || ''
            }
        });

        const result = await response.json();

        if (result.success) {
            showToast('Usuario eliminado exitosamente', 'success');
            if (editingUser === usuario) {
                cancelEditUser();
            }
            await loadUsers();
        } else {
            showToast(result.message || 'No se pudo eliminar el usuario', 'error');
        }
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        showToast('Error al eliminar usuario', 'error');
    }
}

/**
 * Carga usuarios registrados (solo superadmin)
 */
async function loadUsers() {
    if ((currentUserRole !== 'superadmin' && currentUserRole !== 'admin') || !currentUserPassword) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/users`, {
            headers: {
                'x-auth-user': currentUsername || '',
                'x-auth-password': currentUserPassword || ''
            }
        });
        const result = await response.json();

        if (result.success) {
            allUsersData = result.data;
            populateClientesSelectUsers();
            filterUsersByCliente(''); // Mostrar todos inicialmente
        } else {
            allUsersData = [];
            showToast(result.message || 'No se pudieron cargar usuarios', 'error');
        }
    } catch (error) {
        console.error('Error al cargar usuarios:', error);
        showToast('Error al cargar usuarios', 'error');
    }
}

/**
 * Muestra los usuarios en la tabla
 */
function displayUsers(users) {
    if (!elements.usersBody) return;

    if (!users || users.length === 0) {
        elements.usersBody.innerHTML = `
            <tr>
                <td colspan="4" class="no-data">No hay usuarios para mostrar</td>
            </tr>
        `;
        return;
    }

    elements.usersBody.innerHTML = users.map(user => {
        // Superadmin y admin pueden editar y eliminar usuarios
        const actionButtons = (currentUserRole === 'superadmin' || currentUserRole === 'admin') ? `
            <div style="display: flex; gap: 8px; justify-content: center;">
                <button class="btn-icon-small btn-edit" onclick="editUser('${user.usuario}', '${user.tipo}', '${user.cliente || ''}')" title="Editar">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button class="btn-icon-small btn-delete" onclick="deleteUser('${user.usuario}')" title="Eliminar">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        <line x1="10" y1="11" x2="10" y2="17"/>
                        <line x1="14" y1="11" x2="14" y2="17"/>
                    </svg>
                </button>
            </div>
        ` : '-';

        return `
            <tr>
                <td class="content-cell"><strong>${user.usuario || 'N/A'}</strong></td>
                <td>${(user.tipo || '').toUpperCase()}</td>
                <td>${user.cliente || '-'}</td>
                <td>${actionButtons}</td>
            </tr>
        `;
    }).join('');
}

// ============================================
// INTERFAZ DE USUARIO
// ============================================

/**
 * Muestra el último resultado escaneado
 */
function displayLastResult(data, estado) {
    let estadoClass = 'almacen';
    let estadoEmoji = '📦';
    
    if (estado === 'EN ALMACEN') {
        estadoClass = 'almacen';
        estadoEmoji = '📦';
    } else if (estado === 'DESPACHADO') {
        estadoClass = 'despachado';
        estadoEmoji = '🚚';
    } else if (estado === 'INSTALADO') {
        estadoClass = 'instalado';
        estadoEmoji = '🔧';
    } else if (estado === 'DESINSTALADO') {
        estadoClass = 'desinstalado';
        estadoEmoji = '📤';
    }
    
    elements.resultType.innerHTML = `<span class="type-badge type-${estadoClass}">${estadoEmoji} ${estado}</span>`;
    
    let detallesHTML = `
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
    `;
    
    if (data.fechaDespacho) {
        detallesHTML += `<div class="qr-field"><strong>Fecha Despacho:</strong> ${data.fechaDespacho}</div>`;
    }
    
    if (data.fechaInstalacion) {
        detallesHTML += `<div class="qr-field"><strong>Fecha Instalación:</strong> ${data.fechaInstalacion}</div>`;
    }
    
    if (data.fechaDesinstalacion) {
        detallesHTML += `<div class="qr-field"><strong>Fecha Desinstalación:</strong> ${data.fechaDesinstalacion}</div>`;
    }
    
    detallesHTML += `</div>`;
    
    elements.resultData.innerHTML = detallesHTML;
    
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
    // Mostrar/ocultar columna CLIENTE según el rol
    const clienteHeaders = document.querySelectorAll('thead .cliente-col');
    clienteHeaders.forEach(th => {
        th.style.display = currentUserRole === 'superadmin' ? 'table-cell' : 'none';
    });
    
    elements.recordsBody.innerHTML = records.map(record => {
        let estadoClass = 'almacen';
        let estadoEmoji = '📦';
        
        if (record.estado === 'EN ALMACEN') {
            estadoClass = 'almacen';
            estadoEmoji = '📦';
        } else if (record.estado === 'DESPACHADO') {
            estadoClass = 'despachado';
            estadoEmoji = '🚚';
        } else if (record.estado === 'INSTALADO') {
            estadoClass = 'instalado';
            estadoEmoji = '🔧';
        } else if (record.estado === 'DESINSTALADO') {
            estadoClass = 'desinstalado';
            estadoEmoji = '📤';
        }
        
        return `
            <tr>
                <td class="content-cell"><strong>${record.referencia}</strong></td>
                <td class="content-cell">${record.serial}</td>
                <td><span class="type-badge type-${estadoClass}">${estadoEmoji} ${record.estado}</span></td>
                <td class="cliente-col" style="display: ${currentUserRole === 'superadmin' ? 'table-cell' : 'none'};">${record.cliente || '-'}</td>
                <td>${record.usuarioPlanta || '-'}</td>
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
    const instalados = data.filter(row => row.estado === 'INSTALADO').length;
    const desinstalados = data.filter(row => row.estado === 'DESINSTALADO').length;
    
    return {
        total,
        enAlmacen,
        despachados,
        instalados,
        desinstalados,
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
        { label: 'Despachados', count: stats.despachados, emoji: '🚚', class: 'despachado' },
        { label: 'Instalados', count: stats.instalados, emoji: '🔧', class: 'instalado' },
        { label: 'Desinstalados', count: stats.desinstalados, emoji: '📤', class: 'desinstalado' }
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
        { label: 'Despachados', count: stats.despachados, emoji: '🚚', class: 'despachado' },
        { label: 'Instalados', count: stats.instalados || 0, emoji: '🔧', class: 'instalado' },
        { label: 'Desinstalados', count: stats.desinstalados || 0, emoji: '📤', class: 'desinstalado' }
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
    
    // Mostrar/ocultar columna CLIENTE según el rol
    const clienteHeaders = document.querySelectorAll('thead .cliente-col');
    clienteHeaders.forEach(th => {
        th.style.display = currentUserRole === 'superadmin' ? 'table-cell' : 'none';
    });
    
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
        const colSpan = currentUserRole === 'superadmin' ? '6' : '5';
        statsTableBody.innerHTML = `<tr><td colspan="${colSpan}" class="no-data">No hay datos para mostrar</td></tr>`;
        return;
    }
    
    statsTableBody.innerHTML = data.map(row => {
        let estadoClass = 'almacen';
        
        if (row.estado === 'EN ALMACEN') {
            estadoClass = 'almacen';
        } else if (row.estado === 'DESPACHADO') {
            estadoClass = 'despachado';
        } else if (row.estado === 'INSTALADO') {
            estadoClass = 'instalado';
        } else if (row.estado === 'DESINSTALADO') {
            estadoClass = 'desinstalado';
        }
        
        return `
            <tr>
                <td>${row.referencia || 'N/A'}</td>
                <td>${row.serial || 'N/A'}</td>
                <td>
                    <span class="type-badge type-${estadoClass}">
                        ${row.estado || 'N/A'}
                    </span>
                </td>
                <td class="cliente-col" style="display: ${currentUserRole === 'superadmin' ? 'table-cell' : 'none'};">${row.cliente || 'N/A'}</td>
                <td>${row.fechaAlmacen || 'N/A'}</td>
                <td>${row.fechaDespacho || 'N/A'}</td>
            </tr>
        `;
    }).join('');
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
 * Filtra los registros de estadísticas por referencia y/o cliente
 */
function filterStats() {
    const referencia = document.getElementById('filterReferencia')?.value || '';
    const cliente = document.getElementById('filterClienteStats')?.value || '';
    
    let filtered = allStatsData;
    
    if (cliente) {
        filtered = filtered.filter(row => row.cliente === cliente);
    }
    
    if (referencia) {
        filtered = filtered.filter(row => row.referencia === referencia);
    }
    
    displayStatsTable(filtered);
}

/**
 * Filtra los registros recientes por cliente
 */
function filterRecordsByCliente(cliente = '') {
    let filtered = allRecordsData;
    
    if (cliente) {
        filtered = allRecordsData.filter(row => row.cliente === cliente);
    }
    
    displayRecords(filtered);
}

/**
 * Filtra los usuarios por cliente
 */
function filterUsersByCliente(cliente = '') {
    let filtered = allUsersData;
    
    if (cliente) {
        filtered = allUsersData.filter(user => user.cliente === cliente);
    }
    
    displayUsers(filtered);
}

/**
 * Llena el select de clientes únicos para registros
 */
function populateClientesSelectRecords() {
    const filterSelect = document.getElementById('filterClienteRecords');
    
    if (!filterSelect || !allRecordsData.length) return;
    
    // Obtener clientes únicos
    const clientes = [...new Set(allRecordsData.map(row => row.cliente).filter(Boolean))].sort();
    
    // Guardar la opción actual
    const currentValue = filterSelect.value;
    
    // Reconstruir opciones
    filterSelect.innerHTML = '<option value="">Todos los clientes</option>';
    clientes.forEach(cliente => {
        const option = document.createElement('option');
        option.value = cliente;
        option.textContent = cliente;
        filterSelect.appendChild(option);
    });
    
    // Restaurar selección
    filterSelect.value = currentValue;
}

/**
 * Llena el select de clientes únicos para usuarios
 */
function populateClientesSelectUsers() {
    const filterSelect = document.getElementById('filterClienteUsers');
    
    if (!filterSelect || !allUsersData.length) return;
    
    // Obtener clientes únicos
    const clientes = [...new Set(allUsersData.map(user => user.cliente).filter(Boolean))].sort();
    
    // Guardar la opción actual
    const currentValue = filterSelect.value;
    
    // Reconstruir opciones
    filterSelect.innerHTML = '<option value="">Todos los clientes</option>';
    clientes.forEach(cliente => {
        const option = document.createElement('option');
        option.value = cliente;
        option.textContent = cliente;
        filterSelect.appendChild(option);
    });
    
    // Restaurar selección
    filterSelect.value = currentValue;
}

/**
 * Llena el select de clientes únicos para estadísticas
 */
function populateClientesSelectStats() {
    const filterSelect = document.getElementById('filterClienteStats');
    
    if (!filterSelect || !allStatsData.length) return;
    
    // Obtener clientes únicos
    const clientes = [...new Set(allStatsData.map(row => row.cliente).filter(Boolean))].sort();
    
    // Guardar la opción actual
    const currentValue = filterSelect.value;
    
    // Reconstruir opciones
    filterSelect.innerHTML = '<option value="">Todos los clientes</option>';
    clientes.forEach(cliente => {
        const option = document.createElement('option');
        option.value = cliente;
        option.textContent = cliente;
        filterSelect.appendChild(option);
    });
    
    // Restaurar selección
    filterSelect.value = currentValue;
}

/**
 * Exporta los datos de estadísticas a CSV
 */
function exportStatsToCSV() {
    if (!currentFilteredData || currentFilteredData.length === 0) {
        showToast('No hay datos para exportar', 'warning');
        return;
    }
    
    // Headers del CSV (sin ID, incluir CLIENTE para superadmin)
    const headers = currentUserRole === 'superadmin'
        ? ['REFERENCIA', 'SERIAL', 'ESTADO', 'CLIENTE', 'FECHA_ALMACEN', 'FECHA_DESPACHO', 'HORA_ALMACEN', 'HORA_DESPACHO']
        : ['REFERENCIA', 'SERIAL', 'ESTADO', 'FECHA_ALMACEN', 'FECHA_DESPACHO', 'HORA_ALMACEN', 'HORA_DESPACHO'];
    
    // Datos (sin ID, incluir CLIENTE para superadmin)
    const rows = currentFilteredData.map(row => {
        if (currentUserRole === 'superadmin') {
            return [
                row.referencia || '',
                row.serial || '',
                row.estado || '',
                row.cliente || '',
                row.fechaAlmacen || '',
                row.fechaDespacho || '',
                row.horaAlmacen || '',
                row.horaDespacho || ''
            ];
        } else {
            return [
                row.referencia || '',
                row.serial || '',
                row.estado || '',
                row.fechaAlmacen || '',
                row.fechaDespacho || '',
                row.horaAlmacen || '',
                row.horaDespacho || ''
            ];
        }
    });
    
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
        // Superadmin ve todo, admin/user ven solo su cliente
        const scansParam = currentUserRole === 'superadmin' 
            ? '&superadmin=true' 
            : (currentUserClient ? `&cliente=${encodeURIComponent(currentUserClient)}` : '');
        const response = await fetch(`${API_URL}/api/recent-scans?limit=1000${scansParam}`);
        const result = await response.json();
        
        if (!result.success || result.data.length === 0) {
            showToast('No hay datos para exportar', 'warning');
            return;
        }
        
        // Crear CSV
        const headers = currentUserRole === 'superadmin'
            ? ['ID', 'Referencia', 'Serial', 'Estado', 'Cliente', 'Fecha Almacén', 'Hora Almacén', 'Fecha Despacho', 'Hora Despacho']
            : ['ID', 'Referencia', 'Serial', 'Estado', 'Fecha Almacén', 'Hora Almacén', 'Fecha Despacho', 'Hora Despacho'];
        
        const rows = result.data.map(r => {
            if (currentUserRole === 'superadmin') {
                return [
                    r.id, 
                    `"${r.referencia}"`, 
                    `"${r.serial}"`, 
                    r.estado,
                    r.cliente || '',
                    r.fechaAlmacen, 
                    r.horaAlmacen || '',
                    r.fechaDespacho || '', 
                    r.horaDespacho || ''
                ];
            } else {
                return [
                    r.id, 
                    `"${r.referencia}"`, 
                    `"${r.serial}"`, 
                    r.estado,
                    r.fechaAlmacen, 
                    r.horaAlmacen || '',
                    r.fechaDespacho || '', 
                    r.horaDespacho || ''
                ];
            }
        });
        
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
