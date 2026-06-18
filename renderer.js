// renderer.js — Lógica del frontend de Claude IDE Studio
//
// REGLA: NO usar require() en este archivo.
// Toda comunicación con el proceso main se hace a través de
// window.electronAPI (expuesto en preload.js via contextBridge).
//
// Las clases Terminal y FitAddon vienen de los <script> en index.html:
//   window.Terminal        → xterm.js 4.x (UMD build)
//   window.FitAddon.FitAddon → xterm-addon-fit (UMD build)

// ============================================================================
// ESTADO GLOBAL DE LA APLICACIÓN
// ============================================================================
const estado = {
  // Map<tabId, { terminal: Terminal, fitAddon: FitAddon, wrapper: HTMLElement }>
  terminales: new Map(),
  tabActivo: null,          // ID del tab de terminal actualmente visible
  timerInterval: null,      // setInterval del cronómetro de sesión
  timerInicio: Date.now(),  // Timestamp de inicio de la sesión
  resizeObserver: null,     // Observer para redimensionar la terminal activa
}

// ============================================================================
// PUNTO DE ENTRADA — espera a que el DOM esté listo
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  initControlesVentana()
  initNavegador()
  initChat()
  initResizers()
  initTimer()

  // Registrar listeners de datos de terminal ANTES de crear la primera
  window.electronAPI.onDatosTerminal(({ id, data }) => {
    const entrada = estado.terminales.get(id)
    if (entrada) entrada.terminal.write(data)
  })

  window.electronAPI.onSalidaTerminal(({ id, exitCode }) => {
    console.log(`[Terminal ${id}] proceso terminó (código ${exitCode})`)
    marcarTabTerminado(id)
  })

  // Crear la primera terminal al arrancar
  await crearNuevaTerminal()

  // ResizeObserver: redimensiona la terminal cuando cambia el panel
  const debounceResize = debounce(() => {
    if (estado.tabActivo !== null) {
      const entrada = estado.terminales.get(estado.tabActivo)
      if (entrada) {
        entrada.fitAddon.fit()
        window.electronAPI.redimensionarTerminal(
          estado.tabActivo,
          entrada.terminal.cols,
          entrada.terminal.rows
        )
      }
    }
  }, 60)

  estado.resizeObserver = new ResizeObserver(debounceResize)
  estado.resizeObserver.observe(document.getElementById('termContainer'))
})

// ============================================================================
// CONTROLES DE VENTANA (minimizar / maximizar / cerrar)
// ============================================================================
function initControlesVentana() {
  document.getElementById('btnMinimize').onclick = () =>
    window.electronAPI.minimizarVentana()

  document.getElementById('btnMaximize').onclick = () =>
    window.electronAPI.maximizarVentana()

  document.getElementById('btnClose').onclick = () => {
    limpiarAlCerrar()
    window.electronAPI.cerrarVentana()
  }
}

// ============================================================================
// NAVEGADOR WEB — Panel izquierdo (webview de claude.ai)
// ============================================================================
function initNavegador() {
  const webview = document.getElementById('claudeWebview')
  if (!webview) return

  // Los métodos del webview (goBack, reload…) solo están disponibles
  // después del evento 'dom-ready'
  webview.addEventListener('dom-ready', () => {
    document.getElementById('btnBack').onclick = () => {
      if (webview.canGoBack()) webview.goBack()
    }
    document.getElementById('btnForward').onclick = () => {
      if (webview.canGoForward()) webview.goForward()
    }
    document.getElementById('btnReload').onclick = () => webview.reload()
  })
}

// ============================================================================
// CHAT — Panel central
// ============================================================================
function initChat() {
  const input  = document.getElementById('chatInput')
  const btnEnv = document.getElementById('btnSend')

  btnEnv.onclick = enviarChat

  input.addEventListener('keydown', (e) => {
    // Enter solo → enviar | Shift+Enter → salto de línea
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      enviarChat()
    }
  })
}

function enviarChat() {
  const input = document.getElementById('chatInput')
  const texto = input.value.trim()
  if (!texto) return

  agregarMensajeChat('user', texto)

  if (estado.tabActivo !== null) {
    window.electronAPI.enviarComandoChat(texto, estado.tabActivo)
  } else {
    agregarMensajeChat('system', '⚠ No hay ninguna terminal activa. Crea una con el botón "+".')
  }

  input.value = ''
  input.focus()
}

function agregarMensajeChat(tipo, texto) {
  const contenedor = document.getElementById('chatMessages')

  const div = document.createElement('div')
  div.className = `msg msg-${tipo}`

  const iconos = { user: '👤', system: '⬡', bot: '🤖' }
  const icono  = iconos[tipo] || '·'

  div.innerHTML = `
    <span class="msg-icon">${icono}</span>
    <div class="msg-body"><p>${escaparHTML(texto)}</p></div>
  `

  contenedor.appendChild(div)
  // Scroll automático al último mensaje
  contenedor.scrollTop = contenedor.scrollHeight
}

function escaparHTML(str) {
  const el = document.createElement('div')
  el.appendChild(document.createTextNode(str))
  return el.innerHTML
}

// ============================================================================
// TERMINAL — Panel derecho
// ============================================================================

// Tema de colores para xterm.js
const XTERM_TEMA = {
  background:    '#0d0d15',
  foreground:    '#e8e8f0',
  cursor:        '#a855f7',
  cursorAccent:  '#0d0d15',
  selection:     'rgba(168,85,247,0.25)',
  black:         '#1a1a2e',
  red:           '#ff6b6b',
  green:         '#50fa7b',
  yellow:        '#f1fa8c',
  blue:          '#3b82f6',
  magenta:       '#a855f7',
  cyan:          '#06b6d4',
  white:         '#f8f8f2',
  brightBlack:   '#44475a',
  brightRed:     '#ff8e8e',
  brightGreen:   '#69ff94',
  brightYellow:  '#ffffa5',
  brightBlue:    '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan:    '#22d3ee',
  brightWhite:   '#ffffff',
}

document.getElementById('btnNuevaTab').onclick = () => crearNuevaTerminal()

async function crearNuevaTerminal() {
  // Verificar que xterm.js está disponible (cargado vía script tag)
  if (typeof Terminal === 'undefined') {
    mostrarErrorTerminal('xterm.js no se cargó correctamente. Comprueba la ruta en index.html.')
    return
  }

  const contenedor = document.getElementById('termContainer')
  const { cols, rows } = calcularDimensiones(contenedor)

  // Pedir al proceso main que spawne un nuevo proceso PowerShell
  const { id, error } = await window.electronAPI.crearTerminal(cols, rows)

  if (error) {
    mostrarErrorTerminal(error)
    return
  }

  // Ocultar el spinner de carga inicial
  const loading = document.getElementById('termLoading')
  if (loading) loading.style.display = 'none'

  // Crear div contenedor para esta instancia de xterm
  const wrapper = document.createElement('div')
  wrapper.className  = 'term-wrapper'
  wrapper.id         = `termwrap-${id}`
  wrapper.style.display = 'none'
  contenedor.appendChild(wrapper)

  // Instanciar xterm Terminal
  const terminal = new Terminal({
    fontSize:         13,
    fontFamily:       "'Cascadia Code', 'Fira Code', Consolas, monospace",
    theme:            XTERM_TEMA,
    cursorBlink:      true,
    scrollback:       2000,
    allowTransparency: true,
    convertEol:       true,
  })

  // FitAddon: auto-ajusta cols/rows al tamaño del contenedor
  const fitAddon = new FitAddon.FitAddon()
  terminal.loadAddon(fitAddon)

  // Montar xterm en el DOM
  terminal.open(wrapper)

  // Input del usuario en xterm → enviar al proceso pty vía IPC
  terminal.onData(data => {
    window.electronAPI.escribirTerminal(id, data)
  })

  // Guardar referencia
  estado.terminales.set(id, { terminal, fitAddon, wrapper })

  // Crear pestaña en la barra
  crearPestana(id)

  // Activar esta terminal
  activarTerminal(id)

  // Ajustar tamaño después de renderizado (requestAnimationFrame garantiza que el DOM tenga dimensiones)
  requestAnimationFrame(() => {
    try {
      fitAddon.fit()
      window.electronAPI.redimensionarTerminal(id, terminal.cols, terminal.rows)
    } catch (_) {}
  })
}

// Calcular cols/rows aproximados para el contenedor dado
function calcularDimensiones(contenedor) {
  const ancho = contenedor.clientWidth  || 800
  const alto  = contenedor.clientHeight || 400
  const cols  = Math.max(20, Math.floor((ancho - 16) / 8.5))
  const rows  = Math.max(5,  Math.floor((alto  - 10) / 17.5))
  return { cols, rows }
}

// Crear botón de pestaña en la barra superior del panel derecho
function crearPestana(tabId) {
  const barTabs = document.getElementById('termTabs')
  const numTab  = estado.terminales.size

  const tab = document.createElement('div')
  tab.className = 'term-tab'
  tab.id        = `tab-${tabId}`
  tab.innerHTML = `
    <span class="tab-label">PS ${numTab}</span>
    <button class="tab-close-btn" title="Cerrar">✕</button>
  `

  // Clic en la pestaña → activar esa terminal
  tab.addEventListener('click', (e) => {
    if (!e.target.classList.contains('tab-close-btn')) {
      activarTerminal(tabId)
    }
  })

  // Clic en la X → cerrar esa terminal
  tab.querySelector('.tab-close-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    cerrarTerminal(tabId)
  })

  barTabs.appendChild(tab)
}

// Mostrar una terminal y ocultar las demás
function activarTerminal(tabId) {
  // Ocultar todas
  estado.terminales.forEach(({ wrapper }, id) => {
    wrapper.style.display = 'none'
    document.getElementById(`tab-${id}`)?.classList.remove('activo')
  })

  // Mostrar la seleccionada
  const entrada = estado.terminales.get(tabId)
  if (!entrada) return

  entrada.wrapper.style.display = 'block'
  estado.tabActivo = tabId

  document.getElementById(`tab-${tabId}`)?.classList.add('activo')

  // Fit y foco tras mostrar (pequeño delay para que el layout esté estable)
  setTimeout(() => {
    try {
      entrada.fitAddon.fit()
      window.electronAPI.redimensionarTerminal(tabId, entrada.terminal.cols, entrada.terminal.rows)
    } catch (_) {}
    entrada.terminal.focus()
  }, 30)
}

// Cerrar una terminal y su pestaña
function cerrarTerminal(tabId) {
  const entrada = estado.terminales.get(tabId)
  if (!entrada) return

  window.electronAPI.cerrarTerminal(tabId)

  entrada.terminal.dispose()
  entrada.wrapper.remove()
  document.getElementById(`tab-${tabId}`)?.remove()

  estado.terminales.delete(tabId)

  // Si era el tab activo, activar el primero disponible
  if (estado.tabActivo === tabId) {
    const primero = estado.terminales.keys().next().value
    if (primero !== undefined) activarTerminal(primero)
    else estado.tabActivo = null
  }
}

// Marcar visualmente una pestaña cuyo proceso terminó
function marcarTabTerminado(tabId) {
  const tab = document.getElementById(`tab-${tabId}`)
  if (tab) tab.classList.add('terminado')
}

// Mostrar error en el panel de terminal
function mostrarErrorTerminal(mensaje) {
  const loading = document.getElementById('termLoading')
  if (loading) {
    loading.style.display = 'flex'
    loading.innerHTML = `<p class="error-msg">❌ ${mensaje}</p>`
  }
}

// ============================================================================
// DIVISORES REDIMENSIONABLES — drag para cambiar ancho de los paneles
// ============================================================================
function initResizers() {
  const layout      = document.querySelector('.layout')
  const panelLeft   = document.getElementById('panelLeft')
  const panelCenter = document.getElementById('panelCenter')
  const panelRight  = document.getElementById('panelRight')
  const handleLeft  = document.getElementById('resizeLeft')
  const handleRight = document.getElementById('resizeRight')

  let dragging  = null  // 'left' | 'right' | null
  let startX    = 0
  let anchos    = {}

  const MIN_PANEL = 180  // Ancho mínimo de cualquier panel (px)

  function empezarDrag(which, e) {
    dragging = which
    startX   = e.clientX
    anchos   = {
      left:   panelLeft.offsetWidth,
      center: panelCenter.offsetWidth,
      right:  panelRight.offsetWidth,
    }
    document.body.style.cursor     = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }

  handleLeft.addEventListener('mousedown',  (e) => empezarDrag('left',  e))
  handleRight.addEventListener('mousedown', (e) => empezarDrag('right', e))

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const delta = e.clientX - startX

    if (dragging === 'left') {
      const nuevoLeft   = Math.max(MIN_PANEL, anchos.left + delta)
      const nuevoCenter = anchos.center - (nuevoLeft - anchos.left)
      if (nuevoCenter < MIN_PANEL) return
      panelLeft.style.flex   = `0 0 ${nuevoLeft}px`
      panelCenter.style.flex = `0 0 ${nuevoCenter}px`
    } else {
      const nuevoRight  = Math.max(MIN_PANEL, anchos.right - delta)
      const nuevoCenter = anchos.center - (nuevoRight - anchos.right)
      if (nuevoCenter < MIN_PANEL) return
      panelRight.style.flex  = `0 0 ${nuevoRight}px`
      panelCenter.style.flex = `0 0 ${nuevoCenter}px`
    }
  })

  document.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = null
    document.body.style.cursor     = ''
    document.body.style.userSelect = ''

    // Redimensionar la terminal activa después de mover el panel
    if (estado.tabActivo !== null) {
      const entrada = estado.terminales.get(estado.tabActivo)
      if (entrada) {
        setTimeout(() => {
          try {
            entrada.fitAddon.fit()
            window.electronAPI.redimensionarTerminal(
              estado.tabActivo,
              entrada.terminal.cols,
              entrada.terminal.rows
            )
          } catch (_) {}
        }, 50)
      }
    }
  })
}

// ============================================================================
// TIMER DE SESIÓN Y CONTADOR DE TOKENS
// ============================================================================
function initTimer() {
  const timerEl = document.getElementById('sessionTimer')
  estado.timerInicio = Date.now()

  estado.timerInterval = setInterval(() => {
    const totalSeg = Math.floor((Date.now() - estado.timerInicio) / 1000)
    const d = Math.floor(totalSeg / 86400)
    const h = Math.floor((totalSeg % 86400) / 3600)
    const m = Math.floor((totalSeg % 3600) / 60)
    const s = totalSeg % 60
    timerEl.textContent = `${d}d ${h}h ${m}m ${s}s`
  }, 1000)
}

// ============================================================================
// LIMPIEZA AL CERRAR
// ============================================================================
function limpiarAlCerrar() {
  // Limpiar interval del timer para evitar memory leak
  if (estado.timerInterval) {
    clearInterval(estado.timerInterval)
    estado.timerInterval = null
  }

  // Desconectar observer de resize
  if (estado.resizeObserver) {
    estado.resizeObserver.disconnect()
  }

  // Liberar instancias de xterm (los procesos pty los cierra main.js)
  estado.terminales.forEach(({ terminal }) => {
    try { terminal.dispose() } catch (_) {}
  })
}

// ============================================================================
// UTILIDADES
// ============================================================================
function debounce(fn, delay) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}
