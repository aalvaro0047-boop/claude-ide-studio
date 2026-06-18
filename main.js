// main.js — Proceso principal de Electron para Claude IDE Studio
// Toda la lógica de Node.js vive aquí: ventana, IPC, node-pty, updates

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')

// ── Estado global ─────────────────────────────────────────────────────────────
let mainWindow = null
const procesos = {}   // Map: tabId (number) → instancia pty
let contadorTabs = 0  // Genera IDs únicos para cada pestaña de terminal

// ── Auto-updater (solo en producción empaquetada) ─────────────────────────────
let autoUpdater = null
try {
  autoUpdater = require('electron-updater').autoUpdater
} catch (e) {
  console.log('[Updater] No se pudo cargar electron-updater:', e.message)
}

// =============================================================================
// CREACIÓN DE VENTANA
// =============================================================================
function crearVentana() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,              // Ocultamos la barra de título nativa
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,  // Aislamiento de contexto activado (seguridad)
      nodeIntegration: false,  // Node.js desactivado en el renderer
      webviewTag: true,        // Permite <webview> para cargar claude.ai
      devTools: true
    }
  })

  mainWindow.loadFile('index.html')

  // Abrir enlaces externos en el navegador del sistema en vez de en la app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    limpiarRecursos()
    mainWindow = null
  })
}

// =============================================================================
// LIMPIEZA DE RECURSOS
// =============================================================================
function limpiarRecursos() {
  Object.entries(procesos).forEach(([id, pty]) => {
    try { pty.kill() } catch (_) {}
    delete procesos[id]
  })
}

// =============================================================================
// IPC — CONTROLES DE VENTANA
// =============================================================================
ipcMain.on('window:minimize', () => mainWindow?.minimize())

ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.restore()
  else mainWindow?.maximize()
})

ipcMain.on('window:close', () => mainWindow?.close())

// =============================================================================
// IPC — TERMINAL (node-pty)
// =============================================================================

// Crear nuevo proceso de terminal y devolver su ID
ipcMain.handle('terminal:create', async (_event, { cols = 80, rows = 24 } = {}) => {
  let nodePty
  try {
    nodePty = require('@lydell/node-pty')
  } catch (err) {
    // Detectar error de incompatibilidad de ABI (versión de módulo nativo)
    const esVersionMismatch = err.message.includes('version') ||
                              err.message.includes('NODE_MODULE_VERSION')
    const msg = esVersionMismatch
      ? '⚠ Binarios nativos desactualizados. Ejecuta: npm run rebuild'
      : `No se pudo cargar node-pty: ${err.message}`
    console.error('[Terminal]', msg)
    return { id: null, error: msg }
  }

  const tabId = ++contadorTabs
  // PowerShell en Windows, bash en Linux/Mac
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
  const cwd   = process.env.USERPROFILE || process.env.HOME || process.cwd()

  let ptyProc
  try {
    ptyProc = nodePty.spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: process.env
    })
  } catch (err) {
    return { id: null, error: `Error al iniciar PowerShell: ${err.message}` }
  }

  procesos[tabId] = ptyProc

  // Reenviar output del proceso al renderer
  ptyProc.onData(data => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id: tabId, data })
    }
  })

  // Notificar cuando el proceso termina (ej. usuario escribe "exit")
  ptyProc.onExit(({ exitCode }) => {
    delete procesos[tabId]
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id: tabId, exitCode })
    }
  })

  return { id: tabId, error: null }
})

// Enviar tecla/texto al proceso pty (input del usuario desde xterm)
ipcMain.on('terminal:write', (_event, { id, data }) => {
  if (procesos[id]) procesos[id].write(data)
})

// Redimensionar el proceso pty cuando cambia el tamaño del panel
ipcMain.on('terminal:resize', (_event, { id, cols, rows }) => {
  if (procesos[id]) {
    try {
      procesos[id].resize(Math.max(2, cols), Math.max(2, rows))
    } catch (e) {
      console.error('[Terminal] Error al redimensionar:', e.message)
    }
  }
})

// Cerrar proceso pty al cerrar una pestaña
ipcMain.on('terminal:close', (_event, id) => {
  if (procesos[id]) {
    try { procesos[id].kill() } catch (_) {}
    delete procesos[id]
  }
})

// =============================================================================
// IPC — CHAT → TERMINAL
// Escribe el mensaje del chat como comando en la terminal activa
// =============================================================================
ipcMain.on('chat:send', (_event, { text, tabId }) => {
  if (procesos[tabId]) {
    procesos[tabId].write(text + '\r')
  }
})

// =============================================================================
// CICLO DE VIDA DE LA APP
// =============================================================================
app.whenReady().then(() => {
  crearVentana()

  // Activar auto-updates solo en la app empaquetada (no en desarrollo)
  if (app.isPackaged && autoUpdater) {
    autoUpdater.checkForUpdatesAndNotify().catch(e => {
      console.log('[Updater] Sin actualizaciones disponibles:', e.message)
    })
  }
})

app.on('window-all-closed', () => {
  limpiarRecursos()
  // En macOS las apps permanecen activas aunque se cierren todas las ventanas
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  // En macOS, recrear la ventana al hacer click en el dock si no hay ventanas abiertas
  if (BrowserWindow.getAllWindows().length === 0) crearVentana()
})
