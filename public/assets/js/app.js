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
let editingClient = null; // Cliente que se está editando (para el formulario de clientes)
let allRecordsData = []; // Guardar todos los registros para filtrado
let allUsersData = []; // Guardar todos los usuarios para filtrado
let allClientsData = []; // Guardar todos los clientes para filtrado
let pendingInstallationQR = null; // QR pendiente de instalación (tercer escaneo)
let pendingUninstallationQR = null; // QR pendiente de desinstalación (cuarto escaneo)

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
    selectedClient: document.getElementById('selectedClient'),
    newClientName: document.getElementById('newClientName'),
    createClientBtn: document.getElementById('createClientBtn'),
    updateClientBtn: document.getElementById('updateClientBtn'),
    cancelEditClientBtn: document.getElementById('cancelEditClientBtn'),
    clientFormError: document.getElementById('clientFormError'),
    refreshClientsBtn: document.getElementById('refreshClientsBtn'),
    clientsBody: document.getElementById('clientsBody'),
    instalacionModal: document.getElementById('instalacionModal'),
    instalacionPlaca: document.getElementById('instalacionPlaca'),
    instalacionKilometraje: document.getElementById('instalacionKilometraje'),
    instalacionInstalador: document.getElementById('instalacionInstalador'),
    instalacionGuardarBtn: document.getElementById('instalacionGuardarBtn'),
    instalacionCancelarBtn: document.getElementById('instalacionCancelarBtn'),
    instalacionErrorMsg: document.getElementById('instalacionErrorMsg'),
    desinstalacionModal: document.getElementById('desinstalacionModal'),
    kilometrajeDesinstalacionInput: document.getElementById('kilometrajeDesinstalacionInput'),
    submitDesinstalacionBtn: document.getElementById('submitDesinstalacionBtn'),
    cancelDesinstalacionBtn: document.getElementById('cancelDesinstalacionBtn'),
    desinstalacionError: document.getElementById('desinstalacionError')
};

// ============================================
// SISTEMA DE AUTENTICACIÓN
// ============================================

/**
 * Inicializa el sistema de autenticación
 */
function initAuth() {
    const savedRole = localStorage.getItem('userRole');
    const savedUserType = localStorage.getItem('userType'); // Restaurar tipo de usuario
    const savedUserName = localStorage.getItem('userName') || localStorage.getItem('userEmail');
    const savedPassword = sessionStorage.getItem('userPassword');
    const savedClient = localStorage.getItem('userClient');
    
    if (savedRole) {
        if (savedRole === 'superadmin' && !savedPassword) {
            localStorage.removeItem('userRole');
            localStorage.removeItem('userType');
            localStorage.removeItem('userName');
            localStorage.removeItem('userClient');
            elements.loginModal.style.display = 'flex';
            return;
        }

        currentUserRole = savedRole;
        currentUserType = savedUserType || 'mecanico'; // Restaurar tipo de usuario con default
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
        currentUserType = result.tipo || 'super'; // Guardar tipo para superadmin
        localStorage.setItem('userRole', 'superadmin');
        localStorage.setItem('userType', currentUserType);
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
    currentUserType = 'administrador'; // Establecer tipo para admin
    localStorage.setItem('userRole', 'admin');
    localStorage.setItem('userType', 'administrador');
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
    localStorage.removeItem('userType');
    localStorage.removeItem('userName');
    localStorage.removeItem('userClient');
    sessionStorage.removeItem('userPassword');
    currentUserRole = null;
    currentUserType = null;
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
    const clientsNavBtn = document.querySelector('[data-view="clientsView"]');
    const projectionsNavBtn = document.querySelector('[data-view="projectionsView"]');
    const scannerNavBtn = document.querySelector('[data-view="scannerView"]');
    const recordsNavBtn = document.querySelector('[data-view="recordsView"]');
    
    if (currentUserRole === 'user' && currentUserType === 'mecanico') {
        // Usuario mecánico: ocultar estadísticas, usuarios y clientes, mostrar escáner sin selector
        if (statsNavBtn) {
            statsNavBtn.style.display = 'none';
        }
        if (usersNavBtn) {
            usersNavBtn.style.display = 'none';
        }
        if (clientsNavBtn) {
            clientsNavBtn.style.display = 'none';
        }
        if (projectionsNavBtn) {
            projectionsNavBtn.style.display = 'none';
        }
        if (recordsNavBtn) {
            recordsNavBtn.style.display = 'none';
        }
        if (scannerNavBtn) {
            scannerNavBtn.style.display = 'flex';
        }
        // Ocultar selector de cliente para mecánicos
        if (elements.clientSelectorContainer) {
            elements.clientSelectorContainer.classList.add('hidden');
        }
        // Si está en vista de estadísticas/usuarios/clientes/registros, redirigir a escáner
        if (document.getElementById('statsView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('usersView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('clientsView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('recordsView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('projectionsView').classList.contains('active')) {
            switchView('scannerView');
        }
    } else if (currentUserRole === 'dispatch' && currentUserType === 'despacho') {
        // Usuario despacho: ocultar estadísticas, usuarios y clientes, mostrar selector de cliente
        if (statsNavBtn) {
            statsNavBtn.style.display = 'none';
        }
        if (usersNavBtn) {
            usersNavBtn.style.display = 'none';
        }
        if (clientsNavBtn) {
            clientsNavBtn.style.display = 'none';
        }
        if (projectionsNavBtn) {
            projectionsNavBtn.style.display = 'none';
        }
        if (recordsNavBtn) {
            recordsNavBtn.style.display = 'none';
        }
        if (scannerNavBtn) {
            scannerNavBtn.style.display = 'flex';
        }
        // Mostrar selector de cliente para usuarios despacho
        if (elements.clientSelectorContainer) {
            elements.clientSelectorContainer.classList.remove('hidden');
            loadClientsSelect();
        }
        // Si está en vista de estadísticas/usuarios/clientes/registros/proyecciones, redirigir a escáner
        if (document.getElementById('statsView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('usersView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('clientsView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('recordsView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('projectionsView').classList.contains('active')) {
            switchView('scannerView');
        }
    } else if (currentUserRole === 'admin') {
        // Admin: ocultar estadísticas, clientes y selector, mostrar escáner, registros y usuarios
        if (statsNavBtn) {
            statsNavBtn.style.display = 'none';
        }
        if (usersNavBtn) {
            usersNavBtn.style.display = 'flex';
        }
        if (clientsNavBtn) {
            clientsNavBtn.style.display = 'none';
        }
        if (projectionsNavBtn) {
            projectionsNavBtn.style.display = 'none';
        }
        if (scannerNavBtn) {
            scannerNavBtn.style.display = 'flex';
        }
        if (recordsNavBtn) {
            recordsNavBtn.style.display = 'flex';
        }
        // Ocultar selector de cliente para admins
        if (elements.clientSelectorContainer) {
            elements.clientSelectorContainer.classList.add('hidden');
        }
        // Si está en vista de estadísticas o clientes, redirigir a escáner
        if (document.getElementById('statsView').classList.contains('active')) {
            switchView('scannerView');
        }
        if (document.getElementById('clientsView').classList.contains('active')) {
            switchView('scannerView');
        }
        
        // Ocultar formulario de crear usuarios (solo pueden ver)
        const userForm = document.querySelector('.user-form');
        if (userForm) {
            userForm.style.display = 'none';
        }
    } else {
        // Superadmin: mostrar estadísticas, registros, usuarios, clientes y proyecciones (ocultar escáner)
        if (statsNavBtn) {
            statsNavBtn.style.display = 'flex';
        }
        if (usersNavBtn) {
            usersNavBtn.style.display = 'flex';
        }
        if (clientsNavBtn) {
            clientsNavBtn.style.display = 'flex';
        }
        if (projectionsNavBtn) {
            projectionsNavBtn.style.display = 'flex';
        }
        if (scannerNavBtn) {
            scannerNavBtn.style.display = 'none';
        }
        if (recordsNavBtn) {
            recordsNavBtn.style.display = 'none';
        }
        // Ocultar selector de cliente para superadmin
        if (elements.clientSelectorContainer) {
            elements.clientSelectorContainer.classList.add('hidden');
        }
        // Cargar clientes para filtros
        loadClientsForProjectionsFilter();
        
        if (document.getElementById('scannerView').classList.contains('active') ||
            document.getElementById('recordsView').classList.contains('active')) {
            switchView('statsView');
        }
        
        // Mostrar formulario de crear usuarios (solo superadmin)
        const userForm = document.querySelector('.user-form');
        if (userForm) {
            userForm.style.display = 'block';
        }
        
        // Cargar clientes para superadmin
        loadClients();
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
    // Validar permisos de acceso a la vista
    // Solo superadmin puede acceder a: clientsView, projectionsView, statsView
    // Admin y superadmin pueden acceder a: usersView, recordsView
    // Mecánicos y despacho solo pueden acceder a: scannerView
    const superadminOnlyViews = ['clientsView', 'projectionsView', 'statsView'];
    const adminSuperadminViews = ['usersView', 'recordsView'];
    const isSuperadmin = currentUserType === 'super';
    const isAdmin = currentUserType === 'administrador';
    const isMecanico = currentUserType === 'mecanico';
    const isDespacho = currentUserType === 'despacho';
    
    // Bloquear acceso a vistas exclusivas de superadmin
    if (superadminOnlyViews.includes(viewId) && !isSuperadmin) {
        console.warn(`⚠️ Acceso denegado: El usuario ${currentUsername} (${currentUserType}) intentó acceder a ${viewId}`);
        showToast('No tienes permiso para acceder a esta sección', 'error');
        // Redirigir a la vista permitida por defecto
        viewId = (isMecanico || isDespacho) ? 'scannerView' : 'statsView';
    }
    
    // Bloquear acceso a vistas de admin/superadmin
    if (adminSuperadminViews.includes(viewId) && !isSuperadmin && !isAdmin) {
        console.warn(`⚠️ Acceso denegado: El usuario ${currentUsername} (${currentUserType}) intentó acceder a ${viewId}`);
        showToast('No tienes permiso para acceder a esta sección', 'error');
        // Redirigir a la vista permitida por defecto
        viewId = 'scannerView';
    }
    
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
    } else if (viewId === 'clientsView') {
        loadClients();
    } else if (viewId === 'projectionsView') {
        loadProjections();
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
    
    // Registrar Service Worker para PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/service-worker.js').then(registration => {
            console.log('✅ Service Worker registrado correctamente', registration);
        }).catch(error => {
            console.warn('⚠️ Error al registrar Service Worker:', error);
        });
    }
    
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
        // Pequeño delay para evitar rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        if (currentUserRole === 'admin' || currentUserRole === 'superadmin') {
            await loadStats();
        }
    }
    
    // Actualizar datos cada 30 segundos
    setInterval(async () => {
        if (!isScanning && currentUserRole) {
            await loadRecentScans();
            // Pequeño delay para evitar rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
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
    elements.refreshBtn.addEventListener('click', async () => {
        await loadRecentScans();
        // Pequeño delay para evitar rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        if (currentUserRole === 'admin' || currentUserRole === 'superadmin') {
            await loadStats();
        }
    });
    elements.exportBtn.addEventListener('click', exportToCSV);
    
    // Event listeners de autenticación
    elements.loginUserBtn.addEventListener('click', showUserEmailForm);
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

    // Event listener para tipo de usuario: deshabilitar cliente si es super
    if (elements.newUserType) {
        elements.newUserType.addEventListener('change', () => {
            if (elements.newUserType.value === 'super') {
                elements.newUserClient.value = '';
                elements.newUserClient.disabled = true;
                elements.newUserClient.style.opacity = '0.5';
            } else {
                elements.newUserClient.disabled = false;
                elements.newUserClient.style.opacity = '1';
            }
        });
    }

    if (elements.refreshUsersBtn) {
        elements.refreshUsersBtn.addEventListener('click', loadUsers);
    }
    
    // Event listeners de gestión de clientes
    if (elements.createClientBtn) {
        elements.createClientBtn.addEventListener('click', createClient);

        if (elements.updateClientBtn) {
            elements.updateClientBtn.addEventListener('click', updateClient);
        }

        if (elements.cancelEditClientBtn) {
            elements.cancelEditClientBtn.addEventListener('click', cancelEditClient);
        }
    }

    if (elements.newClientName) {
        elements.newClientName.addEventListener('input', () => {
            elements.clientFormError.classList.add('hidden');
            elements.clientFormError.textContent = '';
        });

        elements.newClientName.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                if (editingClient) {
                    updateClient();
                } else {
                    createClient();
                }
            }
        });
    }

    if (elements.refreshClientsBtn) {
        elements.refreshClientsBtn.addEventListener('click', loadClients);
    }
    
    // Event listeners del modal de instalación
    if (elements.instalacionGuardarBtn) {
        elements.instalacionGuardarBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            await onInstalacionSubmit();
        });
    }
    
    if (elements.instalacionCancelarBtn) {
        elements.instalacionCancelarBtn.addEventListener('click', () => {
            onInstalacionCancel();
        });
    }
    
    // Enter en campo placa del modal de instalación
    if (elements.instalacionPlaca) {
        elements.instalacionPlaca.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                elements.instalacionKilometraje.focus();
            }
        });
    }
    
    // Enter en campo kilometraje del modal de instalación
    if (elements.instalacionKilometraje) {
        elements.instalacionKilometraje.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                elements.instalacionInstalador.focus();
            }
        });
    }

    // Enter en campo instalador del modal de instalación
    if (elements.instalacionInstalador) {
        elements.instalacionInstalador.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                onInstalacionSubmit();
            }
        });
    }

    // Event listeners del modal de desinstalación
    if (elements.submitDesinstalacionBtn) {
        elements.submitDesinstalacionBtn.addEventListener('click', submitDesinstalacion);
    }
    
    if (elements.cancelDesinstalacionBtn) {
        elements.cancelDesinstalacionBtn.addEventListener('click', cancelDesinstalacion);
    }
    
    // Enter en campos del modal de desinstalación
    if (elements.kilometrajeDesinstalacionInput) {
        elements.kilometrajeDesinstalacionInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitDesinstalacion();
            }
        });
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

    // Event listeners de proyecciones
    const refreshProjectionsBtn = document.getElementById('refreshProjectionsBtn');
    const filterClienteProjections = document.getElementById('filterClienteProjections');
    const filterReferenciaProjections = document.getElementById('filterReferenciaProjections');

    if (refreshProjectionsBtn) {
        refreshProjectionsBtn.addEventListener('click', loadProjections);
    }

    if (filterClienteProjections) {
        filterClienteProjections.addEventListener('change', loadProjections);
    }

    if (filterReferenciaProjections) {
        filterReferenciaProjections.addEventListener('change', loadProjections);
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

// ============================================
// MANEJO DEL MODAL DE INSTALACIÓN (REGENERADO)
// ============================================

/**
 * Muestra el modal de instalación
 */
function onShowInstalacion() {
    // Limpiar campos
    elements.instalacionPlaca.value = '';
    elements.instalacionKilometraje.value = '';
    elements.instalacionInstalador.value = '';
    
    // Limpiar mensajes de error
    if (elements.instalacionErrorMsg) {
        elements.instalacionErrorMsg.textContent = '';
        elements.instalacionErrorMsg.classList.add('hidden');
    }
    
    // Mostrar modal
    elements.instalacionModal.style.display = 'flex';
    
    // Enfoque al primer campo
    elements.instalacionPlaca.focus();
}

/**
 * Oculta el modal de instalación
 */
function onHideInstalacion() {
    // Ocultar modal
    elements.instalacionModal.style.display = 'none';
    
    // Limpiar campos
    elements.instalacionPlaca.value = '';
    elements.instalacionKilometraje.value = '';
    elements.instalacionInstalador.value = '';
    
    // Limpiar mensajes de error
    if (elements.instalacionErrorMsg) {
        elements.instalacionErrorMsg.textContent = '';
        elements.instalacionErrorMsg.classList.add('hidden');
    }
}

/**
 * Envía los datos del modal de instalación al backend
 */
async function onInstalacionSubmit() {
    // Obtener valores de los campos
    const placa = (elements.instalacionPlaca?.value || '').trim();
    const kilometraje = (elements.instalacionKilometraje?.value || '').trim();
    const instalador = (elements.instalacionInstalador?.value || '').trim();
    
    // Validar que todos los campos estén completos
    if (!placa || !kilometraje || !instalador) {
        if (elements.instalacionErrorMsg) {
            elements.instalacionErrorMsg.textContent = 'Por favor completa todos los campos (Placa, Kilometraje, Instalador)';
            elements.instalacionErrorMsg.classList.remove('hidden');
        }
        showToast('⚠️ Faltan datos por completar', 'warning');
        return;
    }
    
    // Validar que el kilometraje sea un número válido
    const kmNum = parseFloat(kilometraje);
    if (isNaN(kmNum) || kmNum < 0) {
        if (elements.instalacionErrorMsg) {
            elements.instalacionErrorMsg.textContent = 'El kilometraje debe ser un número válido y mayor o igual a 0';
            elements.instalacionErrorMsg.classList.remove('hidden');
        }
        showToast('⚠️ Kilometraje inválido', 'warning');
        return;
    }
    
    // Validar que el instalador sea texto válido (mínimo 2 caracteres)
    if (instalador.length < 2) {
        if (elements.instalacionErrorMsg) {
            elements.instalacionErrorMsg.textContent = 'El nombre del instalador debe tener al menos 2 caracteres';
            elements.instalacionErrorMsg.classList.remove('hidden');
        }
        showToast('⚠️ Nombre del instalador inválido', 'warning');
        return;
    }
    
    try {
        // Ocultar modal
        onHideInstalacion();
        
        updateStatus('💾 Guardando datos de instalación...', 'saving');
        
        // Llamar a saveQRCode con los datos capturados
        await saveQRCode(pendingInstallationQR, placa, kilometraje, '', instalador);
        
        // Limpiar QR pendiente
        pendingInstallationQR = null;
        
    } catch (error) {
        console.error('❌ Error al guardar instalación:', error);
        showToast('Error al guardar datos de instalación', 'error');
        updateStatus('❌ Error al guardar', 'error');
        
        // Volver a mostrar el modal para reintento
        onShowInstalacion();
    }
}

/**
 * Cancela la operación de instalación
 */
function onInstalacionCancel() {
    // Ocultar modal
    onHideInstalacion();
    
    // Limpiar QR pendiente
    pendingInstallationQR = null;
    
    // Mostrar mensaje
    updateStatus('⚠️ Instalación cancelada', 'warning');
    showToast('Instalación cancelada', 'warning');
}

/**
 * Muestra el modal de desinstalación
 */
function showDesinstalacionModal() {
    elements.desinstalacionModal.style.display = 'flex';
    elements.kilometrajeDesinstalacionInput.value = '';
    elements.kilometrajeDesinstalacionInput.focus();
    
    if (elements.desinstalacionError) {
        elements.desinstalacionError.textContent = '';
        elements.desinstalacionError.classList.add('hidden');
    }
}

/**
 * Oculta el modal de desinstalación
 */
function hideDesinstalacionModal() {
    elements.desinstalacionModal.style.display = 'none';
    elements.kilometrajeDesinstalacionInput.value = '';
    
    if (elements.desinstalacionError) {
        elements.desinstalacionError.textContent = '';
        elements.desinstalacionError.classList.add('hidden');
    }
}

/**
 * Envía los datos de desinstalación al backend
 */
async function submitDesinstalacion() {
    const kilometraje = elements.kilometrajeDesinstalacionInput.value.trim();
    
    // Validar que el campo esté lleno
    if (!kilometraje) {
        if (elements.desinstalacionError) {
            elements.desinstalacionError.textContent = 'Por favor completa el kilometraje';
            elements.desinstalacionError.classList.remove('hidden');
        }
        return;
    }
    
    // Validar que el kilometraje sea un número
    if (isNaN(kilometraje) || parseFloat(kilometraje) < 0) {
        if (elements.desinstalacionError) {
            elements.desinstalacionError.textContent = 'El kilometraje debe ser un número válido';
            elements.desinstalacionError.classList.remove('hidden');
        }
        return;
    }
    
    try {
        // Ocultar modal
        hideDesinstalacionModal();
        
        // Enviar datos al backend con el kilometraje de desinstalación
        await saveQRCode(pendingUninstallationQR, '', '', kilometraje);
        
        // Limpiar QR pendiente
        pendingUninstallationQR = '';
        
    } catch (error) {
        console.error('Error al enviar datos de desinstalación:', error);
        showToast('Error al guardar datos de desinstalación', 'error');
        
        // Volver a mostrar el modal para que el usuario reintente
        showDesinstalacionModal();
    }
}

/**
 * Cancela la desinstalación y cierra el modal
 */
function cancelDesinstalacion() {
    hideDesinstalacionModal();
    pendingUninstallationQR = '';
    updateStatus('⚠️ Desinstalación cancelada', 'warning');
    showToast('Desinstalación cancelada', 'warning');
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
async function saveQRCode(qrContent, placa = '', kilometrajeInstalacion = '', kilometrajeDesinstalacion = '', installerName = '') {
    try {
        updateStatus('💾 Guardando...', 'saving');
        
        // Para usuarios despacho: el cliente solo es requerido después del primer escaneo
        // En el primer escaneo, pueden escanear sin seleccionar cliente
        let userClientToUse = currentUserClient;
        if (currentUserRole === 'dispatch') {
            userClientToUse = elements.selectedClient.value || ''; // Permitir vacío en primer escaneo
            
            // Si no hay cliente seleccionado, mostrar advertencia
            if (!userClientToUse) {
                showToast('⚠️ Recuerda: Necesitas seleccionar un cliente para DESPACHAR productos', 'warning');
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
                userTipo: currentUserType,
                placa,
                kilometrajeInstalacion,
                kilometrajeDesinstalacion,
                installerName
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
            
            if (action === 'needs_installation_data') {
                // Se requieren datos de instalación - mostrar modal
                pendingInstallationQR = qrContent;
                onShowInstalacion();
                updateStatus(`🔧 Ingresa datos de instalación para ${result.data.referencia} | ${result.data.serial}`, 'warning');
                return; // No continuar procesando
            } else if (action === 'needs_uninstallation_data') {
                // Se requieren datos de desinstalación - mostrar modal
                pendingUninstallationQR = qrContent;
                showDesinstalacionModal();
                updateStatus(`📤 Ingresa datos de desinstalación para ${result.data.referencia} | ${result.data.serial}`, 'warning');
                return; // No continuar procesando
            } else if (action === 'stored') {
                // Primer escaneo - EN ALMACEN
                showToast('✅ Producto registrado EN ALMACEN', 'success');
                updateStatus(`✅ ${result.data.referencia} | ${result.data.serial} - EN ALMACEN`, 'success');
                displayLastResult(result.data, 'EN ALMACEN');
                
                // Recordatorio para usuario despacho
                if (currentUserRole === 'dispatch') {
                    setTimeout(() => {
                        showToast('ℹ️ Para despachar, selecciona un cliente y escanea nuevamente', 'info');
                    }, 2000);
                }
            } else if (action === 'dispatched') {
                // Segundo escaneo - DESPACHADO
                showToast('🚚 Producto marcado como DESPACHADO', 'success');
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
        let queryParams = 'limit=20';
        if (currentUserRole === 'superadmin') {
            queryParams += '&superadmin=true';
        } else if (currentUserRole === 'admin' && currentUserClient) {
            queryParams += `&cliente=${encodeURIComponent(currentUserClient)}`;
        } else if (currentUsername) {
            queryParams += `&userEmail=${encodeURIComponent(currentUsername)}`;
        }

        const response = await fetch(`${API_URL}/api/recent-scans?${queryParams}`);
        const result = await response.json();
        
        if (result.success && result.data.length > 0) {
            allRecordsData = result.data;
            populateClientesSelectRecords();
            filterRecordsByCliente(''); // Mostrar todos inicialmente
        } else {
            allRecordsData = [];
            const colspan = getRecordsColspan();
            elements.recordsBody.innerHTML = `
                <tr>
                    <td colspan="${colspan}" class="no-data">No hay registros para mostrar</td>
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
        // Obtener estadísticas según rol
        let queryParams = '';
        if (currentUserRole === 'admin' && currentUserClient) {
            queryParams = `?cliente=${encodeURIComponent(currentUserClient)}`;
        } else if (currentUserRole !== 'superadmin' && currentUsername) {
            queryParams = `?userEmail=${encodeURIComponent(currentUsername)}`;
        }

        const response = await fetch(`${API_URL}/api/stats${queryParams}`);
        const result = await response.json();
        
        if (result.success) {
            displayStats(result.data);
            // Usar los datos de allRecordsData si ya fueron cargados
            if (allRecordsData && allRecordsData.length > 0) {
                allStatsData = allRecordsData;
                displayStatsTable(allStatsData);
                populateReferenciasSelect();
                populateClientesSelectStats();
            }
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
    const cliente = elements.newUserClient.value.trim(); // Ya viene del select
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
    const cliente = elements.newUserClient.value.trim(); // Ya viene del select
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
    
    // Habilitar/deshabilitar select de cliente según el tipo
    if (tipo === 'super') {
        elements.newUserClient.disabled = true;
        elements.newUserClient.style.opacity = '0.5';
    } else {
        elements.newUserClient.disabled = false;
        elements.newUserClient.style.opacity = '1';
    }
    
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
    elements.newUserClient.disabled = false;
    elements.newUserClient.style.opacity = '1';
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

    // Cargar clientes en el select del formulario de usuarios
    await loadClientsForUserForm();

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
            
            // Si es admin, filtrar solo usuarios de su cliente
            if (currentUserRole === 'admin' && currentUserClient) {
                allUsersData = allUsersData.filter(user => user.cliente === currentUserClient);
            }
            
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

    const showActions = currentUserRole === 'superadmin';
    const accionesHeaders = document.querySelectorAll('thead .acciones-col');
    accionesHeaders.forEach(th => {
        th.style.display = showActions ? 'table-cell' : 'none';
    });

    if (!users || users.length === 0) {
        const colspan = showActions ? 4 : 3;
        elements.usersBody.innerHTML = `
            <tr>
                <td colspan="${colspan}" class="no-data">No hay usuarios para mostrar</td>
            </tr>
        `;
        return;
    }

    elements.usersBody.innerHTML = users.map(user => {
        const actionButtons = showActions ? `
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
        ` : '';

        return `
            <tr>
                <td class="content-cell"><strong>${user.usuario || 'N/A'}</strong></td>
                <td>${(user.tipo || '').toUpperCase()}</td>
                <td>${user.cliente || '-'}</td>
                <td class="acciones-col" style="display: ${showActions ? 'table-cell' : 'none'};">${actionButtons}</td>
            </tr>
        `;
    }).join('');
}

// ============================================
// GESTIÓN DE CLIENTES
// ============================================

/**
 * Crea un nuevo cliente
 */
async function createClient() {
    const nombre = elements.newClientName.value.trim();

    if (!nombre) {
        elements.clientFormError.textContent = 'El nombre del cliente es requerido';
        elements.clientFormError.classList.remove('hidden');
        return;
    }

    if (!currentUserPassword || currentUserRole !== 'superadmin') {
        elements.clientFormError.textContent = 'No autorizado. Inicia sesión como superadmin.';
        elements.clientFormError.classList.remove('hidden');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/clients`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre,
                authUser: currentUsername,
                authPassword: currentUserPassword
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast('✅ Cliente creado exitosamente', 'success');
            elements.newClientName.value = '';
            elements.clientFormError.classList.add('hidden');
            await loadClients();
            await loadClientsSelect(); // Actualizar selector de clientes
            await loadClientsForUserForm(); // Actualizar select en formulario de usuarios
            await loadClientsForProjectionsFilter(); // Actualizar filtro de proyecciones
        } else {
            elements.clientFormError.textContent = result.error || 'No se pudo crear el cliente';
            elements.clientFormError.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error al crear cliente:', error);
        elements.clientFormError.textContent = 'Error al crear cliente';
        elements.clientFormError.classList.remove('hidden');
    }
}

/**
 * Actualiza un cliente existente
 */
async function updateClient() {
    if (!editingClient) {
        showToast('No hay cliente en edición', 'error');
        return;
    }

    const nuevoNombre = elements.newClientName.value.trim();

    if (!nuevoNombre) {
        elements.clientFormError.textContent = 'El nombre del cliente es requerido';
        elements.clientFormError.classList.remove('hidden');
        return;
    }

    if (!currentUserPassword || currentUserRole !== 'superadmin') {
        elements.clientFormError.textContent = 'No autorizado. Inicia sesión como superadmin.';
        elements.clientFormError.classList.remove('hidden');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/clients`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombreActual: editingClient,
                nuevoNombre,
                authUser: currentUsername,
                authPassword: currentUserPassword
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast('✅ Cliente actualizado exitosamente', 'success');
            cancelEditClient();
            await loadClients();
            await loadClientsSelect(); // Actualizar selector de clientes
            await loadClientsForUserForm(); // Actualizar select en formulario de usuarios
            await loadClientsForProjectionsFilter(); // Actualizar filtro de proyecciones
        } else {
            elements.clientFormError.textContent = result.error || 'No se pudo actualizar el cliente';
            elements.clientFormError.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error al actualizar cliente:', error);
        elements.clientFormError.textContent = 'Error al actualizar cliente';
        elements.clientFormError.classList.remove('hidden');
    }
}

/**
 * Prepara el formulario para editar un cliente
 */
function editClient(nombre) {
    editingClient = nombre;
    
    elements.newClientName.value = nombre;
    
    elements.createClientBtn.classList.add('hidden');
    elements.updateClientBtn.classList.remove('hidden');
    elements.cancelEditClientBtn.classList.remove('hidden');
    
    elements.clientFormError.classList.add('hidden');
    
    // Scroll al formulario
    document.getElementById('clientsView').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Cancela la edición de cliente
 */
function cancelEditClient() {
    editingClient = null;
    
    elements.newClientName.value = '';
    
    elements.createClientBtn.classList.remove('hidden');
    elements.updateClientBtn.classList.add('hidden');
    elements.cancelEditClientBtn.classList.add('hidden');
    
    elements.clientFormError.classList.add('hidden');
}

/**
 * Elimina un cliente
 */
async function deleteClient(nombre) {
    if (!confirm(`¿Estás seguro de eliminar el cliente "${nombre}"?\n\nAdvertencia: Esto también eliminará las hojas asociadas al cliente si no tiene registros.`)) {
        return;
    }

    if (!currentUserPassword || currentUserRole !== 'superadmin') {
        showToast('No autorizado', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/clients`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre,
                authUser: currentUsername,
                authPassword: currentUserPassword
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast('✅ Cliente eliminado exitosamente', 'success');
            if (editingClient === nombre) {
                cancelEditClient();
            }
            await loadClients();
            await loadClientsSelect(); // Actualizar selector de clientes
            await loadClientsForUserForm(); // Actualizar select en formulario de usuarios
            await loadClientsForProjectionsFilter(); // Actualizar filtro de proyecciones
        } else {
            showToast(result.error || 'No se pudo eliminar el cliente', 'error');
        }
    } catch (error) {
        console.error('Error al eliminar cliente:', error);
        showToast('Error al eliminar cliente', 'error');
    }
}

/**
 * Carga clientes registrados (solo superadmin)
 */
async function loadClients() {
    if (currentUserRole !== 'superadmin') {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/clients`);
        const result = await response.json();

        if (result.success) {
            allClientsData = result.data;
            displayClients(allClientsData);
        } else {
            allClientsData = [];
            showToast(result.error || 'No se pudieron cargar clientes', 'error');
        }
    } catch (error) {
        console.error('Error al cargar clientes:', error);
        showToast('Error al cargar clientes', 'error');
    }
}

/**
 * Muestra los clientes en la tabla
 */
function displayClients(clients) {
    if (!elements.clientsBody) return;

    if (!clients || clients.length === 0) {
        elements.clientsBody.innerHTML = `
            <tr>
                <td colspan="2" class="no-data">No hay clientes para mostrar</td>
            </tr>
        `;
        return;
    }

    elements.clientsBody.innerHTML = clients.map(client => {
        const actionButtons = currentUserRole === 'superadmin' ? `
            <div style="display: flex; gap: 8px; justify-content: center;">
                <button class="btn-icon-small btn-edit" onclick="editClient('${client.nombre}')" title="Editar">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button class="btn-icon-small btn-delete" onclick="deleteClient('${client.nombre}')" title="Eliminar">
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
                <td class="content-cell"><strong>${client.nombre || 'N/A'}</strong></td>
                <td>${actionButtons}</td>
            </tr>
        `;
    }).join('');
}

/**
 * Carga los clientes en el select del formulario de usuarios
 */
async function loadClientsForUserForm() {
    if (!elements.newUserClient) return;

    try {
        const response = await fetch(`${API_URL}/api/clients`);
        const result = await response.json();

        if (result.success && result.data) {
            // Limpiar opciones excepto la primera
            elements.newUserClient.innerHTML = '<option value="">-- Seleccionar Cliente --</option>';
            
            // Agregar opciones de clientes
            result.data.forEach(client => {
                const option = document.createElement('option');
                option.value = client.nombre;
                option.textContent = client.nombre;
                elements.newUserClient.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error al cargar clientes para formulario:', error);
    }
}

/**
 * Carga los clientes en el filtro de proyecciones
 */
async function loadClientsForProjectionsFilter() {
    const filterClienteProjections = document.getElementById('filterClienteProjections');
    if (!filterClienteProjections) return;

    try {
        const response = await fetch(`${API_URL}/api/clients`);
        const result = await response.json();

        if (result.success && result.data) {
            // Limpiar opciones excepto la primera
            filterClienteProjections.innerHTML = '<option value="">Todos los clientes</option>';
            
            // Agregar opciones de clientes
            result.data.forEach(client => {
                const option = document.createElement('option');
                option.value = client.nombre;
                option.textContent = client.nombre;
                filterClienteProjections.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error al cargar clientes para filtro de proyecciones:', error);
    }
}

/**
 * Carga las referencias en el filtro de proyecciones
 */
function updateReferencesFilter(data, selectedRef) {
    const filterReferenciaProjections = document.getElementById('filterReferenciaProjections');
    if (!filterReferenciaProjections) return;

    const referencias = Array.from(new Set((data || []).map(item => item.referencia).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b));

    filterReferenciaProjections.innerHTML = '<option value="">Todas las referencias</option>';
    referencias.forEach(ref => {
        const option = document.createElement('option');
        option.value = ref;
        option.textContent = ref;
        filterReferenciaProjections.appendChild(option);
    });

    if (selectedRef && referencias.includes(selectedRef)) {
        filterReferenciaProjections.value = selectedRef;
    }
}

/**
 * Actualiza opciones del filtro de referencias (versión simplificada)
 */
function updateReferencesFilterOptions(referencias, selectedRef) {
    const filterReferenciaProjections = document.getElementById('filterReferenciaProjections');
    if (!filterReferenciaProjections) return;

    filterReferenciaProjections.innerHTML = '<option value="">Todas las referencias</option>';
    referencias.forEach(ref => {
        const option = document.createElement('option');
        option.value = ref;
        option.textContent = ref;
        filterReferenciaProjections.appendChild(option);
    });

    if (selectedRef && referencias.includes(selectedRef)) {
        filterReferenciaProjections.value = selectedRef;
    }
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

function getRecordsColspan() {
    if (currentUserRole === 'admin') {
        return 7;
    }

    return currentUserRole === 'superadmin' ? 7 : 6;
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

    const usuarioInstHeaders = document.querySelectorAll('thead .usuario-inst-col');
    const usuarioDesinstHeaders = document.querySelectorAll('thead .usuario-desinst-col');
    const usuarioHeaders = document.querySelectorAll('thead .usuario-col');
    const fechaAlmacenHeaders = document.querySelectorAll('thead .fecha-almacen-col');
    const fechaDespachoHeaders = document.querySelectorAll('thead .fecha-despacho-col');
    const fechaInstHeaders = document.querySelectorAll('thead .fecha-inst-col');
    const fechaDesinstHeaders = document.querySelectorAll('thead .fecha-desinst-col');
    const showInstallColumns = currentUserRole === 'admin';
    usuarioInstHeaders.forEach(th => {
        th.style.display = showInstallColumns ? 'table-cell' : 'none';
    });
    usuarioDesinstHeaders.forEach(th => {
        th.style.display = showInstallColumns ? 'table-cell' : 'none';
    });
    usuarioHeaders.forEach(th => {
        th.style.display = showInstallColumns ? 'none' : 'table-cell';
    });
    fechaAlmacenHeaders.forEach(th => {
        th.style.display = showInstallColumns ? 'none' : 'table-cell';
    });
    fechaDespachoHeaders.forEach(th => {
        th.style.display = showInstallColumns ? 'none' : 'table-cell';
    });
    fechaInstHeaders.forEach(th => {
        th.style.display = showInstallColumns ? 'table-cell' : 'none';
    });
    fechaDesinstHeaders.forEach(th => {
        th.style.display = showInstallColumns ? 'table-cell' : 'none';
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
        
        const usuarioDisplay = currentUserRole === 'superadmin'
            ? (record.usuarioDespacho || '-')
            : (record.usuarioPlanta || '-');

        const usuarioInstalacion = record.usuarioInstalacion || '-';
        const usuarioDesinstalacion = record.usuarioDesinstalacion || '-';
        const fechaInstalacion = record.fechaInstalacion || '-';
        const fechaDesinstalacion = record.fechaDesinstalacion || '-';

        return `
            <tr>
                <td class="content-cell"><strong>${record.referencia}</strong></td>
                <td class="content-cell">${record.serial}</td>
                <td><span class="type-badge type-${estadoClass}">${estadoEmoji} ${record.estado}</span></td>
                <td class="cliente-col" style="display: ${currentUserRole === 'superadmin' ? 'table-cell' : 'none'};">${record.cliente || '-'}</td>
                <td style="display: ${showInstallColumns ? 'none' : 'table-cell'};">${usuarioDisplay}</td>
                <td class="usuario-inst-col" style="display: ${showInstallColumns ? 'table-cell' : 'none'};">${usuarioInstalacion}</td>
                <td class="usuario-desinst-col" style="display: ${showInstallColumns ? 'table-cell' : 'none'};">${usuarioDesinstalacion}</td>
                <td class="fecha-almacen-col" style="display: ${showInstallColumns ? 'none' : 'table-cell'};">${record.fechaAlmacen} <small>${record.horaAlmacen || ''}</small></td>
                <td class="fecha-despacho-col" style="display: ${showInstallColumns ? 'none' : 'table-cell'};">${record.fechaDespacho || '-'} <small>${record.horaDespacho || ''}</small></td>
                <td class="fecha-inst-col" style="display: ${showInstallColumns ? 'table-cell' : 'none'};">${fechaInstalacion}</td>
                <td class="fecha-desinst-col" style="display: ${showInstallColumns ? 'table-cell' : 'none'};">${fechaDesinstalacion}</td>
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
        const colSpan = currentUserRole === 'superadmin' ? '8' : '7';
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
                <td>${row.fechaInstalacion || 'N/A'}</td>
                <td>${row.fechaDesinstalacion || 'N/A'}</td>
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
// MÓDULO DE PROYECCIONES
// ============================================

let ordersProjectionChart = null;
let filterDurationChart = null;

/**
 * Carga los datos de proyecciones
 */
async function loadProjections() {
    try {
        const filterClienteEl = document.getElementById('filterClienteProjections');
        const filterReferenciaEl = document.getElementById('filterReferenciaProjections');
        const filterCliente = filterClienteEl ? filterClienteEl.value : '';
        const filterReferencia = filterReferenciaEl ? filterReferenciaEl.value : '';
        const clienteParam = filterCliente ? `?cliente=${encodeURIComponent(filterCliente)}` : '';

        const response = await fetch(`${API_URL}/api/projections${clienteParam}`, {
            headers: {
                'x-auth-user': currentUsername,
                'x-auth-password': currentUserPassword
            }
        });

        const result = await response.json();

        if (!result.success) {
            showToast(result.message || 'Error al cargar proyecciones', 'error');
            return;
        }

        const { nextReplacements, stats } = result.data;

        // Extraer referencias únicas de los datos para el filtro
        const referencias = [...new Set(nextReplacements.map(item => item.referencia))].sort();
        updateReferencesFilterOptions(referencias, filterReferencia);

        // Aplicar filtro de referencia
        let filteredReplacements = nextReplacements;
        if (filterReferencia) {
            filteredReplacements = nextReplacements.filter(item => item.referencia === filterReferencia);
        }

        // Actualizar tablas
        updateNextReplacementsTable(filteredReplacements);

        // Actualizar estadísticas
        document.getElementById('avgDaysDuration').textContent = stats.avgDaysDuration + ' días';
        document.getElementById('totalFiltersAnalyzed').textContent = stats.totalFiltersAnalyzed;
        document.getElementById('nextMonthOrders').textContent = stats.nextReplacementsCount;

        // Actualizar gráfica de próximos cambios
        updateNextReplacementsChart(filteredReplacements);

        showToast('Proyecciones actualizadas', 'success');

    } catch (error) {
        console.error('Error al cargar proyecciones:', error);
        showToast('Error al cargar proyecciones', 'error');
    }
}

/**
 * Actualiza la tabla de duración de filtros
 */
function updateFilterDurationTable(data) {
    const tbody = document.getElementById('filterDurationBody');

    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="no-data">No hay datos de duración de filtros</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(item => `
        <tr>
            <td>${item.cliente}</td>
            <td>${item.referencia}</td>
            <td>${item.kmInstalacion.toLocaleString()}</td>
            <td>${item.kmDesinstalacion.toLocaleString()}</td>
            <td><strong>${item.duracionKm.toLocaleString()} km</strong></td>
            <td>${item.diasInstalado} días</td>
            <td>${item.placa || '-'}</td>
        </tr>
    `).join('');
}

/**
 * Actualiza la tabla de próximos cambios (filtros a reemplazar)
 */
function updateNextReplacementsTable(data) {
    const tbody = document.getElementById('ordersProjectionBody');

    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="no-data">No hay próximos cambios programados</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(item => `
        <tr>
            <td>${item.cliente}</td>
            <td>${item.referencia}</td>
            <td>${item.fechaInstalacion}</td>
            <td><strong>${item.duracionPromedioDias} días</strong></td>
            <td><strong>${item.fechaEstimadaReemplazo}</strong></td>
            <td>${item.placa || '-'}</td>
        </tr>
    `).join('');
}

/**
 * Actualiza la gráfica de próximos cambios
 */
function updateNextReplacementsChart(data) {
    const ctx = document.getElementById('ordersProjectionChart');
    
    if (!ctx) return;

    // Destruir gráfica anterior si existe
    if (ordersProjectionChart) {
        ordersProjectionChart.destroy();
    }

    if (!data || data.length === 0) {
        return;
    }

    // Agrupar por mes de reemplazo estimado para visualización
    const replacementsByMonth = {};
    data.forEach(item => {
        const parts = item.fechaEstimadaReemplazo.split('/');
        const month = `${parts[1]}/${parts[2]}`; // MM/YYYY
        replacementsByMonth[month] = (replacementsByMonth[month] || 0) + 1;
    });

    // Ordenar meses
    const sortedMonths = Object.keys(replacementsByMonth).sort((a, b) => {
        const [monthA, yearA] = a.split('/');
        const [monthB, yearB] = b.split('/');
        const dateA = new Date(yearA, monthA - 1);
        const dateB = new Date(yearB, monthB - 1);
        return dateA - dateB;
    });

    const labels = sortedMonths.map(m => {
        const [month, year] = m.split('/');
        const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
        return `${months[parseInt(month) - 1]} ${year}`;
    });
    const values = sortedMonths.map(m => replacementsByMonth[m]);

    ordersProjectionChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Cambios de Filtro Estimados',
                data: values,
                backgroundColor: 'rgba(255, 159, 64, 0.6)',
                borderColor: 'rgba(255, 159, 64, 1)',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        boxWidth: window.innerWidth < 480 ? 12 : 20,
                        font: {
                            size: window.innerWidth < 480 ? 10 : 12
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: ${context.parsed.y} filtros`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        font: {
                            size: window.innerWidth < 480 ? 9 : 11
                        },
                        maxRotation: window.innerWidth < 480 ? 45 : 0,
                        minRotation: window.innerWidth < 480 ? 45 : 0
                    }
                },
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1,
                        font: {
                            size: window.innerWidth < 480 ? 9 : 11
                        }
                    }
                }
            }
        }
    });
}

/**
 * Actualiza la gráfica de duración de filtros
 */
function updateFilterDurationChart(data) {
    const ctx = document.getElementById('filterDurationChart');
    
    if (!ctx) return;

    // Destruir gráfica anterior si existe
    if (filterDurationChart) {
        filterDurationChart.destroy();
    }

    if (!data || data.length === 0) {
        return;
    }

    // Agrupar por cliente y referencia, calcular promedio
    const filterData = {};
    data.forEach(item => {
        const key = `${item.cliente} - ${item.referencia}`;
        if (!filterData[key]) {
            filterData[key] = {
                totalKm: 0,
                count: 0
            };
        }
        filterData[key].totalKm += item.duracionKm;
        filterData[key].count++;
    });

    const labels = Object.keys(filterData);
    const values = labels.map(key => 
        Math.round(filterData[key].totalKm / filterData[key].count)
    );

    const colors = generateColors(labels.length);

    filterDurationChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Duración Promedio (Km)',
                data: values,
                backgroundColor: colors.backgrounds,
                borderColor: colors.borders,
                borderWidth: 2
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Duración: ${context.parsed.x.toLocaleString()} km promedio`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: {
                        font: {
                            size: window.innerWidth < 480 ? 9 : 11
                        }
                    },
                    title: {
                        display: true,
                        text: 'Kilómetros',
                        font: {
                            size: window.innerWidth < 480 ? 10 : 12
                        }
                    }
                },
                y: {
                    ticks: {
                        font: {
                            size: window.innerWidth < 480 ? 8 : 10
                        }
                    }
                }
            }
        }
    });
}

/**
 * Genera colores para gráficas
 */
function generateColors(count) {
    const baseColors = [
        { bg: 'rgba(255, 99, 132, 0.6)', border: 'rgba(255, 99, 132, 1)' },
        { bg: 'rgba(54, 162, 235, 0.6)', border: 'rgba(54, 162, 235, 1)' },
        { bg: 'rgba(255, 206, 86, 0.6)', border: 'rgba(255, 206, 86, 1)' },
        { bg: 'rgba(75, 192, 192, 0.6)', border: 'rgba(75, 192, 192, 1)' },
        { bg: 'rgba(153, 102, 255, 0.6)', border: 'rgba(153, 102, 255, 1)' },
        { bg: 'rgba(255, 159, 64, 0.6)', border: 'rgba(255, 159, 64, 1)' }
    ];

    const backgrounds = [];
    const borders = [];

    for (let i = 0; i < count; i++) {
        const color = baseColors[i % baseColors.length];
        backgrounds.push(color.bg);
        borders.push(color.border);
    }

    return { backgrounds, borders };
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
