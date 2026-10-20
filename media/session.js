(() => {
  const vscode = acquireVsCodeApi();
  const listEl = document.getElementById('session-list');
  const emptyStateEl = document.getElementById('empty-state');
  const newSessionBtn = document.getElementById('new-session-btn');
  const searchInput = document.getElementById('session-search');
  const projectBar = document.getElementById('project-bar');
  const projectNameEl = document.getElementById('project-name');
  const noProjectBanner = document.getElementById('no-project-banner');
  const openProjectBtn = document.getElementById('open-project-btn');
  const tasksContainer = document.getElementById('tasks-container');

  let currentSessions = [];
  let currentActiveId = undefined;
  let currentProject = undefined;

  function formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay === 1) return 'Yesterday';
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderSessions() {
    if (!currentProject) {
      if (noProjectBanner) noProjectBanner.hidden = false;
      if (projectBar) projectBar.hidden = true;
      if (tasksContainer) tasksContainer.hidden = true;
      return;
    }

    if (noProjectBanner) noProjectBanner.hidden = true;
    if (projectBar) {
      projectBar.hidden = false;
      if (projectNameEl) projectNameEl.textContent = currentProject.name;
    }
    if (tasksContainer) tasksContainer.hidden = false;

    const query = (searchInput.value || '').trim().toLowerCase();
    const filtered = currentSessions.filter((s) => {
      if (!query) return true;
      return (s.title && s.title.toLowerCase().includes(query));
    });

    listEl.querySelectorAll('.session-card').forEach((el) => el.remove());

    if (filtered.length === 0) {
      if (emptyStateEl) emptyStateEl.style.display = 'block';
      return;
    }

    if (emptyStateEl) emptyStateEl.style.display = 'none';

    filtered.forEach((session) => {
      const card = document.createElement('div');
      card.className = `session-card ${session.id === currentActiveId ? 'active' : ''}`;
      card.setAttribute('role', 'listitem');
      card.dataset.id = session.id;

      const header = document.createElement('div');
      header.className = 'session-card-header';

      const title = document.createElement('span');
      title.className = 'session-card-title';
      title.textContent = session.title || 'Untitled Task';

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-card-delete';
      deleteBtn.title = session.taskState ? 'Abandon task' : 'Delete empty task';
      deleteBtn.innerHTML = '&#128465;'; // trash can icon
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
      });

      header.append(title, deleteBtn);

      const meta = document.createElement('div');
      meta.className = 'session-card-meta';

      const time = document.createElement('span');
      time.className = 'session-time';
      time.textContent = formatTime(session.updatedAt || session.createdAt);

      meta.append(time);

      const turnCount = session.turns?.filter((t) => t.role === 'user')?.length || session.taskIds?.length || 0;
      if (session.taskState) {
        const badge = document.createElement('span');
        badge.className = 'session-badge';
        badge.textContent = `${session.taskState} · ${session.nextAction || ''}`;
        meta.append(badge);
      } else if (turnCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'session-badge';
        badge.textContent = `${turnCount} prompt${turnCount > 1 ? 's' : ''}`;
        meta.append(badge);
      }

      card.append(header, meta);

      card.addEventListener('click', () => {
        vscode.postMessage({ type: 'selectSession', sessionId: session.id });
      });

      listEl.appendChild(card);
    });
  }

  // Modal controls
  const sidebarMcpBtn = document.getElementById('sidebar-mcp-btn');
  const sidebarSettingsBtn = document.getElementById('sidebar-settings-btn');
  const mcpModal = document.getElementById('mcp-modal');
  const mcpModalClose = document.getElementById('mcp-modal-close');
  const settingsModal = document.getElementById('settings-modal');
  const settingsModalClose = document.getElementById('settings-modal-close');

  // MCP elements
  const mcpIndicator = document.getElementById('sidebar-mcp-indicator');
  const mcpStatusText = document.getElementById('sidebar-mcp-status-text');
  const mcpToggleBtn = document.getElementById('sidebar-mcp-toggle');
  const mcpEndpointBox = document.getElementById('sidebar-mcp-endpoint-box');
  const mcpEndpointCode = document.getElementById('sidebar-mcp-endpoint');
  const mcpCopyBtn = document.getElementById('sidebar-mcp-copy');

  // Settings elements
  const vscodeKeysBtn = document.getElementById('sidebar-vscode-keys-btn');
  const routerForm = document.getElementById('sidebar-router-form');
  const routerPrimary = document.getElementById('sidebar-router-primary');
  const gemmaModelInput = document.getElementById('sidebar-gemma-model');
  const ollamaModelInput = document.getElementById('sidebar-ollama-model');
  const gemmaKeyTag = document.getElementById('gemma-key-tag');
  const ollamaKeyTag = document.getElementById('ollama-key-tag');
  const elevenlabsKeyTag = document.getElementById('elevenlabs-key-tag');
  const keyGemmaInput = document.getElementById('sidebar-key-gemma');
  const keyOllamaInput = document.getElementById('sidebar-key-ollama');
  const keyElevenlabsInput = document.getElementById('sidebar-key-elevenlabs');
  const settingsNotice = document.getElementById('sidebar-settings-notice');

  function openModal(modal) {
    if (!modal) return;
    modal.hidden = false;
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.hidden = true;
  }

  function showNotice(text) {
    if (!settingsNotice) return;
    settingsNotice.textContent = text;
    settingsNotice.hidden = false;
    setTimeout(() => {
      settingsNotice.hidden = true;
    }, 4000);
  }

  // Open & Close Handlers
  sidebarMcpBtn?.addEventListener('click', () => {
    openModal(mcpModal);
    vscode.postMessage({ type: 'mcpStatusRequest' });
  });

  mcpModalClose?.addEventListener('click', () => closeModal(mcpModal));
  mcpModal?.addEventListener('click', (e) => {
    if (e.target === mcpModal) closeModal(mcpModal);
  });

  sidebarSettingsBtn?.addEventListener('click', () => {
    openModal(settingsModal);
    vscode.postMessage({ type: 'personalKeysStatus' });
    vscode.postMessage({ type: 'routerSettingsStatus' });
  });

  settingsModalClose?.addEventListener('click', () => closeModal(settingsModal));
  settingsModal?.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeModal(settingsModal);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal(mcpModal);
      closeModal(settingsModal);
    }
  });

  // MCP interactions
  mcpToggleBtn?.addEventListener('click', () => {
    mcpToggleBtn.disabled = true;
    mcpToggleBtn.textContent = 'Working…';
    vscode.postMessage({ type: 'mcpToggle' });
  });

  mcpCopyBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'mcpCopyConfig' });
  });

  // Settings interactions
  vscodeKeysBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openVsCodeSetKeys' });
  });

  routerForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    vscode.postMessage({
      type: 'saveRouterSettings',
      settings: {
        primary: routerPrimary.value,
        gemmaModel: gemmaModelInput.value.trim(),
        ollamaModel: ollamaModelInput.value.trim(),
      },
    });
  });

  document.querySelectorAll('.btn-key-save').forEach((btn) => {
    btn.addEventListener('click', () => {
      const provider = btn.getAttribute('data-provider');
      let val = '';
      if (provider === 'gemma') val = keyGemmaInput?.value.trim() || '';
      else if (provider === 'ollama') val = keyOllamaInput?.value.trim() || '';
      else if (provider === 'elevenlabs') val = keyElevenlabsInput?.value.trim() || '';

      if (!val) {
        showNotice('Please enter an API key first.');
        return;
      }
      vscode.postMessage({ type: 'savePersonalKey', provider, value: val });
    });
  });

  document.querySelectorAll('.btn-key-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const provider = btn.getAttribute('data-provider');
      vscode.postMessage({ type: 'clearPersonalKey', provider });
    });
  });

  newSessionBtn?.addEventListener('click', () => {
    if (!currentProject) {
      vscode.postMessage({ type: 'openProject' });
      return;
    }
    vscode.postMessage({ type: 'newSession' });
  });

  openProjectBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openProject' });
  });

  searchInput?.addEventListener('input', () => {
    renderSessions();
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'sessionsList') {
      currentSessions = message.sessions || [];
      currentProject = message.project;
      currentActiveId = message.activeSessionId;
      renderSessions();
    } else if (message.type === 'activeSessionChanged') {
      currentActiveId = message.activeSessionId;
      renderSessions();
    } else if (message.type === 'mcpStatus') {
      if (mcpToggleBtn) {
        mcpToggleBtn.disabled = false;
        mcpToggleBtn.textContent = message.running ? 'Stop MCP' : 'Start MCP';
      }
      if (mcpIndicator) {
        mcpIndicator.classList.toggle('active', Boolean(message.running));
      }
      if (mcpStatusText) {
        mcpStatusText.textContent = message.running ? 'Server Running' : 'Server Stopped';
      }
      if (mcpEndpointBox) {
        mcpEndpointBox.hidden = !message.running;
      }
      if (mcpEndpointCode) {
        mcpEndpointCode.textContent = message.running ? `${message.command || 'baton-mcp-server'} "${message.endpoint || ''}"` : '';
      }
    } else if (message.type === 'personalKeysStatus') {
      const configured = message.configured || {};
      const hasDefault = message.hasDefault || {};
      if (gemmaKeyTag) {
        gemmaKeyTag.textContent = configured.gemma ? 'Personal Key' : (hasDefault.gemma ? 'Default (Active)' : 'Not set');
        gemmaKeyTag.classList.toggle('configured', Boolean(configured.gemma));
        gemmaKeyTag.classList.toggle('default-key', Boolean(!configured.gemma && hasDefault.gemma));
      }
      if (ollamaKeyTag) {
        ollamaKeyTag.textContent = configured.ollama ? 'Personal Key' : (hasDefault.ollama ? 'Default (Active)' : 'Not set');
        ollamaKeyTag.classList.toggle('configured', Boolean(configured.ollama));
        ollamaKeyTag.classList.toggle('default-key', Boolean(!configured.ollama && hasDefault.ollama));
      }
      if (elevenlabsKeyTag) {
        elevenlabsKeyTag.textContent = configured.elevenlabs ? 'Personal Key' : (hasDefault.elevenlabs ? 'Default (Active)' : 'Not set');
        elevenlabsKeyTag.classList.toggle('configured', Boolean(configured.elevenlabs));
        elevenlabsKeyTag.classList.toggle('default-key', Boolean(!configured.elevenlabs && hasDefault.elevenlabs));
      }
      if (message.notice) {
        showNotice(message.notice);
      }
    } else if (message.type === 'routerSettingsStatus') {
      if (message.settings) {
        if (routerPrimary) routerPrimary.value = message.settings.primary;
        if (gemmaModelInput) gemmaModelInput.value = message.settings.gemmaModel;
        if (ollamaModelInput) ollamaModelInput.value = message.settings.ollamaModel;
      }
      if (message.notice) {
        showNotice(message.notice);
      }
    }
  });

  vscode.postMessage({ type: 'loadSessions' });
  vscode.postMessage({ type: 'mcpStatusRequest' });
})();
