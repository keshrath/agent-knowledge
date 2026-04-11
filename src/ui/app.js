/* agent-knowledge dashboard — main entry point */
(function () {
  'use strict';

  const K = window.Knowledge;

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    activeTab: 'knowledge',
    knowledge: { entries: [], activeCategory: 'all', duplicateClusters: {} },
    search: {
      query: '',
      results: [],
      role: 'all',
      scope: 'all',
      ranked: true,
      semantic: false,
      loading: false,
    },
    sessions: { list: [], projectFilter: '', loading: false, offset: 0, allLoaded: false },
    embeddings: { stats: null, loading: false },
    panel: { open: false, type: null, data: null },
    stats: { knowledgeCount: 0, sessionCount: 0, vectorCount: 0 },
    connected: false,
  };

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = K.$;
  function _buildEl() {
    return {
      tabs: {
        knowledge: $('tab-knowledge'),
        search: $('tab-search'),
        sessions: $('tab-sessions'),
        embeddings: $('tab-embeddings'),
      },
      views: {
        knowledge: $('view-knowledge'),
        search: $('view-search'),
        sessions: $('view-sessions'),
        embeddings: $('view-embeddings'),
      },
      knowledgeGrid: $('knowledge-grid'),
      knowledgeEmpty: $('knowledge-empty'),
      knowledgeCategories: $('knowledge-categories'),
      knowledgeSearchInput: $('knowledge-search-input'),
      knowledgeSearchResults: $('knowledge-search-results'),
      btnConsolidate: $('btn-consolidate'),
      btnReflect: $('btn-reflect'),
      btnGodNodes: $('btn-god-nodes'),
      btnBridges: $('btn-bridges'),
      btnGaps: $('btn-gaps'),
      btnBrief: $('btn-brief'),
      searchInput: $('search-input'),
      searchResults: $('search-results'),
      searchEmpty: $('search-empty'),
      searchRoleFilters: $('search-role-filters'),
      modeRanked: $('mode-ranked'),
      modeSemantic: $('mode-semantic'),
      modeRegex: $('mode-regex'),
      sessionsList: $('sessions-list'),
      sessionsEmpty: $('sessions-empty'),
      sessionProjectFilter: $('session-project-filter'),
      searchScopes: $('search-scopes'),
      sidePanel: $('side-panel'),
      panelTitle: $('panel-title'),
      panelBody: $('panel-body'),
      panelClose: $('panel-close'),
      connectionStatus: $('connection-status'),
      statKnowledge: $('stat-knowledge'),
      statSessions: $('stat-sessions'),
      statVectors: $('stat-vectors'),
      embeddingsStatsGrid: $('embedding-stats-grid'),
      embeddingsEmpty: $('embeddings-empty'),
      embeddingsStatus: $('embeddings-status'),
      themeToggle: $('theme-toggle'),
      version: $('version'),
      loadingOverlay: $('loading-overlay'),
      toastContainer: $('toast-container'),
      contentWrapper: $('content-wrapper'),
    };
  }
  let el = _buildEl();

  // Expose state and el for module access
  K._state = state;
  K._el = el;

  // ── Stats ──────────────────────────────────────────────────────────────────

  function updateStats() {
    el.statKnowledge.querySelector('.stat-value').textContent = state.stats.knowledgeCount;
    el.statSessions.querySelector('.stat-value').textContent = state.stats.sessionCount;
    el.statVectors.querySelector('.stat-value').textContent = state.stats.vectorCount;
  }

  K.updateStats = function (s, e) {
    // Allow modules to call with their own refs, but always use canonical state
    el.statKnowledge.querySelector('.stat-value').textContent = state.stats.knowledgeCount;
    el.statSessions.querySelector('.stat-value').textContent = state.stats.sessionCount;
    el.statVectors.querySelector('.stat-value').textContent = state.stats.vectorCount;
  };

  // ── WebSocket ──────────────────────────────────────────────────────────────

  let ws = null;
  let wsRetry = null;

  function wsConnect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${K._wsUrl || location.host}`);

    ws.addEventListener('open', () => {
      state.connected = true;
      updateConnectionStatus();
      el.loadingOverlay.classList.add('hidden');
      if (wsRetry) {
        clearTimeout(wsRetry);
        wsRetry = null;
      }
    });

    ws.addEventListener('message', (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        handleWsMessage(msg);
      } catch {
        /* ignore non-json */
      }
    });

    ws.addEventListener('close', () => {
      state.connected = false;
      updateConnectionStatus();
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      state.connected = false;
      updateConnectionStatus();
    });
  }

  function scheduleReconnect() {
    if (wsRetry) return;
    wsRetry = setTimeout(() => {
      wsRetry = null;
      wsConnect();
    }, 3000);
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'reload':
        location.reload();
        return;
      case 'state':
        if (msg.knowledge) {
          state.knowledge.entries = msg.knowledge;
          K.renderKnowledge(state, el);
        }
        if (msg.sessions) {
          state.sessions.list = msg.sessions;
          state.sessions.offset = msg.sessions.length;
          state.sessions.allLoaded = true;
          K.renderSessions(state, el);
        }
        if (msg.stats) {
          state.stats.knowledgeCount = msg.stats.knowledge_entries || 0;
          state.stats.sessionCount = msg.stats.session_count || 0;
          state.stats.vectorCount = msg.stats.vector_count || 0;
          if (msg.stats.version) el.version.textContent = 'v' + msg.stats.version;
          updateStats();
        }
        el.loadingOverlay.classList.add('hidden');
        break;
      case 'knowledge:update':
      case 'knowledge:change':
        K.loadKnowledge(state, el);
        break;
      case 'session:update':
      case 'session:new':
        K.loadSessions(state, el);
        break;
      case 'stats':
        if (msg.data) {
          if (msg.data.knowledgeCount != null) state.stats.knowledgeCount = msg.data.knowledgeCount;
          if (msg.data.sessionCount != null) state.stats.sessionCount = msg.data.sessionCount;
          if (msg.data.vectorCount != null) state.stats.vectorCount = msg.data.vectorCount;
          updateStats();
        }
        break;
      case 'version':
        if (msg.data) el.version.textContent = msg.data;
        break;
      default:
        break;
    }
  }

  function updateConnectionStatus() {
    const s = el.connectionStatus;
    if (state.connected) {
      s.className = 'status-badge connected';
      s.textContent = 'Connected';
    } else {
      s.className = 'status-badge disconnected';
      s.textContent = 'Disconnected';
    }
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────

  function switchTab(name, updateHash = true) {
    if (state.activeTab === name) return;
    state.activeTab = name;
    if (updateHash && K._root === document) location.hash = '#' + name;

    Object.keys(el.tabs).forEach((k) => {
      const active = k === name;
      el.tabs[k].classList.toggle('active', active);
      el.tabs[k].setAttribute('aria-selected', active);
    });

    Object.keys(el.views).forEach((k) => {
      const active = k === name;
      el.views[k].classList.toggle('active', active);
      el.views[k].hidden = !active;
    });

    // Close side panel on tab switch
    if (state.panel.open) K.closePanel();

    if (name === 'knowledge' && state.knowledge.entries.length === 0) K.loadKnowledge(state, el);
    if (name === 'sessions' && state.sessions.list.length === 0) K.loadSessions(state, el);
    if (name === 'embeddings') K.loadEmbeddingStats(state, el);
  }

  // ── Create debounced search functions ─────────────────────────────────────

  const doKnowledgeSearch = K.createKnowledgeSearch(state, el);
  const doSearch = K.createSearch(state, el);

  // ── Event Binding ──────────────────────────────────────────────────────────

  function bindEvents() {
    // Tabs
    Object.keys(el.tabs).forEach((k) => {
      el.tabs[k].addEventListener('click', () => switchTab(k));
    });

    // Theme
    el.themeToggle.addEventListener('click', K.toggleTheme);

    // Panel close
    el.panelClose.addEventListener('click', K.closePanel);

    // Knowledge category chips
    el.knowledgeCategories.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      el.knowledgeCategories.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.knowledge.activeCategory = chip.dataset.category;
      K.renderKnowledge(state, el);
    });

    if (el.btnConsolidate) {
      el.btnConsolidate.addEventListener('click', () => K.loadConsolidate(state, el));
    }
    if (el.btnReflect) {
      el.btnReflect.addEventListener('click', () => K.loadReflect());
    }
    if (el.btnGodNodes) {
      el.btnGodNodes.addEventListener('click', () => K.loadGodNodes());
    }
    if (el.btnBridges) {
      el.btnBridges.addEventListener('click', () => K.loadBridges());
    }
    if (el.btnGaps) {
      el.btnGaps.addEventListener('click', () => K.loadGaps());
    }
    if (el.btnBrief) {
      el.btnBrief.addEventListener('click', () => K.loadBrief());
    }

    if (el.knowledgeSearchInput) {
      el.knowledgeSearchInput.addEventListener('input', () => {
        doKnowledgeSearch();
      });
    }

    // Search input
    el.searchInput.addEventListener('input', () => {
      state.search.query = el.searchInput.value;
      doSearch();
    });

    // Search role filters
    el.searchRoleFilters.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      el.searchRoleFilters.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.search.role = chip.dataset.role;
      if (state.search.query.trim()) doSearch();
    });

    function setSearchMode(mode) {
      el.modeRanked.classList.toggle('active', mode === 'ranked');
      el.modeSemantic.classList.toggle('active', mode === 'semantic');
      el.modeRegex.classList.toggle('active', mode === 'regex');
      state.search.ranked = mode !== 'regex';
      state.search.semantic = mode === 'semantic';
      if (state.search.query.trim()) doSearch();
    }

    el.modeRanked.addEventListener('click', () => setSearchMode('ranked'));
    el.modeSemantic.addEventListener('click', () => setSearchMode('semantic'));
    el.modeRegex.addEventListener('click', () => setSearchMode('regex'));

    // Session project filter
    el.sessionProjectFilter.addEventListener('change', () => {
      state.sessions.projectFilter = el.sessionProjectFilter.value;
      K.resetSessionPagination(state);
      K.loadSessions(state, el);
    });

    // Search scope chips
    el.searchScopes.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      el.searchScopes.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.search.scope = chip.dataset.scope;
      if (state.search.query.trim()) doSearch();
    });

    // ── Delegated click/keydown handlers for morphed containers ──────────

    // Knowledge grid cards
    el.knowledgeGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.knowledge-card[data-path]');
      if (card) K.openKnowledgePanel(card.dataset.path);
    });
    el.knowledgeGrid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const card = e.target.closest('.knowledge-card[data-path]');
      if (card) K.openKnowledgePanel(card.dataset.path);
    });

    // Knowledge search results
    el.knowledgeSearchResults.addEventListener('click', (e) => {
      const card = e.target.closest('.knowledge-result-item[data-path]');
      if (card) K.openKnowledgePanel(card.dataset.path);
    });
    el.knowledgeSearchResults.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const card = e.target.closest('.knowledge-result-item[data-path]');
      if (card) K.openKnowledgePanel(card.dataset.path);
    });

    // Session cards
    el.sessionsList.addEventListener('click', (e) => {
      const card = e.target.closest('.session-card[data-session-id]');
      if (card) K.openSessionPanel(card.dataset.sessionId);
    });
    el.sessionsList.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const card = e.target.closest('.session-card[data-session-id]');
      if (card) K.openSessionPanel(card.dataset.sessionId);
    });

    // Search results
    el.searchResults.addEventListener('click', (e) => {
      const card = e.target.closest('.result-item[data-session-id]');
      if (card) K.openSessionPanel(card.dataset.sessionId, card.dataset.excerpt);
    });
    el.searchResults.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const card = e.target.closest('.result-item[data-session-id]');
      if (card) K.openSessionPanel(card.dataset.sessionId, card.dataset.excerpt);
    });

    // Panel body — related entries & knowledge links
    el.panelBody.addEventListener('click', (e) => {
      const entry = e.target.closest('.related-entry[data-path]');
      if (entry) K.openKnowledgePanel(entry.dataset.path);
    });
    el.panelBody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const entry = e.target.closest('.related-entry[data-path]');
      if (entry) K.openKnowledgePanel(entry.dataset.path);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape closes panel
      if (e.key === 'Escape' && state.panel.open) {
        e.preventDefault();
        K.closePanel();
        return;
      }

      // / or Ctrl+K focuses search
      if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) && !K.isInputFocused()) {
        e.preventDefault();
        switchTab('search');
        el.searchInput.focus();
      }
    });

    // Click outside panel to close
    el.contentWrapper.addEventListener('click', (e) => {
      if (state.panel.open && !el.sidePanel.contains(e.target)) {
        // Only close if clicking on the main content area backdrop
      }
    });
  }

  // ── Theme sync from parent (agent-desk) ───────────────────────────────────

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'theme-sync') return;
    const colors = event.data.colors;
    if (!colors) return;

    // Contrast enforcement: ensure text is readable against background
    function ensureContrast(bg, fg) {
      const lum = (hex) => {
        if (!hex || hex.charAt(0) !== '#' || hex.length < 7) return 0.5;
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const bgLum = lum(bg);
      return bgLum < 0.5 ? (lum(fg) < 0.4 ? '#e0e0e0' : fg) : lum(fg) > 0.6 ? '#333333' : fg;
    }

    const root = document.documentElement;
    const bgColor = colors.bg || null;

    // Core backgrounds
    if (colors.bg) root.style.setProperty('--bg', colors.bg);
    if (colors.bgSurface) root.style.setProperty('--bg-surface', colors.bgSurface);
    if (colors.bgElevated) root.style.setProperty('--bg-elevated', colors.bgElevated);
    if (colors.bgHover) root.style.setProperty('--bg-hover', colors.bgHover);
    if (colors.bgInset) root.style.setProperty('--bg-inset', colors.bgInset);

    // Borders
    if (colors.border) root.style.setProperty('--border', colors.border);
    if (colors.borderLight) root.style.setProperty('--border-light', colors.borderLight);

    // Text colors (with contrast enforcement)
    if (colors.text)
      root.style.setProperty(
        '--text',
        bgColor ? ensureContrast(bgColor, colors.text) : colors.text,
      );
    if (colors.textSecondary)
      root.style.setProperty(
        '--text-secondary',
        bgColor ? ensureContrast(bgColor, colors.textSecondary) : colors.textSecondary,
      );
    if (colors.textMuted)
      root.style.setProperty(
        '--text-muted',
        bgColor ? ensureContrast(bgColor, colors.textMuted) : colors.textMuted,
      );
    if (colors.textDim)
      root.style.setProperty(
        '--text-dim',
        bgColor ? ensureContrast(bgColor, colors.textDim) : colors.textDim,
      );

    // Accent colors
    if (colors.accent) root.style.setProperty('--accent', colors.accent);
    if (colors.accentHover) root.style.setProperty('--accent-hover', colors.accentHover);
    if (colors.accentDim) root.style.setProperty('--accent-dim', colors.accentDim);
    if (colors.accentSolid) root.style.setProperty('--accent-solid', colors.accentSolid);
    if (colors.accentGlow) root.style.setProperty('--accent-glow', colors.accentGlow);

    // Semantic colors
    if (colors.green) root.style.setProperty('--green', colors.green);
    if (colors.greenDim) root.style.setProperty('--green-dim', colors.greenDim);
    if (colors.yellow) root.style.setProperty('--yellow', colors.yellow);
    if (colors.yellowDim) root.style.setProperty('--yellow-dim', colors.yellowDim);
    if (colors.orange) root.style.setProperty('--orange', colors.orange);
    if (colors.orangeDim) root.style.setProperty('--orange-dim', colors.orangeDim);
    if (colors.red) root.style.setProperty('--red', colors.red);
    if (colors.redDim) root.style.setProperty('--red-dim', colors.redDim);
    if (colors.purple) root.style.setProperty('--purple', colors.purple);
    if (colors.purpleDim) root.style.setProperty('--purple-dim', colors.purpleDim);
    if (colors.blue) root.style.setProperty('--blue', colors.blue);
    if (colors.blueDim) root.style.setProperty('--blue-dim', colors.blueDim);

    // Focus ring
    if (colors.focusRing) root.style.setProperty('--focus-ring', colors.focusRing);

    // Shadows (adapt for dark/light)
    if (colors.isDark !== undefined) {
      if (colors.isDark) {
        root.style.setProperty(
          '--shadow-1',
          '0px 1px 2px 0px rgba(0,0,0,0.6), 0px 1px 3px 1px rgba(0,0,0,0.3)',
        );
        root.style.setProperty(
          '--shadow-2',
          '0px 1px 2px 0px rgba(0,0,0,0.6), 0px 2px 6px 2px rgba(0,0,0,0.3)',
        );
        root.style.setProperty(
          '--shadow-3',
          '0px 1px 3px 0px rgba(0,0,0,0.6), 0px 4px 8px 3px rgba(0,0,0,0.3)',
        );
        root.style.setProperty(
          '--shadow-hover',
          '0px 2px 4px 0px rgba(0,0,0,0.5), 0px 4px 12px 4px rgba(0,0,0,0.3)',
        );
        root.style.setProperty(
          '--shadow-panel',
          '-2px 0px 8px 0px rgba(0,0,0,0.6), -4px 0px 16px 2px rgba(0,0,0,0.3)',
        );
      } else {
        root.style.setProperty(
          '--shadow-1',
          '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 1px 3px 1px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-2',
          '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 2px 6px 2px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-3',
          '0px 1px 3px 0px rgba(0,0,0,0.3), 0px 4px 8px 3px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-hover',
          '0px 2px 4px 0px rgba(0,0,0,0.25), 0px 4px 12px 4px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-panel',
          '-2px 0px 8px 0px rgba(0,0,0,0.3), -4px 0px 16px 2px rgba(0,0,0,0.15)',
        );
      }
    }

    // Apply theme attribute and hide the toggle (agent-desk controls the theme)
    if (colors.isDark !== undefined) {
      const theme = colors.isDark ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('agent-knowledge-theme', theme);
      const icon = el.themeToggle.querySelector('.theme-icon');
      if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
    }

    // Hide the local theme toggle — agent-desk controls the theme
    if (el.themeToggle) el.themeToggle.style.display = 'none';
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    try {
      el = _buildEl();
      K._el = el;
      K._state = state;
    } catch (err) {
      console.error('[agent-knowledge] init _buildEl failed:', err);
    }
    K.initTheme();
    bindEvents();
    K.initSessionScroll(state, el);
    wsConnect();

    // Restore tab from URL hash (standalone mode only)
    if (K._root === document) {
      const hash = location.hash.replace('#', '');
      const validTabs = Object.keys(el.tabs);
      if (hash && validTabs.includes(hash)) {
        switchTab(hash, false);
      }

      // Listen for back/forward navigation
      window.addEventListener('hashchange', () => {
        const h = location.hash.replace('#', '');
        if (h && validTabs.includes(h)) switchTab(h, false);
      });
    }

    // Load initial data in parallel
    try {
      await Promise.allSettled([K.loadKnowledge(state, el), K.loadEmbeddingStats(state, el)]);
    } catch {
      // individual loaders handle their own errors
    }

    // Hide loading overlay after a short delay if ws hasn't connected
    setTimeout(() => {
      el.loadingOverlay.classList.add('hidden');
    }, 2000);
  }

  // ── Plugin mount / unmount ─────────────────────────────────────────────────

  K.mount = function (container, options) {
    options = options || {};
    K._baseUrl = options.baseUrl || '';
    K._wsUrl = options.wsUrl || null;

    var shadow = container.attachShadow({ mode: 'open' });

    if (options.cssUrl) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = options.cssUrl;
      shadow.appendChild(link);
    }

    var fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href =
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap';
    shadow.appendChild(fonts);
    var icons = document.createElement('link');
    icons.rel = 'stylesheet';
    icons.href =
      'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap';
    shadow.appendChild(icons);

    var pluginStyle = document.createElement('style');
    pluginStyle.textContent =
      ':host { display:block; width:100%; height:100%; overflow:hidden; }' +
      '.ak-wrapper { font-family:var(--font-sans); font-size:14px; color:var(--text); background:var(--bg); line-height:1.5; width:100%; height:100%; overflow:hidden; display:flex; flex-direction:column; }';
    shadow.appendChild(pluginStyle);

    if (typeof K._template === 'function') {
      var wrapper = document.createElement('div');
      wrapper.className = 'ak-wrapper';
      wrapper.setAttribute('data-theme', 'dark');
      wrapper.innerHTML = K._template();
      shadow.appendChild(wrapper);
    }

    K._root = shadow;
    init();
    K.initPanelResize();
    var themeBtn = shadow.getElementById('theme-toggle');
    if (themeBtn) themeBtn.style.display = 'none';
  };

  K.unmount = function () {
    if (ws) {
      ws.close();
      ws = null;
    }
    if (wsRetry) {
      clearTimeout(wsRetry);
      wsRetry = null;
    }
    state.connected = false;
    K._root = document;
  };

  var _params = new URLSearchParams(location.search);
  if (_params.get('baseUrl')) K._baseUrl = _params.get('baseUrl');
  if (_params.get('wsUrl')) K._wsUrl = _params.get('wsUrl');

  // Start (standalone mode)
  if (typeof K._template !== 'function') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        init();
        K.initPanelResize();
      });
    } else {
      init();
      K.initPanelResize();
    }
  }
})();
