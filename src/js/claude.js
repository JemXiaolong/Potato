/**
 * Claude: panel lateral de chat con Claude Code.
 */
const Claude = {
  _container: null,
  _messagesEl: null,
  _inputEl: null,
  _currentStreamEl: null,
  _streamBuffer: '',

  state: {
    sessionId: null,
    claudeSessionId: null,
    messages: [],
    isStreaming: false,
    installed: false,
    model: 'sonnet',
    workingDir: null,    // null = usa vault path (para agentes)
    projectDir: null,    // directorio del proyecto/código
    mode: 'vault',       // 'vault' o 'project'
    agents: [],          // agentes custom disponibles
    commands: [],        // comandos custom disponibles
    commandsDir: null,   // directorio de comandos custom
    allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    sessionApprovedTools: [],
    panelMode: 'closed', // 'closed', 'normal', 'minimized', 'maximized'
    agentsOnly: false,   // true = pure router, false = hybrid
    graphView: false,
    graphNodes: [],      // [{id, name, desc, status}]
    _agentTimers: {},    // {tool_id: timeoutId} — debounce per agent
    mcpServers: [],      // McpServerInfo[] del ultimo scan
    mcpSelected: [],     // string[] nombres habilitados
    mcpScanning: false,
  },

  invoke: null,

  init(containerId) {
    this._messagesEl = document.getElementById(containerId);
    this._container = document.getElementById('claude-panel');
    this._inputEl = document.getElementById('claude-input');
    this.invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : async () => null;

    // Send button
    document.getElementById('claude-send-btn').addEventListener('click', () => this.sendMessage());

    // Stop button
    document.getElementById('claude-stop-btn').addEventListener('click', () => this.stopGeneration());

    // New chat button
    document.getElementById('claude-new-btn').addEventListener('click', () => this.newChat());

    // Close button
    document.getElementById('claude-close-btn').addEventListener('click', () => this.toggle());

    // Toggle button
    document.getElementById('claude-toggle-btn').addEventListener('click', () => this.toggle());

    // Minimize button
    document.getElementById('claude-minimize-btn').addEventListener('click', () => this.minimize());

    // Minimized pill click
    document.getElementById('claude-minimized-pill').addEventListener('click', () => this.restoreFromMinimize());

    // Graph view button
    document.getElementById('claude-graph-btn').addEventListener('click', () => this._toggleGraphView());

    // Maximize button
    document.getElementById('claude-maximize-btn').addEventListener('click', () => {
      if (this.state.panelMode === 'maximized') {
        this.restoreFromMaximize();
      } else {
        this.maximize();
      }
    });

    // History button
    document.getElementById('claude-history-btn').addEventListener('click', () => this._toggleHistory());

    // History close button
    document.getElementById('claude-history-close').addEventListener('click', () => this._toggleHistory(false));

    // Compact note resize
    this._initCompactNoteResize();

    // Model selector
    document.getElementById('claude-model-select').addEventListener('change', (e) => {
      this.state.model = e.target.value;
    });

    // Mode selector
    document.getElementById('claude-mode-select').addEventListener('change', (e) => {
      this.state.mode = e.target.value;
      this.updateContext();
    });

    // Working directory - load saved
    const savedDir = localStorage.getItem('potato-claude-workdir');
    if (savedDir) {
      this.state.workingDir = savedDir;
    }

    // Project directory - load saved
    const savedProjectDir = localStorage.getItem('potato-claude-projectdir');
    if (savedProjectDir) {
      this.state.projectDir = savedProjectDir;
    }

    // Working directory button in settings
    document.getElementById('setting-claude-workdir-btn').addEventListener('click', () => this._pickWorkingDir());

    // Working directory input - paste/type path
    document.getElementById('setting-claude-workdir-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._setWorkingDirFromInput(); }
    });
    document.getElementById('setting-claude-workdir-input').addEventListener('blur', () => this._setWorkingDirFromInput());

    // Project directory button in settings
    document.getElementById('setting-claude-projectdir-btn').addEventListener('click', () => this._pickProjectDir());

    // Project directory input - paste/type path
    document.getElementById('setting-claude-projectdir-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._setProjectDirFromInput(); }
    });
    document.getElementById('setting-claude-projectdir-input').addEventListener('blur', () => this._setProjectDirFromInput());

    // Agents only toggle - load saved preference
    const savedAgentsOnly = localStorage.getItem('potato-claude-agents-only');
    if (savedAgentsOnly === 'true') this.state.agentsOnly = true;

    document.getElementById('setting-claude-agents-only').addEventListener('change', (e) => {
      this.state.agentsOnly = e.target.checked;
      localStorage.setItem('potato-claude-agents-only', e.target.checked);
    });

    // MCP servers - load saved scan results and selection
    try {
      const savedMcp = localStorage.getItem('potato-mcp-scan-results');
      if (savedMcp) this.state.mcpServers = JSON.parse(savedMcp);
    } catch (_) {}
    try {
      const savedSel = localStorage.getItem('potato-mcp-selected');
      if (savedSel) this.state.mcpSelected = JSON.parse(savedSel);
    } catch (_) {}

    document.getElementById('setting-mcp-scan-btn').addEventListener('click', () => this._scanMcpServers());

    // User context - load saved
    this._userContext = localStorage.getItem('potato-claude-context') || '';
    const ctxEl = document.getElementById('setting-claude-context');
    if (ctxEl) {
      ctxEl.value = this._userContext;
      ctxEl.addEventListener('input', () => {
        this._userContext = ctxEl.value;
        localStorage.setItem('potato-claude-context', ctxEl.value);
      });
    }

    // Commands directory - load saved + listeners
    this.state.commandsDir = localStorage.getItem('potato-claude-commandsdir') || null;

    document.getElementById('setting-claude-commandsdir-btn').addEventListener('click', () => this._pickCommandsDir());
    document.getElementById('setting-claude-commandsdir-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._setCommandsDirFromInput(); }
    });
    document.getElementById('setting-claude-commandsdir-input').addEventListener('blur', () => this._setCommandsDirFromInput());

    // Input: Enter to send, Shift+Enter for newline, autocomplete nav
    this._inputEl.addEventListener('keydown', (e) => {
      // Autocomplete navigation
      if (this._autocompleteVisible()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); this._autocompleteNav(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this._autocompleteNav(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') {
          const selected = document.querySelector('.claude-ac-item.active');
          if (selected) { e.preventDefault(); this._autocompleteSelect(selected); return; }
        }
        if (e.key === 'Escape') { e.preventDefault(); this._autocompleteHide(); return; }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Auto-resize textarea + autocomplete trigger
    this._inputEl.addEventListener('input', () => {
      this._autoResize();
      this._autocompleteCheck();
    });

    // Hide autocomplete on blur
    this._inputEl.addEventListener('blur', () => {
      setTimeout(() => this._autocompleteHide(), 150);
    });

    // Delegated click handler for vault links
    this._messagesEl.addEventListener('click', (e) => {
      const link = e.target.closest('.claude-vault-link');
      if (!link) return;
      e.preventDefault();
      const path = link.dataset.path;
      const title = link.dataset.title;
      if (path && title) {
        App.openNote(path, title);
      }
    });

    // Check if Claude is installed
    this._checkInstalled();

    // Load agents
    this._loadAgents();
    this._loadCommands();
  },

  async _checkInstalled() {
    try {
      await this.invoke('check_claude');
      this.state.installed = true;
      document.getElementById('claude-toggle-btn').classList.remove('hidden');
    } catch (_) {
      this.state.installed = false;
      // Show toggle anyway so user can see the install instructions
      document.getElementById('claude-toggle-btn').classList.remove('hidden');
      this._showNotInstalledBanner();
    }
  },

  _showNotInstalledBanner() {
    const banner = document.createElement('div');
    banner.className = 'claude-not-installed';
    banner.innerHTML =
      '<div class="claude-not-installed-icon">⚠️</div>' +
      '<div class="claude-not-installed-title">Claude Code no está instalado</div>' +
      '<div class="claude-not-installed-text">Para usar Claude en POTATO necesitas instalar Claude Code CLI:</div>' +
      '<code class="claude-not-installed-cmd">curl -fsSL https://claude.ai/install.sh | sh</code>' +
      '<div class="claude-not-installed-text">Después de instalar, reinicia POTATO.</div>';
    this._messagesEl.appendChild(banner);

    // Disable input
    this._inputEl.disabled = true;
    this._inputEl.placeholder = 'Claude Code no instalado';
    document.getElementById('claude-send-btn').disabled = true;
  },

  toggle() {
    if (this.state.panelMode === 'minimized') {
      this.restoreFromMinimize();
      return;
    }
    if (this.state.panelMode === 'maximized') {
      this.restoreFromMaximize();
      return;
    }

    const panel = this._container;
    const isOpen = !panel.classList.contains('hidden');

    if (isOpen) {
      this._saveToHistory();
      panel.classList.add('hidden');
      document.body.classList.remove('claude-open');
      this.state.panelMode = 'closed';
    } else {
      panel.classList.remove('hidden');
      document.body.classList.add('claude-open');
      document.body.classList.remove('claude-minimized');
      this.state.panelMode = 'normal';
      this._inputEl.focus();
    }
  },

  isOpen() {
    return this.state.panelMode !== 'closed';
  },

  // -- Minimize / Maximize / History ----------------------------------------

  minimize() {
    this._toggleHistory(false);
    this._container.classList.add('hidden');
    document.body.classList.remove('claude-open', 'claude-maximized', 'has-compact-note');
    document.body.classList.add('claude-minimized');
    document.getElementById('claude-maximize-btn').classList.remove('active');
    this.state.panelMode = 'minimized';
  },

  restoreFromMinimize() {
    document.body.classList.remove('claude-minimized');
    this._container.classList.remove('hidden');
    document.body.classList.add('claude-open');
    this.state.panelMode = 'normal';
    this._inputEl.focus();
  },

  maximize() {
    this._toggleHistory(false);
    document.body.classList.remove('claude-minimized');
    this._container.classList.remove('hidden');
    document.body.classList.remove('claude-open');
    document.body.classList.add('claude-maximized');
    document.getElementById('claude-maximize-btn').classList.add('active');

    // Si hay una nota abierta, mostrar compact note
    if (App.state.currentNote) {
      document.body.classList.add('has-compact-note');
      // Asegurar que preview este visible
      Preview.update(Editor.getValue());
    }

    this.state.panelMode = 'maximized';
    this._inputEl.focus();
  },

  restoreFromMaximize() {
    document.body.classList.remove('claude-maximized', 'has-compact-note');
    document.body.classList.add('claude-open');
    document.getElementById('claude-maximize-btn').classList.remove('active');
    this.state.panelMode = 'normal';

    // Restaurar modo de vista de la nota
    if (App.state.currentNote) {
      App.setMode(App.state.mode);
    }
  },

  onNoteOpened() {
    if (this.state.panelMode === 'maximized') {
      document.body.classList.add('has-compact-note');
      Preview.update(Editor.getValue());
    }
  },

  onNoteClosed() {
    if (this.state.panelMode === 'maximized') {
      document.body.classList.remove('has-compact-note');
    }
  },

  // Directorio donde Claude CLI ejecuta (depende del modo)
  _getWorkingDir() {
    if (this.state.mode === 'project') {
      return this.state.projectDir || this.state.workingDir || App.state.vaultPath;
    }
    // Vault mode: usar directorio de agentes si existe (para que CLI encuentre .claude/agents/)
    // Si no, usar el vault path
    return this._getAgentsDir() || App.state.vaultPath;
  },

  // Directorio para cargar agentes (independiente del modo)
  _getAgentsDir() {
    return this.state.projectDir || this.state.workingDir || App.state.vaultPath;
  },

  // Construye el system prompt del vault dinámicamente con los agentes disponibles
  _buildVaultSystemPrompt() {
    if (this.state.agentsOnly) {
      return this._buildAgentsOnlyPrompt();
    }
    return this._buildHybridPrompt();
  },

  _buildAgentsOnlyPrompt() {
    const parts = [
      'Eres un ROUTER PURO. Tu UNICA funcion es delegar tareas a agentes especializados.',
      'NUNCA resuelvas nada directamente. SIEMPRE delega con Task (subagent_type="general-purpose").',
    ];

    if (this.state.agents.length > 0) {
      parts.push('');
      parts.push('AGENTES DISPONIBLES:');
      for (const agent of this.state.agents) {
        parts.push(`- @${agent.name}: ${agent.description}`);
      }
    }

    parts.push('');
    parts.push('REGLAS ABSOLUTAS:');
    parts.push('1. TODA tarea debe delegarse a un agente con Task. Sin excepciones.');
    parts.push('2. Si el usuario menciona @nombre → usa ese agente.');
    parts.push('3. Si no menciona agente → elige el mas adecuado de la lista.');
    parts.push('4. NUNCA uses Glob, Grep, Read, WebSearch, WebFetch directamente. Delega.');
    if (this.state.mcpSelected.length > 0) {
      parts.push('5. NUNCA uses Bash, Write, Edit. Las herramientas MCP SI estan permitidas (' + this.state.mcpSelected.join(', ') + ').');
    } else {
      parts.push('5. NUNCA uses Bash, Write, Edit, MCP.');
    }
    parts.push('');
    parts.push('CONTEXTO OBLIGATORIO AL DELEGAR:');
    parts.push('Cuando uses Task, SIEMPRE incluye en el prompt del agente TODO este contexto:');
    parts.push('- Ruta completa del vault');
    parts.push('- Titulo y ruta de la nota abierta (si hay)');
    parts.push('- Contenido relevante de la nota abierta (si aplica a la tarea)');
    parts.push('- La peticion completa del usuario');
    parts.push('- Cualquier contexto adicional de la conversacion que sea relevante');
    parts.push('El agente NO tiene acceso a nuestra conversacion, asi que debes darle TODO lo que necesite.');
    parts.push('');
    parts.push('Responde en español. Se conciso.');

    if (this._userContext) {
      parts.push('');
      parts.push('IDENTIDAD DEL USUARIO (usa SOLO esta info, ignora nombres del sistema operativo o rutas de archivos):');
      parts.push(this._userContext);
    }

    return parts.join('\n');
  },

  _buildHybridPrompt() {
    const parts = [
      'Eres un asistente inteligente trabajando dentro de un vault de notas markdown.',
      'Tu rol es analizar lo que el usuario necesita y decidir si delegarlo a un agente especializado o resolverlo directamente.',
    ];

    if (this.state.agents.length > 0) {
      parts.push('');
      parts.push('AGENTES ESPECIALIZADOS DISPONIBLES (invocalos con Task, subagent_type="general-purpose"):');
      for (const agent of this.state.agents) {
        parts.push(`- @${agent.name}: ${agent.description}`);
      }
      parts.push('');
      parts.push('CUANDO DELEGAR A UN AGENTE:');
      parts.push('- Si el usuario menciona un agente con @nombre → OBLIGATORIO delegarle con Task.');
      parts.push('- Si la tarea requiere analisis profundo, investigacion extensa o especializacion → delega al agente mas adecuado.');
      parts.push('- Si la tarea involucra buscar documentacion, codigo o knowledge → delega al agente apropiado.');
      parts.push('');
      parts.push('CONTEXTO OBLIGATORIO AL DELEGAR:');
      parts.push('Cuando uses Task para delegar, SIEMPRE incluye en el prompt del agente TODO este contexto:');
      parts.push('- Ruta completa del vault');
      parts.push('- Titulo y ruta de la nota abierta (si hay)');
      parts.push('- Contenido relevante de la nota abierta (si aplica a la tarea)');
      parts.push('- La peticion completa del usuario');
      parts.push('- Cualquier contexto adicional de la conversacion que sea relevante');
      parts.push('El agente NO tiene acceso a nuestra conversacion, asi que debes darle TODO lo que necesite para completar la tarea.');
      parts.push('');
      parts.push('CUANDO RESOLVER DIRECTAMENTE (sin agente):');
      parts.push('- Tareas simples y rapidas: buscar un archivo especifico, leer una nota concreta, preguntas directas.');
      parts.push('- Cuando ningun agente aplica a la tarea.');
    }

    parts.push('');
    parts.push('HERRAMIENTAS DIRECTAS:');
    parts.push('- Glob, Grep, Read: buscar y leer archivos en el vault.');
    parts.push('- WebSearch, WebFetch: investigar en internet.');
    parts.push('- Task: delegar a agentes especializados.');

    // MCP servers habilitados
    const mcpNames = this.state.mcpSelected;
    if (mcpNames.length > 0) {
      parts.push('- MCP Tools: herramientas de servidores externos (' + mcpNames.join(', ') + '). Usalas cuando el usuario pida datos de esos servicios.');
    }

    parts.push('');
    parts.push('REGLAS:');
    if (mcpNames.length > 0) {
      parts.push('1. NUNCA uses Bash, Write, Edit ni herramientas no listadas. Las herramientas MCP SI estan permitidas.');
    } else {
      parts.push('1. NUNCA uses Bash, Write, Edit, MCP ni herramientas no listadas.');
    }
    parts.push('2. SIEMPRE que menciones un archivo, incluye su RUTA ABSOLUTA COMPLETA.');
    parts.push('3. Responde en español. Se conciso y util.');

    if (this._userContext) {
      parts.push('');
      parts.push('IDENTIDAD DEL USUARIO (usa SOLO esta info, ignora nombres del sistema operativo o rutas de archivos):');
      parts.push(this._userContext);
    }

    return parts.join('\n');
  },

  async _pickWorkingDir() {
    const path = await this.invoke('open_vault');
    if (!path) return;
    this.state.workingDir = path;
    localStorage.setItem('potato-claude-workdir', path);
    this._updateWorkdirDisplay();
    this.newChat();
    this._loadAgents();
    this._loadCommands();
  },

  _updateWorkdirDisplay() {
    const input = document.getElementById('setting-claude-workdir-input');
    if (!input) return;
    input.value = this.state.workingDir || '';
    input.placeholder = 'Usando vault';
  },

  _setWorkingDirFromInput() {
    const input = document.getElementById('setting-claude-workdir-input');
    const path = (input.value || '').trim();
    if (path === (this.state.workingDir || '')) return;
    this.state.workingDir = path || null;
    if (path) {
      localStorage.setItem('potato-claude-workdir', path);
    } else {
      localStorage.removeItem('potato-claude-workdir');
    }
    this.newChat();
    this._loadAgents();
    this._loadCommands();
  },

  async _pickProjectDir() {
    const path = await this.invoke('open_vault');
    if (!path) return;
    this.state.projectDir = path;
    localStorage.setItem('potato-claude-projectdir', path);
    this._updateProjectDirDisplay();
    this.newChat();
    this._loadAgents();
    this._loadCommands();
  },

  _updateProjectDirDisplay() {
    const input = document.getElementById('setting-claude-projectdir-input');
    if (!input) return;
    input.value = this.state.projectDir || '';
    input.placeholder = 'No configurado';
  },

  _setProjectDirFromInput() {
    const input = document.getElementById('setting-claude-projectdir-input');
    const path = (input.value || '').trim();
    if (path === (this.state.projectDir || '')) return;
    this.state.projectDir = path || null;
    if (path) {
      localStorage.setItem('potato-claude-projectdir', path);
    } else {
      localStorage.removeItem('potato-claude-projectdir');
    }
    this.newChat();
    this._loadAgents();
    this._loadCommands();
  },

  onVaultChanged() {
    // Recargar agentes si no hay workdir/projectdir custom (usa vault)
    if (!this.state.workingDir && !this.state.projectDir) {
      this._loadAgents();
    this._loadCommands();
    }
  },

  updateContext() {
    const name = document.getElementById('claude-context-name');
    const modeSelect = document.getElementById('claude-mode-select');

    // Habilitar/deshabilitar opción proyecto según si hay projectDir o workingDir
    const hasProjectPath = this.state.projectDir || this.state.workingDir;
    const projectOpt = modeSelect.querySelector('option[value="project"]');
    if (projectOpt) {
      projectOpt.disabled = !hasProjectPath;
    }

    if (this.state.mode === 'project' && hasProjectPath) {
      const projPath = this.state.projectDir || this.state.workingDir;
      name.textContent = projPath.split('/').pop();
    } else if (App.state.currentNote) {
      name.textContent = App.state.currentNote.title;
    } else if (App.state.vaultPath) {
      const vaultName = App.state.vaultPath.split('/').pop();
      name.textContent = vaultName;
    } else {
      name.textContent = '';
    }
  },

  // -- Chat ------------------------------------------------------------------

  async sendMessage() {
    if (this.state.isStreaming) return;
    if (!this.state.installed) return;

    let text = this._inputEl.value.trim();
    if (!text) return;

    this._inputEl.value = '';
    this._autoResize();

    // Resolver /command → inyectar contenido del archivo .md
    let displayText = text;  // Lo que se muestra en el chat
    const cmdMatch = text.match(/^\/(\S+)([\s\S]*)$/);
    if (cmdMatch) {
      const cmdName = cmdMatch[1];
      const cmdArgs = cmdMatch[2].trim();
      const cmd = this.state.commands.find(c => c.name === cmdName);
      if (cmd) {
        try {
          const dir = this.state._resolvedCommandsDir || this._getCommandsDir();
          const content = await this.invoke('read_claude_command', { path: dir, command: cmdName });
          displayText = '/' + cmdName + (cmdArgs ? ' ' + cmdArgs : '');
          text = content + (cmdArgs ? '\n\n' + cmdArgs : '');
        } catch (err) {
          this._showError('No se pudo leer el comando: ' + err);
          return;
        }
      }
    }

    if (!this.state.sessionId) {
      this.state.sessionId = 'claude-' + Date.now();
    }

    // Construir mensaje con contexto según el modo
    let contextParts = [];

    const projectPath = this.state.projectDir || this.state.workingDir;
    if (this.state.mode === 'project' && projectPath) {
      // Modo proyecto: Claude trabaja con el código fuente
      contextParts.push(`[MODO PROYECTO — Directorio: ${projectPath}]`);
      contextParts.push(`[Tu directorio de trabajo es ${projectPath}. Puedes revisar codigo fuente, modulos y crear documentacion aqui. Usa Glob, Grep, Read, Bash y cualquier herramienta necesaria.]`);

      if (App.state.currentNote) {
        const noteContent = Editor.getValue();
        const noteTitle = App.state.currentNote.title;
        contextParts.push(`[Nota de referencia: "${noteTitle}"]\n\`\`\`markdown\n${noteContent}\n\`\`\``);
      }
    } else {
      // Modo vault: contexto mínimo, las instrucciones van en el system prompt
      if (App.state.vaultPath) {
        contextParts.push(`[Vault: ${App.state.vaultPath}]`);
      }

      if (App.state.currentNote) {
        const noteContent = Editor.getValue();
        const noteTitle = App.state.currentNote.title;
        const notePath = App.state.currentNote.path;
        contextParts.push(`[Nota abierta: "${noteTitle}" (${notePath})]\n\`\`\`markdown\n${noteContent}\n\`\`\``);
      }
    }

    const finalMessage = contextParts.length > 0
      ? contextParts.join('\n') + '\n\n' + text
      : text;

    if (!this._silent) {
      this.state.messages.push({ role: 'user', content: displayText });
      this._addUserMessage(displayText);
      this._vaultRetryCount = 0;
    }
    this._silent = false;

    this.state.isStreaming = true;
    this._setStreamingUI(true);
    this._showThinking();

    const channel = new window.__TAURI__.core.Channel();
    let streamStarted = false;

    channel.onmessage = (chunk) => {
      if (chunk.session_id) {
        this.state.claudeSessionId = chunk.session_id;
      }

      // Tool activity
      if (chunk.tool) {
        this._hideThinking();
        if (streamStarted && this._currentStreamEl) {
          this._finalizeStream();
          streamStarted = false;
        }

        if (chunk.tool.phase === 'ask') {
          this.state.isStreaming = false;
          this._setStreamingUI(false);
          this._showAskUser(chunk.tool);
          return;
        }

        if (chunk.tool.phase === 'approval') {
          if (this.state.mode === 'vault') {
            const vaultAuto = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'];
            const vaultReview = ['Write', 'Edit'];
            const isMcpTool = chunk.tool.tool_name.startsWith('mcp__');

            if (vaultReview.includes(chunk.tool.tool_name)) {
              // Write/Edit en vault: verificar que la ruta esté dentro del vault
              const filePath = chunk.tool.input?.file_path || '';
              if (App.state.vaultPath && !filePath.startsWith(App.state.vaultPath)) {
                // Fuera del vault → rechazar
                this._showAutoRejected(chunk.tool);
                this._vaultRetry(chunk.tool.tool_name);
                return;
              }
              // Dentro del vault → mostrar preview para aprobación individual
              this.state.isStreaming = false;
              this._setStreamingUI(false);
              this._showToolApproval(chunk.tool);
              return;
            }

            if (isMcpTool) {
              // MCP tools → mostrar aprobación individual (servicios externos, pueden ser destructivos)
              this.state.isStreaming = false;
              this._setStreamingUI(false);
              this._showToolApproval(chunk.tool);
              return;
            }

            if (!vaultAuto.includes(chunk.tool.tool_name)) {
              // Tool no permitido en vault → auto-rechazar
              this._showAutoRejected(chunk.tool);
              this._vaultRetry(chunk.tool.tool_name);
              return;
            }
          }
          this.state.isStreaming = false;
          this._setStreamingUI(false);
          this._showToolApproval(chunk.tool);
          return;
        }

        if (chunk.tool.phase === 'start') {
          // Rastrear file_path de Write para abrir la nota al completar
          if (chunk.tool.tool_name === 'Write' && chunk.tool.input?.file_path) {
            this._pendingWritePaths = this._pendingWritePaths || {};
            this._pendingWritePaths[chunk.tool.tool_id] = chunk.tool.input.file_path;
          }
          if (chunk.tool.tool_name === 'Task') {
            this._showAgentStart(chunk.tool);
          } else {
            this._showToolStart(chunk.tool);
          }
        } else if (chunk.tool.phase === 'result') {
          // Check if this tool_id belongs to a tracked agent
          const isAgent = this.state.graphNodes.some(n => n.id === chunk.tool.tool_id);
          if (isAgent) {
            // Debounce: reset the timer each time we get activity for this agent.
            // When no events arrive for 5s, we consider the agent done.
            this._resetAgentTimer(chunk.tool);
          } else {
            this._showToolResult(chunk.tool);
          }
          // Refrescar vault y abrir nota cuando Write/Edit modifica archivos dentro del vault
          const writePath = this._pendingWritePaths?.[chunk.tool.tool_id];
          if (writePath || (['Write', 'Edit'].includes(chunk.tool.tool_name) && !chunk.tool.is_error)) {
            App.refreshVault().then(() => {
              if (writePath && writePath.endsWith('.md') && App.state.vaultPath && writePath.startsWith(App.state.vaultPath)) {
                const title = writePath.split('/').pop().replace(/\.md$/, '');
                App.openNote(writePath, title);
              }
            });
            if (writePath) delete this._pendingWritePaths[chunk.tool.tool_id];
          }
        }
        return;
      }

      if (chunk.done) {
        const fullResponse = this._streamBuffer || '';
        if (fullResponse) {
          this.state.messages.push({ role: 'assistant', content: fullResponse });
        }
        this._finalizeStream();
        this.state.isStreaming = false;
        this._setStreamingUI(false);
        this._saveToHistory();

        // Clear all debounce timers and mark remaining working agents as done
        this._clearAllAgentTimers();
        let agentChanged = false;
        for (const node of this.state.graphNodes) {
          if (node.status === 'working') {
            node.status = 'done';
            agentChanged = true;
            this._markAgentDoneInChat(node.id, false);
          }
        }
        if (agentChanged && this.state.graphView) this._renderGraph();

        return;
      }

      if (!streamStarted) {
        this._hideThinking();
        this._startAssistantMessage();
        streamStarted = true;
      }
      this._appendToStream(chunk.content);
    };

    // En modo vault: búsqueda + research. En proyecto: todas las herramientas
    const baseTools = this.state.mode === 'vault'
      ? ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task']
      : this.state.allowedTools;
    const allowedTools = [...new Set([...baseTools, ...this.state.sessionApprovedTools])];

    // System prompt dinámico según el modo
    let systemPrompt = null;
    if (this.state.mode === 'vault') {
      systemPrompt = this._buildVaultSystemPrompt();
    }

    // MCP config
    const mcpConfigJson = this._getMcpConfigJson();

    try {
      await this.invoke('send_claude_message', {
        message: finalMessage,
        processId: this.state.sessionId,
        sessionId: this.state.claudeSessionId,
        model: this.state.model,
        workingDir: this._getWorkingDir(),
        allowedTools,
        systemPrompt,
        mcpConfigJson,
        onEvent: channel,
      });
    } catch (err) {
      this._hideThinking();
      if (this._currentStreamEl) {
        this._finalizeStream();
      }
      this._showError('Error: ' + err);
      this.state.isStreaming = false;
      this._setStreamingUI(false);
    }
  },

  async stopGeneration() {
    try {
      await this.invoke('stop_claude', { processId: this.state.sessionId || '' });
    } catch (_) {}

    this._hideThinking();
    if (this._currentStreamEl) {
      this._finalizeStream();
    }
    this.state.isStreaming = false;
    this._setStreamingUI(false);

    // Clear all debounce timers and mark working agents as stopped
    this._clearAllAgentTimers();
    let changed = false;
    for (const node of this.state.graphNodes) {
      if (node.status === 'working') {
        node.status = 'stopped';
        changed = true;
      }
    }
    if (changed && this.state.graphView) this._renderGraph();
  },

  newChat() {
    if (this.state.isStreaming) {
      this.stopGeneration();
    }
    this._saveToHistory();
    this._toggleHistory(false);
    this.state.sessionId = null;
    this.state.claudeSessionId = null;
    this.state.messages = [];
    this.state.sessionApprovedTools = [];
    this._messagesEl.innerHTML = '';
    this._clearAllAgentTimers();
    this.state.graphNodes = [];
    if (this.state.graphView) this._renderGraph();
    this._inputEl.value = '';
    this._autoResize();
    this._inputEl.focus();
  },

  // -- Streaming & rendering -------------------------------------------------

  _addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'claude-msg claude-msg-user';
    el.innerHTML = `<div class="claude-msg-role">Tu</div><div class="claude-msg-body">${this._escapeHtml(text)}</div>`;
    this._messagesEl.appendChild(el);
    this._scrollToBottom();
  },

  _renderTimeout: null,

  _startAssistantMessage() {
    this._streamBuffer = '';
    const el = document.createElement('div');
    el.className = 'claude-msg claude-msg-assistant';
    el.innerHTML = '<div class="claude-msg-role">Claude</div><div class="claude-msg-body"><span class="claude-cursor"></span></div>';
    this._messagesEl.appendChild(el);
    this._currentStreamEl = el;
    this._scrollToBottom();
  },

  _appendToStream(text) {
    if (!this._currentStreamEl) return;
    this._streamBuffer += text;

    // Renderizar markdown con throttle para no saturar
    if (!this._renderTimeout) {
      this._renderTimeout = setTimeout(() => {
        this._renderTimeout = null;
        this._renderStream();
      }, 80);
    }
  },

  _renderStream() {
    if (!this._currentStreamEl) return;
    const body = this._currentStreamEl.querySelector('.claude-msg-body');
    const content = this._streamBuffer;

    if (content) {
      const html = marked.parse(content, { breaks: true });
      body.innerHTML = html + '<span class="claude-cursor"></span>';
      body.querySelectorAll('pre code').forEach(block => {
        if (!block.dataset.highlighted) {
          hljs.highlightElement(block);
          block.dataset.highlighted = '1';
        }
      });
    }
    this._scrollToBottom();
  },

  _finalizeStream() {
    if (!this._currentStreamEl) return;

    // Cancelar render pendiente
    if (this._renderTimeout) {
      clearTimeout(this._renderTimeout);
      this._renderTimeout = null;
    }

    const body = this._currentStreamEl.querySelector('.claude-msg-body');
    const content = this._streamBuffer;

    if (content) {
      const html = marked.parse(content, { breaks: true });
      body.innerHTML = html;
      body.querySelectorAll('pre code').forEach(block => {
        hljs.highlightElement(block);
      });
      this._linkifyVaultPaths(body);
    } else {
      body.innerHTML = '';
    }

    this._currentStreamEl = null;
    this._streamBuffer = '';
    this._scrollToBottom();
  },

  _showAutoRejected(tool) {
    const el = document.createElement('div');
    el.className = 'claude-tool-rejected';
    el.innerHTML = `<span class="claude-tool-rejected-icon">&#10005;</span> <strong>${this._escapeHtml(tool.tool_name)}</strong> bloqueado — reintentando con busqueda en vault`;
    this._messagesEl.appendChild(el);
    this._scrollToBottom();
  },

  _vaultRetryCount: 0,

  _vaultRetry(rejectedTool) {
    const lastUserMsg = [...this.state.messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;

    // Limitar reintentos para evitar loops infinitos
    this._vaultRetryCount++;
    if (this._vaultRetryCount > 2) {
      this._vaultRetryCount = 0;
      this.state.isStreaming = false;
      this._setStreamingUI(false);
      this._showError('No se pudo completar la solicitud. Claude intenta usar herramientas no disponibles en modo vault.');
      return;
    }

    // Resetear estado de streaming y sesion
    this.state.isStreaming = false;
    this._setStreamingUI(false);
    this.state.sessionId = null;
    this.state.claudeSessionId = null;
    // Preservar herramientas MCP aprobadas por el usuario
    this.state.sessionApprovedTools = this.state.sessionApprovedTools.filter(t => t.startsWith('mcp__'));

    // Reenviar con contexto de la herramienta rechazada
    const mcpNote = this.state.mcpSelected.length > 0
      ? ' Las herramientas MCP SI estan permitidas.'
      : '';
    const toolNote = rejectedTool
      ? `\n\n[SISTEMA: ${rejectedTool} NO esta disponible. Solo puedes usar: Glob, Grep, Read, WebSearch, WebFetch, Task.${mcpNote} Responde con las herramientas disponibles o con tu conocimiento.]`
      : '';
    this._silent = true;
    this._inputEl.value = lastUserMsg.content + toolNote;
    this.sendMessage();
  },

  _showThinking() {
    const el = document.createElement('div');
    el.className = 'claude-thinking';
    el.id = 'claude-thinking';
    el.innerHTML = '<div class="claude-thinking-dots"><span></span><span></span><span></span></div><span>Pensando...</span>';
    this._messagesEl.appendChild(el);
    this._scrollToBottom();
  },

  _hideThinking() {
    const el = document.getElementById('claude-thinking');
    if (el) el.remove();
  },

  _showError(msg) {
    const el = document.createElement('div');
    el.className = 'claude-error';
    el.textContent = msg;
    this._messagesEl.appendChild(el);
    this._scrollToBottom();
  },

  // -- Agent panel -----------------------------------------------------------

  _showAgentStart(tool) {
    const inp = tool.input || {};
    const agentType = inp.subagent_type || inp.description || 'Agent';
    const desc = inp.description || inp.prompt || '';

    const el = document.createElement('div');
    el.className = 'claude-agent';
    el.id = 'claude-agent-' + tool.tool_id;

    el.innerHTML = `
      <div class="claude-agent-header">
        <span class="claude-agent-pulse"></span>
        <span class="claude-agent-name">${this._escapeHtml(agentType)}</span>
        <span class="claude-agent-status">trabajando</span>
      </div>
      <div class="claude-agent-desc">${this._escapeHtml(desc.slice(0, 120))}</div>
    `;
    this._messagesEl.appendChild(el);
    this._scrollToBottom();

    // Track node for graph view
    const bubbleText = (inp.description || inp.prompt || '').slice(0, 80);

    this.state.graphNodes.push({
      id: tool.tool_id,
      name: agentType,
      desc: bubbleText,
      status: 'working',
    });
    if (this.state.graphView) this._renderGraph();
  },

  _showAgentResult(tool) {
    const el = document.getElementById('claude-agent-' + tool.tool_id);
    if (!el) return;

    // Cambiar estado a completado
    el.classList.add('done');
    const pulse = el.querySelector('.claude-agent-pulse');
    if (pulse) pulse.classList.add('done');
    const status = el.querySelector('.claude-agent-status');
    if (status) status.textContent = tool.is_error ? 'error' : 'listo';

    // Update graph node status
    const node = this.state.graphNodes.find(n => n.id === tool.tool_id);
    if (node) {
      node.status = tool.is_error ? 'error' : 'done';
    }
    if (this.state.graphView) this._renderGraph();

    // Mostrar resultado truncado si hay
    if (tool.result && tool.result.trim()) {
      const lines = tool.result.split('\n');
      const preview = lines.slice(0, 4).join('\n');
      const suffix = lines.length > 4 ? '\n...' : '';

      const resultEl = document.createElement('div');
      resultEl.className = 'claude-agent-result';
      resultEl.innerHTML = `<pre>${this._escapeHtml(preview + suffix)}</pre>`;

      if (lines.length > 4) {
        const toggle = document.createElement('button');
        toggle.className = 'claude-tool-expand';
        toggle.textContent = `Ver todo (${lines.length} lineas)`;
        toggle.addEventListener('click', () => {
          const pre = resultEl.querySelector('pre');
          if (toggle.dataset.expanded === '1') {
            pre.textContent = preview + suffix;
            toggle.textContent = `Ver todo (${lines.length} lineas)`;
            toggle.dataset.expanded = '0';
          } else {
            pre.textContent = tool.result;
            toggle.textContent = 'Colapsar';
            toggle.dataset.expanded = '1';
          }
        });
        resultEl.appendChild(toggle);
      }
      el.appendChild(resultEl);
    }
    this._scrollToBottom();
  },

  // -- Tool handling ---------------------------------------------------------

  _showToolStart(tool) {
    const el = document.createElement('div');
    el.className = 'claude-tool';
    el.id = 'claude-tool-' + tool.tool_id;

    const icon = this._toolIcon(tool.tool_name);
    const label = this._toolLabel(tool.tool_name, tool.input);

    el.innerHTML = `
      <div class="claude-tool-header">
        <span class="claude-tool-icon">${icon}</span>
        <span class="claude-tool-name">${this._escapeHtml(tool.tool_name)}</span>
        <span class="claude-tool-label">${this._escapeHtml(label)}</span>
        <span class="claude-tool-spinner"></span>
      </div>
    `;
    this._messagesEl.appendChild(el);
    this._scrollToBottom();
  },

  _showToolResult(tool) {
    const el = document.getElementById('claude-tool-' + tool.tool_id);
    if (!el) return;

    const spinner = el.querySelector('.claude-tool-spinner');
    if (spinner) spinner.remove();

    const header = el.querySelector('.claude-tool-header');
    const status = document.createElement('span');
    status.className = tool.is_error ? 'claude-tool-status error' : 'claude-tool-status success';
    status.textContent = tool.is_error ? 'Error' : 'OK';
    header.appendChild(status);

    if (tool.result && tool.result.trim()) {
      const lines = tool.result.split('\n');
      const truncated = lines.length > 6;
      const display = truncated ? lines.slice(0, 6).join('\n') + '\n...' : tool.result;

      const resultEl = document.createElement('div');
      resultEl.className = 'claude-tool-result';
      resultEl.innerHTML = `<pre>${this._escapeHtml(display)}</pre>`;
      this._linkifyVaultPaths(resultEl);

      if (truncated) {
        const toggle = document.createElement('button');
        toggle.className = 'claude-tool-expand';
        toggle.textContent = `Ver todo (${lines.length} lineas)`;
        toggle.addEventListener('click', () => {
          const pre = resultEl.querySelector('pre');
          if (toggle.dataset.expanded === '1') {
            pre.textContent = display;
            toggle.textContent = `Ver todo (${lines.length} lineas)`;
            toggle.dataset.expanded = '0';
          } else {
            pre.textContent = tool.result;
            toggle.textContent = 'Colapsar';
            toggle.dataset.expanded = '1';
          }
        });
        resultEl.appendChild(toggle);
      }
      el.appendChild(resultEl);
    }
    this._scrollToBottom();
  },

  _showToolApproval(tool) {
    const el = document.createElement('div');
    el.className = 'claude-approval';
    el.id = 'claude-approval-' + tool.tool_id;

    const icon = this._toolIcon(tool.tool_name);
    const inp = tool.input || {};

    let summaryHtml = '';
    switch (tool.tool_name) {
      case 'Write': {
        const fp = inp.file_path || 'archivo';
        const content = inp.content || '';
        const lines = content.split('\n');
        const preview = lines.slice(0, 10).join('\n');
        const suffix = lines.length > 10 ? `\n... (${lines.length} lineas)` : '';
        summaryHtml = `<div class="claude-approval-path">${this._escapeHtml(fp)}</div><pre class="claude-approval-code">${this._escapeHtml(preview + suffix)}</pre>`;
        break;
      }
      case 'Edit': {
        const fp = inp.file_path || 'archivo';
        summaryHtml = `<div class="claude-approval-path">${this._escapeHtml(fp)}</div>`;
        if (inp.old_string) summaryHtml += `<div class="claude-approval-diff-label">Eliminar:</div><pre class="claude-diff-del">${this._escapeHtml(inp.old_string)}</pre>`;
        if (inp.new_string) summaryHtml += `<div class="claude-approval-diff-label">Agregar:</div><pre class="claude-diff-add">${this._escapeHtml(inp.new_string)}</pre>`;
        break;
      }
      case 'Bash': {
        const cmd = inp.command || '';
        const desc = inp.description || '';
        summaryHtml = desc ? `<div class="claude-approval-desc">${this._escapeHtml(desc)}</div>` : '';
        summaryHtml += `<pre class="claude-approval-cmd">${this._escapeHtml(cmd)}</pre>`;
        break;
      }
      default: {
        if (tool.tool_name.startsWith('mcp__')) {
          // MCP tools: mostrar servidor, operación y parámetros
          const parts = tool.tool_name.split('__');
          const serverName = parts[1] || 'desconocido';
          const toolAction = parts.slice(2).join('__') || 'operacion';
          summaryHtml = `<div class="claude-approval-desc">Servidor: <strong>${this._escapeHtml(serverName)}</strong></div>`;
          summaryHtml += `<div class="claude-approval-desc">Operacion: <strong>${this._escapeHtml(toolAction)}</strong></div>`;
          const paramStr = JSON.stringify(inp, null, 2);
          if (paramStr && paramStr !== '{}') {
            const lines = paramStr.split('\n');
            const preview = lines.slice(0, 15).join('\n');
            const suffix = lines.length > 15 ? '\n...' : '';
            summaryHtml += `<pre class="claude-approval-cmd">${this._escapeHtml(preview + suffix)}</pre>`;
          }
        } else {
          const label = this._toolLabel(tool.tool_name, inp);
          if (label) summaryHtml = `<div class="claude-approval-desc">${this._escapeHtml(label)}</div>`;
        }
      }
    }

    el.innerHTML = `
      <div class="claude-approval-header">
        <span class="claude-tool-icon">${icon}</span>
        <span>Claude quiere usar <strong>${this._escapeHtml(tool.tool_name)}</strong></span>
      </div>
      <div class="claude-approval-body">${summaryHtml}</div>
      <div class="claude-approval-actions">
        <button class="claude-approve-btn">Aprobar</button>
        <button class="claude-deny-btn">Rechazar</button>
      </div>
    `;

    el.querySelector('.claude-approve-btn').addEventListener('click', () => {
      const actions = el.querySelector('.claude-approval-actions');
      actions.innerHTML = '<span class="claude-approval-decided approved">Aprobado</span>';
      // En vault mode, Write/Edit nunca se auto-aprueban (cada uno requiere revisión)
      const vaultWriteTools = ['Write', 'Edit'];
      if (this.state.mode !== 'vault' || !vaultWriteTools.includes(tool.tool_name)) {
        this.state.sessionApprovedTools.push(tool.tool_name);
      }
      this._resumeAfterApproval(tool);
    });

    el.querySelector('.claude-deny-btn').addEventListener('click', () => {
      const actions = el.querySelector('.claude-approval-actions');
      actions.innerHTML = '<span class="claude-approval-decided denied">Rechazado</span>';
      this._resumeAfterDenial(tool);
    });

    this._messagesEl.appendChild(el);
    this._scrollToBottom();
  },

  _showAskUser(tool) {
    const questions = tool.input?.questions;
    if (!questions || !questions.length) return;

    const el = document.createElement('div');
    el.className = 'claude-ask';
    el.id = 'claude-ask-' + tool.tool_id;

    const answers = {};
    const totalQuestions = questions.length;
    let sendBtn = null;

    const checkAllAnswered = () => {
      const answered = Object.keys(answers).length;
      if (sendBtn) {
        sendBtn.disabled = answered < totalQuestions;
        sendBtn.textContent = answered < totalQuestions
          ? `Responder (${answered}/${totalQuestions})`
          : 'Enviar respuestas';
      }
    };

    questions.forEach((q, idx) => {
      const qEl = document.createElement('div');
      qEl.className = 'claude-ask-question';

      const header = document.createElement('div');
      header.className = 'claude-ask-header';
      if (q.header) {
        const tag = document.createElement('span');
        tag.className = 'claude-ask-tag';
        tag.textContent = q.header;
        header.appendChild(tag);
      }
      const qText = document.createElement('span');
      qText.className = 'claude-ask-text';
      qText.textContent = q.question;
      header.appendChild(qText);
      qEl.appendChild(header);

      const optionsEl = document.createElement('div');
      optionsEl.className = 'claude-ask-options';

      const customInput = document.createElement('input');
      customInput.type = 'text';
      customInput.className = 'claude-ask-custom';
      customInput.placeholder = 'Respuesta personalizada...';

      if (q.options) {
        for (const opt of q.options) {
          const btn = document.createElement('button');
          btn.className = 'claude-ask-opt-btn';
          btn.innerHTML = `<span class="claude-ask-opt-label">${this._escapeHtml(opt.label)}</span>` +
            (opt.description ? `<span class="claude-ask-opt-desc">${this._escapeHtml(opt.description)}</span>` : '');
          btn.addEventListener('click', () => {
            if (btn.classList.contains('selected')) {
              btn.classList.remove('selected');
              delete answers[idx];
            } else {
              optionsEl.querySelectorAll('.claude-ask-opt-btn').forEach(b => b.classList.remove('selected'));
              btn.classList.add('selected');
              answers[idx] = { question: q.question, answer: opt.label };
              customInput.value = '';
            }
            checkAllAnswered();
          });
          optionsEl.appendChild(btn);
        }
      }

      customInput.addEventListener('input', () => {
        const val = customInput.value.trim();
        if (val) {
          optionsEl.querySelectorAll('.claude-ask-opt-btn').forEach(b => b.classList.remove('selected'));
          answers[idx] = { question: q.question, answer: val };
        } else {
          const selected = optionsEl.querySelector('.claude-ask-opt-btn.selected');
          if (!selected) delete answers[idx];
        }
        checkAllAnswered();
      });

      qEl.appendChild(optionsEl);
      const customRow = document.createElement('div');
      customRow.className = 'claude-ask-custom-row';
      customRow.appendChild(customInput);
      qEl.appendChild(customRow);
      el.appendChild(qEl);
    });

    const sendRow = document.createElement('div');
    sendRow.className = 'claude-ask-send-row';
    sendBtn = document.createElement('button');
    sendBtn.className = 'claude-ask-send-btn';
    sendBtn.textContent = `Responder (0/${totalQuestions})`;
    sendBtn.disabled = true;
    sendBtn.addEventListener('click', () => {
      el.querySelectorAll('button').forEach(b => b.disabled = true);
      el.querySelectorAll('input').forEach(i => i.disabled = true);
      sendBtn.textContent = 'Enviado';
      sendBtn.classList.add('sent');
      this._answerQuestion(answers);
    });
    sendRow.appendChild(sendBtn);
    el.appendChild(sendRow);

    checkAllAnswered();
    this._messagesEl.appendChild(el);
    this._scrollToBottom();
  },

  _resumeAfterApproval(tool) {
    const inp = tool.input || {};
    let details = '';

    const isMcpTool = tool.tool_name.startsWith('mcp__');

    switch (tool.tool_name) {
      case 'Write':
        details = `Crea el archivo "${inp.file_path}" con exactamente el mismo contenido que ibas a escribir. Hazlo ahora.`;
        break;
      case 'Edit':
        details = `Edita el archivo "${inp.file_path}". ` +
          (inp.old_string ? `Reemplaza:\n${inp.old_string}\nPor:\n${inp.new_string}` : 'Aplica el cambio que ibas a hacer.');
        break;
      case 'Bash':
        details = `Ejecuta este comando:\n${inp.command}`;
        break;
      default:
        details = `Usa ${tool.tool_name} con los parametros que tenias planeados.`;
        if (Object.keys(inp).length > 0) {
          details += '\nParametros: ' + JSON.stringify(inp).slice(0, 500);
        }
    }

    // Agregar herramienta a sessionApprovedTools para que no pida permiso otra vez
    if (!this.state.sessionApprovedTools.includes(tool.tool_name)) {
      this.state.sessionApprovedTools.push(tool.tool_name);
    }

    if (isMcpTool) {
      // MCP tools: sesion fresca (--resume rompe las conexiones MCP)
      const lastUserMsg = [...this.state.messages].reverse().find(m => m.role === 'user');
      const originalRequest = lastUserMsg ? lastUserMsg.content : '';
      this.state.sessionId = null;
      this.state.claudeSessionId = null;
      this._silent = true;
      this._inputEl.value = `${originalRequest}\n\n[El usuario aprobo usar ${tool.tool_name}. ${details}]`;
    } else {
      this._inputEl.value = `APROBADO. ${details}`;
    }
    this.sendMessage();
  },

  _resumeAfterDenial(tool) {
    if (this.state.mode === 'vault' && ['Write', 'Edit'].includes(tool.tool_name)) {
      this._inputEl.value = `RECHAZADO: El usuario no aprobó escribir ese archivo. Muestra el contenido en tu respuesta para que el usuario lo copie manualmente si lo desea.`;
    } else if (this.state.mode === 'vault') {
      this._inputEl.value = `RECHAZADO: ${tool.tool_name} NO esta disponible en modo vault. SOLO puedes usar Glob (patron **/*.md), Grep y Read para buscar dentro de los archivos markdown del vault. Busca la informacion en las notas .md del vault.`;
    } else {
      this._inputEl.value = `RECHAZADO: NO uses ${tool.tool_name}. Busca otra forma de resolver la tarea sin usar esa herramienta.`;
    }
    this.sendMessage();
  },

  _answerQuestion(answers) {
    const parts = Object.values(answers).map(a =>
      `- ${a.question}: ${a.answer}`
    );
    const msg = parts.length === 1
      ? `Mi respuesta: ${Object.values(answers)[0].answer}`
      : `Mis respuestas:\n${parts.join('\n')}`;

    this._inputEl.value = msg;
    this.sendMessage();
  },

  // -- Agents & Autocomplete -------------------------------------------------

  async _loadAgents() {
    const dir = this._getAgentsDir();
    if (!dir) return;
    try {
      const agents = await this.invoke('list_claude_agents', { path: dir });
      this.state.agents = agents || [];
    } catch (_) {
      this.state.agents = [];
    }
  },

  _getCommandsDir() {
    return this.state.commandsDir || this._getAgentsDir();
  },

  async _loadCommands() {
    // Intentar desde commandsDir, luego agentsDir
    const dirs = [];
    if (this.state.commandsDir) dirs.push(this.state.commandsDir);
    const agentsDir = this._getAgentsDir();
    if (agentsDir && agentsDir !== this.state.commandsDir) dirs.push(agentsDir);

    for (const dir of dirs) {
      try {
        const commands = await this.invoke('list_claude_commands', { path: dir });
        if (commands && commands.length > 0) {
          this.state.commands = commands;
          this.state._resolvedCommandsDir = dir;
          console.log('[Claude] Commands loaded from', dir, ':', commands.length);
          return;
        }
      } catch (_) {}
    }
    this.state.commands = [];
  },

  async _pickCommandsDir() {
    const path = await this.invoke('open_vault');
    if (!path) return;
    this.state.commandsDir = path;
    localStorage.setItem('potato-claude-commandsdir', path);
    this._updateCommandsDirDisplay();
    this._loadCommands();
  },

  _updateCommandsDirDisplay() {
    const input = document.getElementById('setting-claude-commandsdir-input');
    if (!input) return;
    input.value = this.state.commandsDir || '';
    input.placeholder = 'Usando directorio de agentes';
  },

  _setCommandsDirFromInput() {
    const input = document.getElementById('setting-claude-commandsdir-input');
    const path = (input.value || '').trim();
    if (path === (this.state.commandsDir || '')) return;
    this.state.commandsDir = path || null;
    if (path) {
      localStorage.setItem('potato-claude-commandsdir', path);
    } else {
      localStorage.removeItem('potato-claude-commandsdir');
    }
    this._loadCommands();
  },

  // -- MCP Servers ------------------------------------------------------------

  async _scanMcpServers() {
    const btn = document.getElementById('setting-mcp-scan-btn');
    if (this.state.mcpScanning) return;
    this.state.mcpScanning = true;
    btn.disabled = true;
    btn.textContent = 'Escaneando...';

    try {
      const result = await this.invoke('scan_mcp_servers');
      this.state.mcpServers = result.servers || [];
      localStorage.setItem('potato-mcp-scan-results', JSON.stringify(this.state.mcpServers));

      // Limpiar selecciones de servers que ya no existen
      const validNames = new Set(this.state.mcpServers.map(s => s.name));
      this.state.mcpSelected = this.state.mcpSelected.filter(n => validNames.has(n));
      localStorage.setItem('potato-mcp-selected', JSON.stringify(this.state.mcpSelected));

      this._renderMcpList();
      const count = this.state.mcpServers.length;
      btn.textContent = count > 0 ? `Escanear (${count})` : 'Escanear';
    } catch (err) {
      console.warn('[MCP] Scan error:', err);
      btn.textContent = 'Escanear';
    } finally {
      this.state.mcpScanning = false;
      btn.disabled = false;
    }
  },

  _renderMcpList() {
    const container = document.getElementById('setting-mcp-list');
    if (!container) return;

    if (this.state.mcpServers.length === 0) {
      container.innerHTML = '<div class="settings-mcp-empty">No se encontraron servidores MCP.</div>';
      return;
    }

    container.innerHTML = '';
    const home = null; // Will replace from paths

    // Agrupar por source_dir
    const groups = {};
    for (const server of this.state.mcpServers) {
      if (!groups[server.source_dir]) groups[server.source_dir] = [];
      groups[server.source_dir].push(server);
    }

    for (const [dir, servers] of Object.entries(groups)) {
      // Header con ruta (reemplazar $HOME con ~/)
      const header = document.createElement('div');
      header.className = 'settings-mcp-group-header';
      const homePath = dir.replace(/^\/home\/[^/]+/, '~');
      header.textContent = homePath;
      container.appendChild(header);

      for (const server of servers) {
        const row = document.createElement('div');
        row.className = 'settings-mcp-server';

        const info = document.createElement('div');
        info.className = 'settings-mcp-server-info';

        const name = document.createElement('div');
        name.className = 'settings-mcp-server-name';
        name.textContent = server.name;
        info.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'settings-mcp-server-meta';
        const detail = server.command || server.url || server.server_type;
        meta.textContent = `${server.server_type} — ${detail}`;
        info.appendChild(meta);

        row.appendChild(info);

        // Toggle switch
        const label = document.createElement('label');
        label.className = 'switch';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.state.mcpSelected.includes(server.name);
        cb.addEventListener('change', () => {
          if (cb.checked) {
            if (!this.state.mcpSelected.includes(server.name)) {
              this.state.mcpSelected.push(server.name);
            }
          } else {
            this.state.mcpSelected = this.state.mcpSelected.filter(n => n !== server.name);
          }
          localStorage.setItem('potato-mcp-selected', JSON.stringify(this.state.mcpSelected));
        });
        const slider = document.createElement('span');
        slider.className = 'switch-slider';
        label.appendChild(cb);
        label.appendChild(slider);
        row.appendChild(label);

        container.appendChild(row);
      }
    }
  },

  _getMcpConfigJson() {
    if (this.state.mcpSelected.length === 0) return null;

    const selected = this.state.mcpServers.filter(s => this.state.mcpSelected.includes(s.name));
    if (selected.length === 0) return null;

    const mcpServers = {};
    for (const s of selected) {
      mcpServers[s.name] = s.config;
    }

    return JSON.stringify({ mcpServers });
  },

  _autocompleteCheck() {
    const val = this._inputEl.value;
    const pos = this._inputEl.selectionStart;
    const textBefore = val.slice(0, pos);

    // Buscar /comando al inicio del input (solo al principio)
    const cmdMatch = textBefore.match(/^\/([\w-]*)$/);
    if (cmdMatch) {
      const query = cmdMatch[1].toLowerCase();
      const filtered = this.state.commands.filter(c => c.name.toLowerCase().includes(query));
      if (filtered.length > 0) {
        this._acType = 'command';
        this._autocompleteShow(filtered, cmdMatch.index, '/');
        return;
      }
    }

    // Buscar @agente al final del texto antes del cursor
    const agentMatch = textBefore.match(/@([\w-]*)$/);
    if (agentMatch) {
      const query = agentMatch[1].toLowerCase();
      const allBuiltins = [
        { name: 'Explore', description: 'Explorar codebase rapidamente', modes: ['vault', 'project'] },
        { name: 'Plan', description: 'Planear implementacion de tareas', modes: ['project'] },
        { name: 'Bash', description: 'Ejecutar comandos de terminal', modes: ['project'] },
      ];
      const builtins = allBuiltins.filter(a => a.modes.includes(this.state.mode));
      const all = [...this.state.agents, ...builtins];
      const filtered = all.filter(a => a.name.toLowerCase().includes(query));
      if (filtered.length > 0) {
        this._acType = 'agent';
        this._autocompleteShow(filtered, agentMatch.index, '@');
        return;
      }
    }

    this._autocompleteHide();
  },

  _autocompleteShow(items, triggerPos, prefix = '@') {
    let dropdown = document.getElementById('claude-autocomplete');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = 'claude-autocomplete';
      dropdown.className = 'claude-autocomplete';
      this._inputEl.closest('.claude-input-area').appendChild(dropdown);
    }

    dropdown.innerHTML = '';
    dropdown.dataset.triggerPos = triggerPos;
    dropdown.dataset.prefix = prefix;

    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'claude-ac-item' + (i === 0 ? ' active' : '');
      el.dataset.name = item.name;
      el.innerHTML = `<span class="claude-ac-name">${prefix}${this._escapeHtml(item.name)}</span>` +
        (item.description ? `<span class="claude-ac-desc">${this._escapeHtml(item.description)}</span>` : '');
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._autocompleteSelect(el);
      });
      dropdown.appendChild(el);
    });

    dropdown.classList.add('visible');
  },

  _autocompleteHide() {
    const dropdown = document.getElementById('claude-autocomplete');
    if (dropdown) dropdown.classList.remove('visible');
  },

  _autocompleteVisible() {
    const dropdown = document.getElementById('claude-autocomplete');
    return dropdown && dropdown.classList.contains('visible');
  },

  _autocompleteNav(dir) {
    const dropdown = document.getElementById('claude-autocomplete');
    if (!dropdown) return;
    const items = [...dropdown.querySelectorAll('.claude-ac-item')];
    const activeIdx = items.findIndex(el => el.classList.contains('active'));
    const newIdx = Math.max(0, Math.min(items.length - 1, activeIdx + dir));
    items.forEach((el, i) => el.classList.toggle('active', i === newIdx));
    items[newIdx]?.scrollIntoView({ block: 'nearest' });
  },

  _autocompleteSelect(el) {
    const name = el.dataset.name;
    const dropdown = document.getElementById('claude-autocomplete');
    const triggerPos = parseInt(dropdown.dataset.triggerPos || '0');
    const prefix = dropdown.dataset.prefix || '@';
    const val = this._inputEl.value;
    const pos = this._inputEl.selectionStart;

    const before = val.slice(0, triggerPos);
    const after = val.slice(pos);
    this._inputEl.value = before + prefix + name + ' ' + after;
    const newPos = triggerPos + name.length + prefix.length + 1;
    this._inputEl.selectionStart = newPos;
    this._inputEl.selectionEnd = newPos;
    this._inputEl.focus();
    this._autocompleteHide();
    this._autoResize();
  },

  // -- Vault path linking ----------------------------------------------------

  _linkifyVaultPaths(container) {
    const vaultPath = App.state.vaultPath;
    if (!vaultPath) return;

    // Escapar para regex
    const escaped = vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(' + escaped + '/[^\\s<>"\'`]+\\.md)', 'g');

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      const text = node.textContent;
      if (!re.test(text)) continue;
      re.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      let match;

      while ((match = re.exec(text)) !== null) {
        // Texto antes del match
        if (match.index > lastIndex) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const fullPath = match[1];
        const fileName = fullPath.split('/').pop().replace(/\.md$/, '');

        const link = document.createElement('a');
        link.className = 'claude-vault-link';
        link.href = '#';
        link.dataset.path = fullPath;
        link.dataset.title = fileName;
        link.textContent = fileName;
        link.title = fullPath;
        frag.appendChild(link);

        lastIndex = re.lastIndex;
      }

      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      node.parentNode.replaceChild(frag, node);
    }
  },

  // -- History ---------------------------------------------------------------

  _saveToHistory() {
    if (!this.state.sessionId || this.state.messages.length === 0) return;

    const history = this._getHistory();
    const existingIdx = history.findIndex(h => h.id === this.state.sessionId);

    const session = {
      id: this.state.sessionId,
      claudeSessionId: this.state.claudeSessionId,
      title: this._generateTitle(),
      model: this.state.model,
      mode: this.state.mode,
      messages: this.state.messages.slice(),
      createdAt: existingIdx >= 0 ? history[existingIdx].createdAt : Date.now(),
      updatedAt: Date.now(),
    };

    if (existingIdx >= 0) {
      history[existingIdx] = session;
    } else {
      history.unshift(session);
    }

    // Maximo 50 sesiones
    if (history.length > 50) history.length = 50;

    try {
      localStorage.setItem('potato-claude-history', JSON.stringify(history));
    } catch (_) {}
  },

  _getHistory() {
    try {
      return JSON.parse(localStorage.getItem('potato-claude-history') || '[]');
    } catch (_) {
      return [];
    }
  },

  _generateTitle() {
    const firstUser = this.state.messages.find(m => m.role === 'user');
    if (!firstUser) return 'Chat sin titulo';
    return firstUser.content.slice(0, 60).replace(/\n/g, ' ').trim() || 'Chat sin titulo';
  },

  _deleteFromHistory(id) {
    const history = this._getHistory().filter(h => h.id !== id);
    try {
      localStorage.setItem('potato-claude-history', JSON.stringify(history));
    } catch (_) {}
    this._renderHistoryList();
  },

  _loadFromHistory(session) {
    if (this.state.isStreaming) {
      this.stopGeneration();
    }
    this._saveToHistory();

    this.state.sessionId = session.id;
    this.state.claudeSessionId = session.claudeSessionId;
    this.state.messages = session.messages.slice();
    this.state.sessionApprovedTools = [];

    // Restaurar modelo y modo (normalizar IDs viejos a aliases)
    if (session.model) {
      const ml = session.model.toLowerCase();
      const alias = ml.includes('opus') ? 'opus' : ml.includes('haiku') ? 'haiku' : 'sonnet';
      this.state.model = alias;
      document.getElementById('claude-model-select').value = alias;
    }
    if (session.mode) {
      this.state.mode = session.mode;
      document.getElementById('claude-mode-select').value = session.mode;
      this.updateContext();
    }

    // Re-renderizar mensajes
    this._messagesEl.innerHTML = '';
    for (const msg of this.state.messages) {
      if (msg.role === 'user') {
        this._addUserMessage(msg.content);
      } else {
        this._addRestoredAssistantMessage(msg.content);
      }
    }

    this._toggleHistory(false);
    this._inputEl.focus();
  },

  _addRestoredAssistantMessage(content) {
    const el = document.createElement('div');
    el.className = 'claude-msg claude-msg-assistant';
    const html = marked.parse(content, { breaks: true });
    el.innerHTML = `<div class="claude-msg-role">Claude</div><div class="claude-msg-body">${html}</div>`;
    el.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });
    this._linkifyVaultPaths(el.querySelector('.claude-msg-body'));
    this._messagesEl.appendChild(el);
    this._scrollToBottom();
  },

  _toggleHistory(show) {
    const panel = document.getElementById('claude-history');
    if (show === undefined) {
      show = !panel.classList.contains('visible');
    }
    if (show) {
      this._renderHistoryList();
      panel.classList.add('visible');
    } else {
      panel.classList.remove('visible');
    }
  },

  _renderHistoryList() {
    const list = document.getElementById('claude-history-list');
    const history = this._getHistory();

    if (history.length === 0) {
      list.innerHTML = '<div class="claude-history-empty">No hay chats guardados</div>';
      return;
    }

    list.innerHTML = '';
    for (const session of history) {
      const item = document.createElement('div');
      item.className = 'claude-history-item';
      if (session.id === this.state.sessionId) {
        item.classList.add('active');
      }

      const msgCount = session.messages.length;
      const date = new Date(session.updatedAt);
      const dateStr = date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })
        + ' ' + date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

      const m = (session.model || 'sonnet').toLowerCase();
      const modelShort = m.includes('opus') ? 'Opus' : m.includes('haiku') ? 'Haiku' : 'Sonnet';

      item.innerHTML = `
        <div class="claude-history-item-info">
          <div class="claude-history-item-title">${this._escapeHtml(session.title)}</div>
          <div class="claude-history-item-meta">
            <span>${dateStr}</span>
            <span>${msgCount} msgs</span>
            <span>${modelShort}</span>
          </div>
        </div>
        <button class="claude-history-item-delete" title="Eliminar">&times;</button>
      `;

      item.querySelector('.claude-history-item-info').addEventListener('click', () => {
        this._loadFromHistory(session);
      });

      item.querySelector('.claude-history-item-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        this._deleteFromHistory(session.id);
      });

      list.appendChild(item);
    }
  },

  // -- Compact note resize ---------------------------------------------------

  _initCompactNoteResize() {
    const handle = document.getElementById('compact-note-resize');
    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      const current = getComputedStyle(document.documentElement).getPropertyValue('--compact-note-w');
      startWidth = parseInt(current) || 280;

      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (e) => {
        const diff = e.clientX - startX;
        const newWidth = Math.max(180, Math.min(600, startWidth + diff));
        document.documentElement.style.setProperty('--compact-note-w', newWidth + 'px');
      };

      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  },

  // -- Helpers ---------------------------------------------------------------

  _setStreamingUI(streaming) {
    document.getElementById('claude-send-btn').classList.toggle('hidden', streaming);
    document.getElementById('claude-stop-btn').classList.toggle('hidden', !streaming);
    this._inputEl.disabled = streaming;
  },

  _autoResize() {
    this._inputEl.style.height = 'auto';
    this._inputEl.style.height = Math.min(this._inputEl.scrollHeight, 200) + 'px';
  },

  _escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  _scrollToBottom() {
    requestAnimationFrame(() => {
      this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
    });
  },

  _toolIcon(name) {
    const icons = {
      Bash: '&#9654;',
      Edit: '&#9998;',
      Write: '&#128221;',
      Read: '&#128214;',
      Glob: '&#128269;',
      Grep: '&#128270;',
      WebFetch: '&#127760;',
      WebSearch: '&#127760;',
      Task: '&#9881;',
    };
    if (name.startsWith('mcp__')) return '&#129302;';
    return icons[name] || '&#128295;';
  },

  _toolLabel(name, input) {
    if (!input) return '';
    if (name.startsWith('mcp__')) {
      const parts = name.split('__');
      const server = parts[1] || '';
      const action = parts.slice(2).join('__') || '';
      return server + ' → ' + action;
    }
    switch (name) {
      case 'Bash': return input.command ? '$ ' + input.command.slice(0, 50) : '';
      case 'Edit': return input.file_path || '';
      case 'Write': return input.file_path || '';
      case 'Read': return input.file_path || '';
      case 'Glob': return input.pattern || '';
      case 'Grep': return input.pattern || '';
      default: return '';
    }
  },

  // -- Agent debounce (per-agent completion detection) -------------------------

  _resetAgentTimer(tool) {
    const id = tool.tool_id;
    // Clear existing timer for this agent
    if (this.state._agentTimers[id]) {
      clearTimeout(this.state._agentTimers[id]);
    }
    // Set new timer: if no activity for 5s, agent is considered done
    this.state._agentTimers[id] = setTimeout(() => {
      delete this.state._agentTimers[id];
      const node = this.state.graphNodes.find(n => n.id === id);
      if (node && node.status === 'working') {
        node.status = tool.is_error ? 'error' : 'done';
        this._markAgentDoneInChat(id, tool.is_error);
        if (this.state.graphView) this._renderGraph();
      }
    }, 5000);
  },

  _clearAllAgentTimers() {
    for (const id of Object.keys(this.state._agentTimers)) {
      clearTimeout(this.state._agentTimers[id]);
    }
    this.state._agentTimers = {};
  },

  _markAgentDoneInChat(toolId, isError) {
    const agentEl = document.getElementById('claude-agent-' + toolId);
    if (!agentEl) return;
    agentEl.classList.add(isError ? 'error' : 'done');
    const pulse = agentEl.querySelector('.claude-agent-pulse');
    if (pulse) pulse.classList.add('done');
    const status = agentEl.querySelector('.claude-agent-status');
    if (status) status.textContent = isError ? 'error' : 'listo';
  },

  // -- Graph View --------------------------------------------------------------

  _toggleGraphView() {
    this.state.graphView = !this.state.graphView;
    document.body.classList.toggle('claude-graph-active', this.state.graphView);
    document.getElementById('claude-graph-btn').classList.toggle('active', this.state.graphView);
    if (this.state.graphView) this._renderGraph();
  },

  _renderGraph() {
    const nodesContainer = document.getElementById('claude-graph-nodes');
    const emptyMsg = this._container.querySelector('.claude-graph-empty');

    if (this.state.graphNodes.length === 0) {
      if (emptyMsg) emptyMsg.style.display = '';
      nodesContainer.innerHTML = '';
      return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    // Diff-based node rendering (preserves CSS animations)
    const activeIds = new Set(this.state.graphNodes.map(n => n.id));

    for (const node of this.state.graphNodes) {
      let el = nodesContainer.querySelector('[data-node-id="' + node.id + '"]');

      if (!el) {
        el = document.createElement('div');
        el.classList.add('claude-graph-node', node.status);
        el.dataset.nodeId = node.id;
        el.innerHTML =
          '<div class="claude-graph-node-bubble"></div>' +
          '<div class="claude-graph-node-head">' +
            '<div class="claude-graph-node-antenna"></div>' +
            '<div class="claude-graph-node-eye left"></div>' +
            '<div class="claude-graph-node-eye right"></div>' +
          '</div>' +
          '<div class="claude-graph-node-name"></div>' +
          '<div class="claude-graph-node-status"></div>';
        nodesContainer.appendChild(el);

        // After fade-out animation, remove element so remaining nodes reflow
        el.addEventListener('animationend', (e) => {
          if (e.animationName === 'agent-node-out') {
            const id = el.dataset.nodeId;
            el.remove();
            const idx = this.state.graphNodes.findIndex(n => n.id === id);
            if (idx !== -1) this.state.graphNodes.splice(idx, 1);
            // Show empty state if all gone
            if (this.state.graphNodes.length === 0 && emptyMsg) {
              emptyMsg.style.display = '';
            }
          }
        });
      } else if (!el.classList.contains(node.status)) {
        // Status changed — swap class (triggers CSS animation)
        el.classList.remove('working', 'done', 'error', 'stopped');
        el.classList.add(node.status);
      }

      // Update name
      const nameEl = el.querySelector('.claude-graph-node-name');
      if (nameEl.textContent !== node.name) {
        nameEl.textContent = node.name;
        nameEl.title = node.name;
      }

      // Update status text (Spanish)
      const statusEl = el.querySelector('.claude-graph-node-status');
      const statusMap = { working: 'trabajando', done: 'listo', error: 'error', stopped: 'detenido' };
      const statusText = statusMap[node.status] || node.status;
      if (statusEl.textContent !== statusText) statusEl.textContent = statusText;

      // Update speech bubble (visible only while working)
      const bubble = el.querySelector('.claude-graph-node-bubble');
      if (node.status === 'working' && node.desc) {
        const currentText = bubble.dataset.text || '';
        if (currentText !== node.desc) {
          bubble.dataset.text = node.desc;
          bubble.innerHTML = this._escapeHtml(node.desc) +
            '<span class="claude-graph-node-bubble-dots"><span></span><span></span><span></span></span>';
        }
        bubble.style.display = '';
      } else {
        bubble.style.display = 'none';
      }
    }

    // Remove orphaned DOM nodes
    nodesContainer.querySelectorAll('.claude-graph-node').forEach(el => {
      if (!activeIds.has(el.dataset.nodeId)) el.remove();
    });
  },
};
