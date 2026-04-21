/* agent-knowledge dashboard — main entry point */
(function () {
  'use strict';

  const K = window.Knowledge;

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    activeTab: 'knowledge',
    knowledge: {
      entries: [],
      activeCategory: 'all',
      duplicateClusters: {},
      // v1.8.1: when true, the grid is filtered to entries whose
      // `last_accessed` is null or older than 90 days.
      onlyUnused: false,
    },
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
    lastEventId: 0,
  };

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = K.$;
  function _buildEl() {
    return {
      tabs: {
        knowledge: $('tab-knowledge'),
        search: $('tab-search'),
        sessions: $('tab-sessions'),
        graph: $('tab-graph'),
        embeddings: $('tab-embeddings'),
      },
      views: {
        knowledge: $('view-knowledge'),
        search: $('view-search'),
        sessions: $('view-sessions'),
        graph: $('view-graph'),
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
        if (Array.isArray(msg.events)) handleEvents(msg.events);
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

  // ── Toast notifications ────────────────────────────────────────────────────
  // Events pushed by POST /api/events ride along in the WS state payload as
  // `state.events = [...ring]`. On the first state delivery we only record
  // the head id and skip rendering — otherwise a reconnect would replay the
  // last 10 toasts. Subsequent deliveries render any event whose id is newer
  // than the cursor.

  function handleEvents(events) {
    const firstDelivery = state.lastEventId === 0;
    let maxId = state.lastEventId;
    for (const evt of events) {
      if (!evt || typeof evt.id !== 'number') continue;
      if (evt.id > maxId) maxId = evt.id;
      if (!firstDelivery && evt.id > state.lastEventId) showToast(evt);
    }
    state.lastEventId = maxId;
  }

  function toastContainer() {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  function showToast(evt) {
    const container = toastContainer();
    const t = document.createElement('div');
    t.className = 'toast toast--' + (evt.kind || 'info').replace(/[^a-z0-9-]/gi, '-');
    const kind = document.createElement('div');
    kind.className = 'toast__kind';
    kind.textContent = evt.kind || 'info';
    const msg = document.createElement('div');
    msg.className = 'toast__message';
    msg.textContent = evt.message || '';
    t.appendChild(kind);
    t.appendChild(msg);
    container.appendChild(t);

    // Trigger slide-in on next frame
    requestAnimationFrame(() => t.classList.add('toast--visible'));

    const dismiss = () => {
      t.classList.remove('toast--visible');
      setTimeout(() => t.remove(), 250);
    };
    t.addEventListener('click', dismiss);
    setTimeout(dismiss, 6000);
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
    if (name === 'graph') {
      // vis.js needs the container to be visible and laid out before rendering
      requestAnimationFrame(() => K.renderGraph(el));
    }
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

  // ── v1.8.1 Knowledge extras: unused filter, by-type chart, pin+author ─────
  //
  // The original renderer lives in render-knowledge.js. To avoid touching that
  // file, we wrap K.renderKnowledge once at init time. The wrapper:
  //  1. optionally filters the entries list by the "Unused 90d+" toggle,
  //  2. delegates to the original renderer,
  //  3. post-processes each rendered card to inject the pin badge
  //     (for `evergreen: true`) and the `by <author>` footer tag,
  //  4. refreshes the "By Type" bar chart and the filter-button count.

  // Per-category recency windows (days). A flat 30d default penalised
  // long-lived categories like `people` and `projects` that are correctly
  // consulted rarely; 30d worked for `notes` but was far too tight for
  // identity-shaped content. Values are tuned for the typical-use shape:
  // people change rarely, project/decision entries live long, notes are
  // ephemeral scratch.
  const CATEGORY_RECENT_DAYS = {
    projects: 180,
    people: 365,
    decisions: 90,
    workflows: 60,
    notes: 30,
  };
  const CATEGORY_UNUSED_DAYS = {
    projects: 365,
    people: 730,
    decisions: 180,
    workflows: 120,
    notes: 90,
  };
  const DEFAULT_RECENT_DAYS = 30;
  const DEFAULT_UNUSED_DAYS = 90;
  const CATEGORY_ORDER = ['projects', 'people', 'decisions', 'workflows', 'notes'];
  const CATEGORY_ICONS = {
    projects: 'code',
    people: 'group',
    decisions: 'gavel',
    workflows: 'account_tree',
    notes: 'sticky_note_2',
  };

  function recentDaysFor(entry) {
    return CATEGORY_RECENT_DAYS[entry.category] ?? DEFAULT_RECENT_DAYS;
  }

  function unusedDaysFor(entry) {
    return CATEGORY_UNUSED_DAYS[entry.category] ?? DEFAULT_UNUSED_DAYS;
  }

  function isOlderThan(entry, days) {
    const la = entry.last_accessed;
    if (!la) return true;
    const t = new Date(la).getTime();
    if (!Number.isFinite(t)) return true;
    return Date.now() - t > days * 24 * 60 * 60 * 1000;
  }

  // Kept for call sites that pass an explicit day count (filter, etc.).
  function isUnused(entry, days) {
    return isOlderThan(entry, days ?? unusedDaysFor(entry));
  }

  function countUnused(entries) {
    let n = 0;
    for (const e of entries) if (isOlderThan(e, unusedDaysFor(e))) n++;
    return n;
  }

  function ensureUnusedButton() {
    if (!el.knowledgeCategories) return null;
    let btn = el.knowledgeCategories.querySelector('#btn-unused-filter');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = 'btn-unused-filter';
    btn.type = 'button';
    btn.className = 'unused-filter-btn';
    btn.title = 'Show only entries not accessed in the last 90 days';
    btn.innerHTML =
      '<span class="material-symbols-outlined">schedule</span>' +
      '<span class="unused-label">Unused (0)</span>';
    btn.addEventListener('click', () => {
      state.knowledge.onlyUnused = !state.knowledge.onlyUnused;
      btn.classList.toggle('active', state.knowledge.onlyUnused);
      K.renderKnowledge(state, el);
    });
    el.knowledgeCategories.appendChild(btn);
    return btn;
  }

  function updateUnusedButton(unusedCount) {
    const btn = ensureUnusedButton();
    if (!btn) return;
    const label = btn.querySelector('.unused-label');
    if (label) label.textContent = 'Unused (' + unusedCount + ')';
    btn.classList.toggle('active', !!state.knowledge.onlyUnused);
    btn.hidden = unusedCount === 0 && !state.knowledge.onlyUnused;
  }

  function ensureBytypePanel() {
    if (!el.knowledgeGrid || !el.knowledgeGrid.parentNode) return null;
    let panel = K._root.getElementById('knowledge-bytype');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'knowledge-bytype';
    panel.className = 'bytype-panel';
    panel.setAttribute('aria-label', 'Access count by category');
    panel.innerHTML =
      '<div class="bytype-panel-header">' +
      '<span class="bytype-title">By Type</span>' +
      '<span class="bytype-legend">' +
      '<span class="bytype-legend-item">' +
      '<span class="bytype-legend-swatch recent"></span>' +
      'Accessed 30d' +
      '</span>' +
      '<span class="bytype-legend-item">' +
      '<span class="bytype-legend-swatch unused"></span>' +
      'Unused 30d+' +
      '</span>' +
      '</span>' +
      '</div>' +
      '<div class="bytype-rows" id="knowledge-bytype-rows"></div>';
    // Insert BEFORE the search bar so it sits in the stats area above the grid.
    const searchBar = el.knowledgeGrid.parentNode.querySelector('.knowledge-search-bar');
    const anchor = searchBar || el.knowledgeGrid;
    anchor.parentNode.insertBefore(panel, anchor);
    return panel;
  }

  function renderBytypeChart(entries) {
    const panel = ensureBytypePanel();
    if (!panel) return;
    const rowsEl = panel.querySelector('#knowledge-bytype-rows');
    if (!rowsEl) return;

    const buckets = {};
    for (const cat of CATEGORY_ORDER) buckets[cat] = { recent: 0, unused: 0 };
    for (const e of entries) {
      const cat = e.category || 'notes';
      if (!buckets[cat]) buckets[cat] = { recent: 0, unused: 0 };
      // Per-category recency window — people/projects are consulted less
      // often by design, so the 30d default would wrongly paint them stale.
      if (isOlderThan(e, recentDaysFor(e))) buckets[cat].unused++;
      else buckets[cat].recent++;
    }

    const rows = CATEGORY_ORDER.map((cat) => {
      const b = buckets[cat];
      const total = b.recent + b.unused;
      // Row-normalized: each bar sums to 100% within its row so the visual
      // answers "how stale is this category?" without misleading gray filler.
      // Cross-category volume stays readable via the right-side counts.
      const denom = total || 1;
      const recentPct = (b.recent / denom) * 100;
      const unusedPct = (b.unused / denom) * 100;
      const icon = CATEGORY_ICONS[cat] || 'article';
      const bar = total
        ? '<span class="bytype-bar-recent" style="width:' +
          recentPct.toFixed(1) +
          '%"></span>' +
          '<span class="bytype-bar-unused" style="width:' +
          unusedPct.toFixed(1) +
          '%"></span>'
        : '<span class="bytype-bar-empty"></span>';
      return (
        '<div class="bytype-row-label">' +
        '<span class="material-symbols-outlined">' +
        icon +
        '</span>' +
        K.esc(cat) +
        '</div>' +
        '<div class="bytype-bar" role="img" aria-label="' +
        K.esc(cat) +
        ': ' +
        b.recent +
        ' recent, ' +
        b.unused +
        ' unused">' +
        bar +
        '</div>' +
        '<div class="bytype-row-count">' +
        '<span class="count-recent">' +
        b.recent +
        '</span>' +
        '<span class="count-sep">/</span>' +
        '<span class="count-unused">' +
        b.unused +
        '</span>' +
        '</div>'
      );
    }).join('');
    K.morph(rowsEl, rows);
  }

  function decorateCards(entries) {
    if (!el.knowledgeGrid) return;
    const byPath = new Map();
    for (const e of entries) byPath.set(e.path || e.id || '', e);
    const cards = el.knowledgeGrid.querySelectorAll('.knowledge-card[data-path]');
    cards.forEach((card) => {
      const entry = byPath.get(card.getAttribute('data-path'));
      if (!entry) return;

      // Pin badge for evergreen entries — Material Symbols "push_pin".
      const rightSlot = card.querySelector('.card-header-row > div');
      if (rightSlot && entry.evergreen === true) {
        if (!rightSlot.querySelector('.pin-badge')) {
          const pin = document.createElement('span');
          pin.className = 'pin-badge';
          pin.title = 'Evergreen — exempt from decay';
          pin.setAttribute('aria-label', 'Evergreen entry');
          pin.innerHTML = '<span class="material-symbols-outlined">push_pin</span>';
          rightSlot.insertBefore(pin, rightSlot.firstChild);
        }
      }

      // Author footer tag — only if frontmatter provided one.
      if (entry.author && typeof entry.author === 'string') {
        if (!card.querySelector('.card-author')) {
          const tag = document.createElement('span');
          tag.className = 'card-author';
          tag.title = 'Author';
          tag.textContent = entry.author;
          card.appendChild(tag);
        }
      }
    });
  }

  function installKnowledgeEnhancements() {
    const original = K.renderKnowledge;
    if (!original || original.__v181wrapped) return;

    const wrapped = function (s, e) {
      const entries = s.knowledge.entries || [];
      const unusedCount = countUnused(entries);

      // Apply the "unused only" filter at the source — the inner renderer
      // still does its own category filter on top of this.
      const original_entries = s.knowledge.entries;
      if (s.knowledge.onlyUnused) {
        s.knowledge.entries = entries.filter((x) => isOlderThan(x, unusedDaysFor(x)));
      }
      try {
        original(s, e);
      } finally {
        s.knowledge.entries = original_entries;
      }

      renderBytypeChart(entries);
      updateUnusedButton(unusedCount);
      decorateCards(
        s.knowledge.onlyUnused
          ? s.knowledge.entries.filter((x) => isOlderThan(x, unusedDaysFor(x)))
          : entries,
      );
    };
    wrapped.__v181wrapped = true;
    K.renderKnowledge = wrapped;
  }

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
    if (K.setupGraphControls) K.setupGraphControls();
    installKnowledgeEnhancements();
    ensureUnusedButton();
    ensureBytypePanel();
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
