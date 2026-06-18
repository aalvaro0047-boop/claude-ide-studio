// preload.js — Puente seguro entre proceso main y renderer
// Este archivo corre en un contexto aislado y expone SOLO las APIs
// necesarias al renderer a través de contextBridge.exposeInMainWorld.
// El renderer NO puede usar require() directamente.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Control de la ventana ─────────────────────────────────────────────────
  minimizarVentana: () => ipcRenderer.send('window:minimize'),
  maximizarVentana: () => ipcRenderer.send('window:maximize'),
  cerrarVentana:    () => ipcRenderer.send('window:close'),

  // ── Terminal ──────────────────────────────────────────────────────────────

  // Crear nueva terminal → devuelve Promise<{ id: number|null, error: string|null }>
  crearTerminal: (cols, rows) =>
    ipcRenderer.invoke('terminal:create', { cols, rows }),

  // Enviar input del usuario al proceso pty
  escribirTerminal: (id, data) =>
    ipcRenderer.send('terminal:write', { id, data }),

  // Notificar al proceso pty del nuevo tamaño del panel
  redimensionarTerminal: (id, cols, rows) =>
    ipcRenderer.send('terminal:resize', { id, cols, rows }),

  // Cerrar proceso pty de una pestaña
  cerrarTerminal: (id) =>
    ipcRenderer.send('terminal:close', id),

  // Escuchar output de la terminal (main → renderer)
  // callback recibe { id: number, data: string }
  onDatosTerminal: (callback) => {
    ipcRenderer.on('terminal:data', (_event, payload) => callback(payload))
  },

  // Escuchar cuando un proceso de terminal termina
  // callback recibe { id: number, exitCode: number }
  onSalidaTerminal: (callback) => {
    ipcRenderer.on('terminal:exit', (_event, payload) => callback(payload))
  },

  // ── Chat → Terminal ───────────────────────────────────────────────────────
  // Enviar texto del chat al proceso pty activo
  enviarComandoChat: (text, tabId) =>
    ipcRenderer.send('chat:send', { text, tabId }),

  // ── Utilidades ────────────────────────────────────────────────────────────
  // Limpiar listeners para evitar memory leaks al recargar
  quitarListeners: (canal) => {
    ipcRenderer.removeAllListeners(canal)
  }
})
