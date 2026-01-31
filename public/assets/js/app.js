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
    toastContainer: document.getElementById('toastContainer')
};

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
    
    // Inicializar escáner
    html5QrCode = new Html5Qrcode("reader");
    
    // Cargar cámaras disponibles
    await loadCameras();
    
    // Configurar event listeners
    setupEventListeners();
    
    // Cargar datos iniciales
    await loadRecentScans();
    await loadStats();
    
    // Actualizar datos cada 30 segundos
    setInterval(async () => {
        if (!isScanning) {
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
    elements.startBtn.addEventListener('click', startScanning);
    elements.stopBtn.addEventListener('click', stopScanning);
    elements.clearResult.addEventListener('click', clearLastResult);
    elements.refreshBtn.addEventListener('click', () => {
        loadRecentScans();
        loadStats();
    });
    elements.exportBtn.addEventListener('click', exportToCSV);
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
                qrContent
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
        const response = await fetch(`${API_URL}/api/stats`);
        const result = await response.json();
        
        if (result.success) {
            displayStats(result.data);
        }
    } catch (error) {
        console.error('Error al cargar estadísticas:', error);
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
