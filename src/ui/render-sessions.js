/* agent-knowledge — sessions tab rendering */
(function () {
  'use strict';

  const K = window.Knowledge;

  const PAGE_SIZE = 30;

  // ── Load sessions from API (paginated) ────────────────────────────────────

  async function loadSessions(state, el) {
    if (state.sessions.loading) return;
    if (state.sessions.allLoaded) return;
    state.sessions.loading = true;
    const offset = state.sessions.offset || 0;
    const isFirstPage = offset === 0;
    showLoadingIndicator(el, true);
    try {
      const filter = state.sessions.projectFilter;
      let url = `/sessions?limit=${PAGE_SIZE}&offset=${offset}`;
      if (filter) url += `&project=${encodeURIComponent(filter)}`;
      const data = await K.api(url);
      const page = Array.isArray(data) ? data : data.sessions || [];
      const total = !Array.isArray(data) && typeof data.total === 'number' ? data.total : null;

      if (isFirstPage) {
        state.sessions.list = page;
      } else {
        state.sessions.list = state.sessions.list.concat(page);
      }

      state.sessions.offset = offset + page.length;
      state.sessions.allLoaded = page.length < PAGE_SIZE;
      if (total !== null) state.sessions.total = total;
      state.stats.sessionCount = state.sessions.total ?? state.sessions.list.length;
      K.updateStats(state, el);
      updateProjectFilter(state.sessions.list, el);
      renderSessions(state, el);
    } catch (err) {
      K.toast(`Failed to load sessions: ${err.message}`, 'error');
    }
    state.sessions.loading = false;
    showLoadingIndicator(el, false);
  }

  function resetSessionPagination(state) {
    state.sessions.list = [];
    state.sessions.offset = 0;
    state.sessions.allLoaded = false;
  }

  // ── Loading indicator ─────────────────────────────────────────────────────

  function showLoadingIndicator(el, show) {
    let indicator = K._root.getElementById('sessions-load-more');
    if (show) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'sessions-load-more';
        indicator.className = 'sessions-load-more';
        indicator.innerHTML =
          '<span class="sessions-spinner"></span><span>Loading more\u2026</span>';
        el.sessionsList.parentNode.insertBefore(indicator, el.sessionsEmpty);
      }
      indicator.classList.remove('hidden');
    } else if (indicator) {
      indicator.classList.add('hidden');
    }
  }

  // ── Scroll-based pagination ───────────────────────────────────────────────

  function initSessionScroll(state, el) {
    const content = K._root.getElementById('content');
    if (!content) return;
    content.addEventListener('scroll', () => {
      if (state.sessions.loading || state.sessions.allLoaded) return;
      const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 200;
      if (nearBottom) loadSessions(state, el);
    });
  }

  // ── Populate project filter dropdown ──────────────────────────────────────

  function updateProjectFilter(sessions, el) {
    const projects = [...new Set(sessions.map((s) => s.project).filter(Boolean))].sort();
    const sel = el.sessionProjectFilter;
    const current = sel.value;
    K.morph(
      sel,
      '<option value="">All projects</option>' +
        projects.map((p) => `<option value="${K.esc(p)}">${K.esc(p)}</option>`).join(''),
    );
    sel.value = current;
  }

  // ── Render session list ───────────────────────────────────────────────────

  function renderSessions(state, el) {
    const filter = state.sessions.projectFilter;
    const list = filter
      ? state.sessions.list.filter((s) => s.project === filter)
      : state.sessions.list;

    if (list.length === 0) {
      K.morph(el.sessionsList, '');
      el.sessionsEmpty.classList.remove('hidden');
      return;
    }

    el.sessionsEmpty.classList.add('hidden');
    K.morph(
      el.sessionsList,
      list
        .map((s) => {
          const id = s.sessionId || s.id || '';
          const project = s.project || '';
          const branch = s.branch || s.gitBranch || s.git_branch || '';
          const count = s.messageCount || s.message_count || s.count || 0;
          const date = s.startTime || s.date || s.created || s.startedAt || '';
          const preview = s.preview || '';
          const time = K.relativeTime(date);
          const dateStr = date
            ? new Date(date).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : '';

          const title = preview
            ? preview.length > 80
              ? preview.slice(0, 80) + '\u2026'
              : preview
            : id.slice(0, 8);

          return `<div class="session-card" data-session-id="${K.esc(id)}" tabindex="0" role="button">
        <div class="session-header">
          <span class="session-title">${K.esc(title)}</span>
          <span class="session-date">${dateStr || time || ''}</span>
        </div>
        <div class="session-meta">
          <span class="session-meta-item"><span class="material-symbols-outlined">folder</span>${K.esc(project)}</span>
          ${branch ? `<span class="session-meta-item"><span class="material-symbols-outlined">alt_route</span>${K.esc(branch)}</span>` : ''}
          <span class="session-meta-item"><span class="material-symbols-outlined">chat</span>${count} messages</span>
          <span class="session-meta-item"><span class="material-symbols-outlined">tag</span>${K.esc(id.slice(0, 8))}</span>
        </div>
      </div>`;
        })
        .join(''),
    );
  }

  // ── Open session in side panel ────────────────────────────────────────────

  async function openSessionPanel(sessionId, searchExcerpt) {
    if (!sessionId) return;
    try {
      const [session, summary] = await Promise.allSettled([
        K.api(`/sessions/${encodeURIComponent(sessionId)}`),
        K.api(`/sessions/${encodeURIComponent(sessionId)}/summary`),
      ]);
      const sData = session.status === 'fulfilled' ? session.value : {};
      const sumData = summary.status === 'fulfilled' ? summary.value : null;
      K.openPanel('session', { session: sData, summary: sumData, sessionId, searchExcerpt });
    } catch (err) {
      K.toast(`Failed to load session: ${err.message}`, 'error');
    }
  }

  // ── Embeddings ────────────────────────────────────────────────────────────

  async function loadEmbeddingStats(state, el) {
    try {
      const data = await K.api('/index-status');
      state.embeddings.stats = data;
      renderEmbeddingStats(state, el);
      el.statVectors.querySelector('.stat-value').textContent = data.totalEntries || 0;
    } catch {
      state.embeddings.stats = null;
      renderEmbeddingStats(state, el);
    }
  }

  function renderEmbeddingStats(state, el) {
    const stats = state.embeddings.stats;
    if (!stats || !stats.totalEntries) {
      K.morph(el.embeddingsStatsGrid, '');
      el.embeddingsStatus.style.display = 'none';
      el.embeddingsEmpty.classList.remove('hidden');
      return;
    }

    el.embeddingsEmpty.classList.add('hidden');
    el.embeddingsStatus.style.display = '';

    const cards = [
      { label: 'Provider', value: stats.provider || 'Not configured', detail: '' },
      { label: 'Dimensions', value: stats.dimensions || 0, detail: 'vector size' },
      { label: 'Total Chunks', value: stats.totalEntries || 0, detail: 'indexed chunks' },
      { label: 'Knowledge', value: stats.knowledgeEntries || 0, detail: 'knowledge chunks' },
      {
        label: 'Sessions',
        value: stats.uniqueSessions || 0,
        detail: `${stats.sessionEntries || 0} chunks`,
      },
      { label: 'DB Size', value: (stats.dbSizeMB || 0).toFixed(1) + ' MB', detail: 'on disk' },
    ];

    K.morph(
      el.embeddingsStatsGrid,
      cards
        .map(
          (c) => `
      <div class="embedding-stat-card">
        <span class="stat-label">${K.esc(c.label)}</span>
        <span class="stat-number">${K.esc(String(c.value))}</span>
        ${c.detail ? `<span class="stat-detail">${K.esc(c.detail)}</span>` : ''}
      </div>
    `,
        )
        .join(''),
    );
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  Object.assign(K, {
    loadSessions,
    renderSessions,
    resetSessionPagination,
    initSessionScroll,
    openSessionPanel,
    loadEmbeddingStats,
    renderEmbeddingStats,
  });
})();
