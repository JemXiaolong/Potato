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
    model: 'claude-sonnet-4-5-20250929',
    workingDir: null,    // null = usa vault path (para agentes)
    projectDir: null,    // directorio del proyecto/código
    mode: 'vault',       // 'vault' o 'project'
    agents: [],          // agentes custom disponibles
    allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    sessionApprovedTools: [],
    panelMode: 'closed', // 'closed', 'normal', 'minimized', 'maximized'
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

    // Project directory button in settings
    document.getElementById('setting-claude-projectdir-btn').addEventListener('click', () => this._pickProjectDir());

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
  },

  async _checkInstalled() {
    try {
      await this.invoke('check_claude');
      this.state.installed = true;
      // Show toggle button
      document.getElementById('claude-toggle-btn').classList.remove('hidden');
    } catch (_) {
      this.state.installed = false;
    }
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
    const parts = [
      'Eres un asistente inteligente trabajando dentro de un vault de notas markdown.',
      'Tu rol es entender lo que el usuario necesita y usar las herramientas o agentes adecuados.',
    ];

    // Agentes disponibles
    if (this.state.agents.length > 0) {
      parts.push('');
      parts.push('AGENTES ESPECIALIZADOS DISPONIBLES (invocalos con la herramienta Task, subagent_type="general-purpose"):');
      for (const agent of this.state.agents) {
        parts.push(`- @${agent.name}: ${agent.description}`);
      }
      parts.push('');
      parts.push('COMO ELEGIR:');
      parts.push('- Si el usuario pregunta sobre documentacion, knowledge o notas → busca directo con Glob/Grep/Read o delega a un agente locator/analyzer.');
      parts.push('- Si el usuario quiere investigar en internet → usa WebSearch/WebFetch o delega a un agente de research.');
      parts.push('- Si el usuario pregunta sobre codigo (Odoo, modulos, etc.) → delega al agente de codebase apropiado.');
      parts.push('- Si la tarea es simple (buscar un archivo, leer una nota) → hazlo tu directamente sin delegar.');
      parts.push('- Si la tarea es compleja o requiere especialización → delega al agente mas adecuado.');
    }

    parts.push('');
    parts.push('HERRAMIENTAS DIRECTAS:');
    parts.push('- Glob, Grep, Read: buscar y leer archivos en el vault.');
    parts.push('- WebSearch, WebFetch: investigar en internet.');
    parts.push('- Task: delegar a agentes especializados.');
    parts.push('');
    parts.push('REGLAS:');
    parts.push('1. NUNCA uses Bash, Write, Edit, MCP ni herramientas no listadas.');
    parts.push('2. SIEMPRE que menciones un archivo, incluye su RUTA ABSOLUTA COMPLETA.');
    parts.push('3. Responde en español. Se conciso y util.');

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
  },

  _updateWorkdirDisplay() {
    const pathEl = document.getElementById('setting-claude-workdir-path');
    if (!pathEl) return;
    const dir = this.state.workingDir;
    pathEl.textContent = dir || 'Usando vault';
    pathEl.title = dir || '';
  },

  async _pickProjectDir() {
    const path = await this.invoke('open_vault');
    if (!path) return;
    this.state.projectDir = path;
    localStorage.setItem('potato-claude-projectdir', path);
    this._updateProjectDirDisplay();
    this.newChat();
    this._loadAgents();
  },

  _updateProjectDirDisplay() {
    const pathEl = document.getElementById('setting-claude-projectdir-path');
    if (!pathEl) return;
    const dir = this.state.projectDir;
    pathEl.textContent = dir || 'No configurado';
    pathEl.title = dir || '';
  },

  onVaultChanged() {
    // Recargar agentes si no hay workdir/projectdir custom (usa vault)
    if (!this.state.workingDir && !this.state.projectDir) {
      this._loadAgents();
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
    if (!this.state.installed) {
      this._showError('Claude Code no esta instalado. Ejecuta: npm install -g @anthropic-ai/claude-code');
      return;
    }

    const text = this._inputEl.value.trim();
    if (!text) return;

    this._inputEl.value = '';
    this._autoResize();

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
      this.state.messages.push({ role: 'user', content: text });
      this._addUserMessage(text);
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

            if (vaultReview.includes(chunk.tool.tool_name)) {
              // Write/Edit en vault: verificar que la ruta esté dentro del vault
              const filePath = chunk.tool.input?.file_path || '';
              if (App.state.vaultPath && !filePath.startsWith(App.state.vaultPath)) {
                // Fuera del vault → rechazar silenciosamente
                this._vaultRetry();
                return;
              }
              // Dentro del vault → mostrar preview para aprobación individual
              this.state.isStreaming = false;
              this._setStreamingUI(false);
              this._showToolApproval(chunk.tool);
              return;
            }

            if (!vaultAuto.includes(chunk.tool.tool_name)) {
              // Tool no permitido → auto-rechazar
              this._vaultRetry();
              return;
            }
          }
          this.state.isStreaming = false;
          this._setStreamingUI(false);
          this._showToolApproval(chunk.tool);
          return;
        }

        if (chunk.tool.phase === 'start') {
          if (chunk.tool.tool_name === 'Task') {
            this._showAgentStart(chunk.tool);
          } else {
            this._showToolStart(chunk.tool);
          }
        } else if (chunk.tool.phase === 'result') {
          if (document.getElementById('claude-agent-' + chunk.tool.tool_id)) {
            this._showAgentResult(chunk.tool);
          } else {
            this._showToolResult(chunk.tool);
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

    try {
      await this.invoke('send_claude_message', {
        message: finalMessage,
        processId: this.state.sessionId,
        sessionId: this.state.claudeSessionId,
        model: this.state.model,
        workingDir: this._getWorkingDir(),
        allowedTools,
        systemPrompt,
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

  _vaultRetry() {
    const lastUserMsg = [...this.state.messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;

    // Resetear estado de streaming y sesion
    this.state.isStreaming = false;
    this._setStreamingUI(false);
    this.state.sessionId = null;
    this.state.claudeSessionId = null;
    this.state.sessionApprovedTools = [];

    // Reenviar silenciosamente — el system prompt dinámico ya tiene las reglas
    this._silent = true;
    this._inputEl.value = lastUserMsg.content;
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
        const label = this._toolLabel(tool.tool_name, inp);
        if (label) summaryHtml = `<div class="claude-approval-desc">${this._escapeHtml(label)}</div>`;
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

    this._inputEl.value = `APROBADO. ${details}`;
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

  _autocompleteCheck() {
    const val = this._inputEl.value;
    const pos = this._inputEl.selectionStart;
    const textBefore = val.slice(0, pos);

    // Buscar @palabra al final del texto antes del cursor
    const match = textBefore.match(/@([\w-]*)$/);
    if (!match) {
      this._autocompleteHide();
      return;
    }

    const query = match[1].toLowerCase();

    // Builtin agents + custom agents (filtrar por modo)
    const allBuiltins = [
      { name: 'Explore', description: 'Explorar codebase rapidamente', modes: ['vault', 'project'] },
      { name: 'Plan', description: 'Planear implementacion de tareas', modes: ['project'] },
      { name: 'Bash', description: 'Ejecutar comandos de terminal', modes: ['project'] },
    ];
    const builtins = allBuiltins.filter(a => a.modes.includes(this.state.mode));
    const all = [...this.state.agents, ...builtins];
    const filtered = all.filter(a => a.name.toLowerCase().includes(query));

    if (filtered.length === 0) {
      this._autocompleteHide();
      return;
    }

    this._autocompleteShow(filtered, match.index);
  },

  _autocompleteShow(items, triggerPos) {
    let dropdown = document.getElementById('claude-autocomplete');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = 'claude-autocomplete';
      dropdown.className = 'claude-autocomplete';
      this._inputEl.closest('.claude-input-area').appendChild(dropdown);
    }

    dropdown.innerHTML = '';
    dropdown.dataset.triggerPos = triggerPos;

    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'claude-ac-item' + (i === 0 ? ' active' : '');
      el.dataset.name = item.name;
      el.innerHTML = `<span class="claude-ac-name">@${this._escapeHtml(item.name)}</span>` +
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
    const val = this._inputEl.value;
    const pos = this._inputEl.selectionStart;

    // Reemplazar @query con @nombre
    const before = val.slice(0, triggerPos);
    const after = val.slice(pos);
    this._inputEl.value = before + '@' + name + ' ' + after;
    const newPos = triggerPos + name.length + 2;
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

    // Restaurar modelo y modo
    if (session.model) {
      this.state.model = session.model;
      document.getElementById('claude-model-select').value = session.model;
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

      const modelShort = (session.model || '').includes('opus') ? 'Opus'
        : (session.model || '').includes('haiku') ? 'Haiku' : 'Sonnet';

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
    return icons[name] || '&#128295;';
  },

  _toolLabel(name, input) {
    if (!input) return '';
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
};
