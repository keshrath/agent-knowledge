/* agent-knowledge — knowledge tab rendering */
(function () {
  'use strict';

  const K = window.Knowledge;

  // ── Render knowledge grid ─────────────────────────────────────────────────

  function renderKnowledge(state, el) {
    const cat = state.knowledge.activeCategory;
    const filtered =
      cat === 'all'
        ? state.knowledge.entries
        : state.knowledge.entries.filter((e) => e.category === cat);

    if (filtered.length === 0) {
      K.morph(el.knowledgeGrid, '');
      el.knowledgeEmpty.classList.remove('hidden');
      return;
    }

    el.knowledgeEmpty.classList.add('hidden');
    K.morph(
      el.knowledgeGrid,
      filtered
        .map((entry) => {
          const cat = entry.category || 'notes';
          const catIcons = {
            projects: 'code',
            people: 'group',
            decisions: 'gavel',
            workflows: 'account_tree',
            notes: 'sticky_note_2',
          };
          const icon = catIcons[cat] || 'article';
          const title = entry.title || entry.path || entry.id || 'Untitled';
          const tags = (entry.tags || [])
            .slice(0, 3)
            .map((t) => `<span class="card-tag">${K.esc(t)}</span>`)
            .join('');
          const time = K.relativeTime(entry.updated || entry.created);

          const maturity = entry.maturity || 'candidate';
          const accessCount = entry.access_count || 0;
          const hasDuplicates = !!state.knowledge.duplicateClusters[entry.path || ''];

          return `<div class="knowledge-card${hasDuplicates ? ' has-duplicates' : ''}" data-path="${K.esc(entry.path || entry.id || '')}" tabindex="0" role="button">
        <div class="card-header-row">
          <span class="card-category" data-cat="${K.esc(cat)}">
            <span class="material-symbols-outlined" style="font-size:14px">${icon}</span>
            ${K.esc(cat)}
          </span>
          <div style="display:flex;align-items:center;gap:4px">
            ${hasDuplicates ? '<span class="material-symbols-outlined duplicate-warn" title="Potential duplicate detected" style="font-size:16px;color:var(--warning)">content_copy</span>' : ''}
            <span class="maturity-badge" data-maturity="${K.esc(maturity)}">${K.esc(maturity)}${accessCount > 0 ? ` <span class="maturity-reads">&middot; ${accessCount} reads</span>` : ''}</span>
          </div>
        </div>
        ${time ? `<span class="card-date">${time}</span>` : ''}
        <div class="card-title">${K.esc(title)}</div>
        ${tags ? `<div class="card-tags">${tags}</div>` : ''}
      </div>`;
        })
        .join(''),
    );
  }

  // ── Knowledge search ──────────────────────────────────────────────────────

  function createKnowledgeSearch(state, el) {
    return K.debounce(async () => {
      const q = (el.knowledgeSearchInput ? el.knowledgeSearchInput.value : '').trim();
      if (!q) {
        el.knowledgeSearchResults.style.display = 'none';
        el.knowledgeGrid.style.display = '';
        el.knowledgeEmpty.classList.add('hidden');
        renderKnowledge(state, el);
        return;
      }
      try {
        const params = new URLSearchParams({ q, max_results: '20' });
        const cat = state.knowledge.activeCategory;
        if (cat !== 'all') params.set('category', cat);
        const results = await K.api(`/knowledge/search?${params}`);
        renderKnowledgeSearchResults(Array.isArray(results) ? results : [], q, el);
      } catch (err) {
        K.toast(`Knowledge search failed: ${err.message}`, 'error');
      }
    }, 300);
  }

  function renderKnowledgeSearchResults(results, query, el) {
    if (results.length === 0) {
      el.knowledgeSearchResults.style.display = 'none';
      el.knowledgeGrid.style.display = 'none';
      el.knowledgeEmpty.classList.remove('hidden');
      el.knowledgeEmpty.querySelector('.empty-text').textContent = 'No results found';
      el.knowledgeEmpty.querySelector('.empty-hint').textContent =
        `No knowledge entries match "${query}"`;
      return;
    }

    el.knowledgeEmpty.classList.add('hidden');
    el.knowledgeGrid.style.display = 'none';
    el.knowledgeSearchResults.style.display = '';
    K.morph(
      el.knowledgeSearchResults,
      results
        .map((r) => {
          const title = r.title || r.path || '';
          const excerpt = r.excerpt || '';
          const score = r.score;
          const maturity = r.maturity || 'candidate';
          const accessCount = r.access_count || 0;
          const decayF = r.decay_factor;
          const matMult = r.maturity_multiplier;
          const path = r.path || '';

          let scoreBreakdown = '';
          if (score != null) {
            const parts = [];
            parts.push(`relevance: ${score.toFixed(2)}`);
            if (decayF != null) parts.push(`decay: ${decayF.toFixed(2)}`);
            if (matMult != null) parts.push(`maturity: x${matMult.toFixed(1)}`);
            const finalScore = score * (decayF || 1) * (matMult || 1);
            scoreBreakdown = `<div class="score-breakdown">Score: ${finalScore.toFixed(2)} (${parts.join(' \u00d7 ')})</div>`;
          }

          return `<div class="result-item knowledge-result-item" data-path="${K.esc(path)}" tabindex="0" role="button">
          <div class="result-meta">
            <span class="maturity-badge" data-maturity="${K.esc(maturity)}">${K.esc(maturity)}${accessCount > 0 ? ` <span class="maturity-reads">&middot; ${accessCount} reads</span>` : ''}</span>
            <span class="result-entry-title">${K.esc(title)}</span>
            ${score != null ? `<span class="score-container">${K.formatScore(score, {})}</span>` : ''}
          </div>
          <div class="result-excerpt">${K.highlightExcerpt(excerpt, query)}</div>
          ${scoreBreakdown}
        </div>`;
        })
        .join(''),
    );
  }

  // ── Load knowledge from API ───────────────────────────────────────────────

  async function loadKnowledge(state, el) {
    try {
      const data = await K.api('/knowledge');
      const entries = Array.isArray(data) ? data : data.entries || [];
      state.knowledge.entries = entries;
      state.stats.knowledgeCount = entries.length;
      K.updateStats(state, el);
      renderKnowledge(state, el);
    } catch (err) {
      K.toast(`Failed to load knowledge: ${err.message}`, 'error');
    }
  }

  // ── Open knowledge entry in panel ─────────────────────────────────────────

  async function openKnowledgePanel(path) {
    if (!path) return;
    try {
      const [entryRes, linksRes] = await Promise.allSettled([
        K.api(`/knowledge/${encodeURIComponent(path)}`),
        K.api(`/knowledge/${encodeURIComponent(path)}/links`),
      ]);
      const data = entryRes.status === 'fulfilled' ? entryRes.value : {};
      const links = linksRes.status === 'fulfilled' ? linksRes.value : [];
      const title = data.title || data.path || path;
      const content = data.content || data.body || '';
      K.openPanel('knowledge', { title, content, meta: data, links, entryPath: path });
    } catch (err) {
      K.toast(`Failed to load entry: ${err.message}`, 'error');
    }
  }

  // ── Consolidate (duplicates) ──────────────────────────────────────────────

  async function loadConsolidate(state, el) {
    try {
      K.toast('Scanning for duplicates...', 'info', 2000);
      const report = await K.api('/knowledge/consolidate');
      state.knowledge.duplicateClusters = {};
      if (report.clusters && report.clusters.length > 0) {
        for (const cluster of report.clusters) {
          for (const entry of cluster.entries) {
            state.knowledge.duplicateClusters[entry.path] = cluster;
          }
        }
        renderKnowledge(state, el);
        K.openPanel('consolidate', report);
      } else {
        K.toast('No duplicate clusters found', 'success');
      }
    } catch (err) {
      K.toast(`Consolidation failed: ${err.message}`, 'error');
    }
  }

  // ── Reflect (unconnected entries) ─────────────────────────────────────────

  async function loadReflect() {
    try {
      K.toast('Finding unconnected entries...', 'info', 2000);
      const result = await K.api('/knowledge/reflect');
      if (result.unconnectedEntries && result.unconnectedEntries.length > 0) {
        K.openPanel('reflect', result);
      } else {
        K.toast('All entries are connected in the graph', 'success');
      }
    } catch (err) {
      K.toast(`Reflect failed: ${err.message}`, 'error');
    }
  }

  // ── God Nodes ─────────────────────────────────────────────────────────────

  async function loadGodNodes() {
    try {
      K.toast('Finding most connected entries...', 'info', 2000);
      const result = await K.api('/knowledge/god-nodes');
      if (Array.isArray(result) && result.length > 0) {
        K.openPanel('god-nodes', result);
      } else {
        K.toast('No god nodes — graph has no edges yet', 'success');
      }
    } catch (err) {
      K.toast(`God nodes failed: ${err.message}`, 'error');
    }
  }

  // ── Bridges ───────────────────────────────────────────────────────────────

  async function loadBridges() {
    try {
      K.toast('Finding bridge entries...', 'info', 2000);
      const result = await K.api('/knowledge/bridges');
      if (Array.isArray(result) && result.length > 0) {
        K.openPanel('bridges', result);
      } else {
        K.toast('No bridges found — graph has no cross-category connections', 'success');
      }
    } catch (err) {
      K.toast(`Bridges failed: ${err.message}`, 'error');
    }
  }

  // ── Gaps ──────────────────────────────────────────────────────────────────

  async function loadGaps() {
    try {
      K.toast('Finding knowledge gaps...', 'info', 2000);
      const result = await K.api('/knowledge/gaps');
      if (Array.isArray(result) && result.length > 0) {
        K.openPanel('gaps', result);
      } else {
        K.toast('No gaps — all entries are well connected', 'success');
      }
    } catch (err) {
      K.toast(`Gaps failed: ${err.message}`, 'error');
    }
  }

  // ── Brief ─────────────────────────────────────────────────────────────────

  async function loadBrief() {
    try {
      const result = await K.api('/knowledge/brief');
      K.openPanel('brief', result);
    } catch (err) {
      K.toast(`Brief failed: ${err.message}`, 'error');
    }
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  Object.assign(K, {
    renderKnowledge,
    createKnowledgeSearch,
    loadKnowledge,
    openKnowledgePanel,
    loadConsolidate,
    loadReflect,
    loadGodNodes,
    loadBridges,
    loadGaps,
    loadBrief,
  });
})();
