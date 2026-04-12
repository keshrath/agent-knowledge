/* agent-knowledge — graph tab rendering (vis.js) */
(function () {
  'use strict';

  var K = window.Knowledge;
  var network = null;
  var allNodes = [];
  var allEdges = [];
  var physicsEnabled = true;
  var activeEdgeFilter = 'all';
  var hideOrphans = false;
  var searchQuery = '';
  var controlsVersion = 0;

  var CATEGORY_COLORS = {
    projects: '#7aafc5',
    decisions: '#d4a574',
    notes: '#8db87a',
    workflows: '#b196cc',
    people: '#cc8888',
  };

  var CATEGORY_LABELS = {
    projects: 'Projects',
    decisions: 'Decisions',
    notes: 'Notes',
    workflows: 'Workflows',
    people: 'People',
  };

  var EDGE_COLORS = {
    part_of: 'rgba(122,175,197,0.4)',
    depends_on: 'rgba(212,165,116,0.4)',
    related_to: 'rgba(160,160,160,0.3)',
    builds_on: 'rgba(141,184,122,0.4)',
    supersedes: 'rgba(204,136,136,0.4)',
    contradicts: 'rgba(220,68,68,0.4)',
    specializes: 'rgba(177,150,204,0.4)',
    alternative_to: 'rgba(170,136,68,0.4)',
  };

  function getOptions(isDark) {
    var textColor = isDark ? '#d0d0d0' : '#444';
    var bgColor = isDark ? '#1a1a2e' : '#fff';
    return {
      nodes: {
        shape: 'dot',
        font: {
          color: textColor,
          size: 12,
          face: 'Inter, sans-serif',
          strokeWidth: 3,
          strokeColor: bgColor,
        },
        borderWidth: 0,
        shadow: false,
      },
      edges: {
        font: { size: 0 },
        arrows: { to: { enabled: false } },
        smooth: { type: 'continuous', roundness: 0.15 },
        width: 1,
        hoverWidth: 0.5,
        selectionWidth: 1,
      },
      physics: {
        enabled: physicsEnabled,
        barnesHut: {
          gravitationalConstant: -6000,
          centralGravity: 0.15,
          springLength: 200,
          springConstant: 0.02,
          damping: 0.12,
          avoidOverlap: 0.5,
        },
        stabilization: { iterations: 250, fit: true },
      },
      interaction: {
        hover: true,
        tooltipDelay: 100,
        keyboard: { enabled: true },
        zoomView: true,
        dragView: true,
      },
      layout: { improvedLayout: true },
    };
  }

  function connectedIds(edges) {
    var s = new Set();
    edges.forEach(function (e) {
      s.add(e.from);
      s.add(e.to);
    });
    return s;
  }

  function cleanEdge(e) {
    return {
      from: e.from,
      to: e.to,
      title: e.title || (e.rel_type || '').replace(/_/g, ' '),
      rel_type: e.rel_type,
      color: {
        color: EDGE_COLORS[e.rel_type] || 'rgba(160,160,160,0.3)',
        highlight: EDGE_COLORS[e.rel_type] || 'rgba(160,160,160,0.5)',
        hover: EDGE_COLORS[e.rel_type] || 'rgba(160,160,160,0.5)',
      },
    };
  }

  function getVisibleData() {
    var edges =
      activeEdgeFilter === 'all'
        ? allEdges
        : allEdges.filter(function (e) {
            return e.rel_type === activeEdgeFilter;
          });

    var cids = connectedIds(edges);

    var q = searchQuery.toLowerCase();
    var searchMatchIds = null;
    if (q) {
      searchMatchIds = new Set();
      allNodes.forEach(function (n) {
        if (n.label.toLowerCase().indexOf(q) >= 0 || n.id.toLowerCase().indexOf(q) >= 0) {
          searchMatchIds.add(n.id);
        }
      });
      edges.forEach(function (e) {
        if (searchMatchIds.has(e.from)) searchMatchIds.add(e.to);
        if (searchMatchIds.has(e.to)) searchMatchIds.add(e.from);
      });
    }

    var nodes = allNodes.filter(function (n) {
      if (searchMatchIds && !searchMatchIds.has(n.id)) return false;
      if (hideOrphans && !cids.has(n.id)) return false;
      if (activeEdgeFilter !== 'all' && !cids.has(n.id)) return false;
      return true;
    });

    var visibleIds = new Set(
      nodes.map(function (n) {
        return n.id;
      }),
    );
    var visibleEdges = edges.filter(function (e) {
      return visibleIds.has(e.from) && visibleIds.has(e.to);
    });

    return { nodes: nodes, edges: visibleEdges.map(cleanEdge) };
  }

  function applyFilter() {
    if (!network) return;
    var d = getVisibleData();
    network.setData({ nodes: new vis.DataSet(d.nodes), edges: new vis.DataSet(d.edges) });
    updateStats(d.nodes.length, d.edges.length);
    setTimeout(function () {
      network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
    }, 100);
  }

  function updateStats(nc, ec) {
    var el = document.getElementById('graph-stats');
    if (el) el.textContent = nc + ' nodes, ' + ec + ' edges';
  }

  function buildLegend() {
    var el = document.getElementById('graph-legend');
    if (!el) return;
    var cats = {};
    allNodes.forEach(function (n) {
      cats[n.group || 'notes'] = (cats[n.group || 'notes'] || 0) + 1;
    });
    var html = '';
    Object.keys(CATEGORY_COLORS).forEach(function (c) {
      if (!cats[c]) return;
      html +=
        '<span class="legend-item"><span class="legend-dot" style="background:' +
        CATEGORY_COLORS[c] +
        '"></span>' +
        (CATEGORY_LABELS[c] || c) +
        ' <span class="legend-count">' +
        cats[c] +
        '</span></span>';
    });
    var et = {};
    allEdges.forEach(function (e) {
      et[e.rel_type] = (et[e.rel_type] || 0) + 1;
    });
    if (Object.keys(et).length > 0) {
      html += '<span class="legend-separator"></span>';
      Object.keys(et).forEach(function (t) {
        html +=
          '<span class="legend-item"><span class="legend-line" style="background:' +
          (EDGE_COLORS[t] || '#888') +
          '"></span>' +
          t.replace(/_/g, ' ') +
          ' <span class="legend-count">' +
          et[t] +
          '</span></span>';
      });
    }
    el.innerHTML = html;
  }

  function ensureUI() {
    var view = document.getElementById('view-graph');
    if (!view) return null;
    var gc = document.getElementById('graph-container');
    if (!gc) return null;

    if (!document.getElementById('btn-graph-orphans')) {
      var actions = view.querySelector('.view-actions');
      if (actions) {
        var btn = document.createElement('button');
        btn.id = 'btn-graph-orphans';
        btn.className = 'header-action-btn';
        btn.title = 'Show only connected nodes';
        btn.innerHTML = '<span class="material-symbols-outlined">filter_alt</span>Connected';
        actions.insertBefore(btn, actions.firstChild);
      }
    }

    if (!document.getElementById('graph-search-input')) {
      var bar = document.createElement('div');
      bar.className = 'search-bar';
      bar.innerHTML =
        '<span class="material-symbols-outlined search-input-icon">search</span><input type="search" id="graph-search-input" class="search-input" placeholder="Search graph nodes..." autocomplete="off">';
      gc.parentNode.insertBefore(bar, gc);
    }

    if (!document.getElementById('graph-legend')) {
      var lg = document.createElement('div');
      lg.id = 'graph-legend';
      lg.className = 'graph-legend';
      gc.parentNode.insertBefore(lg, gc);
    }

    if (!document.getElementById('graph-stats')) {
      var st = document.createElement('div');
      st.id = 'graph-stats';
      st.className = 'graph-stats';
      gc.parentNode.appendChild(st);
    }

    return gc;
  }

  function replaceWithClone(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    return clone;
  }

  function bindControls() {
    controlsVersion++;
    var ver = controlsVersion;

    var fitBtn = replaceWithClone('btn-graph-fit');
    var physicsBtn = replaceWithClone('btn-graph-physics');
    var orphanBtn = replaceWithClone('btn-graph-orphans');
    var filterCont = replaceWithClone('graph-edge-filters');
    var searchInput = replaceWithClone('graph-search-input');

    if (fitBtn)
      fitBtn.addEventListener('click', function () {
        if (network) network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
      });

    if (physicsBtn) {
      physicsBtn.classList.toggle('active', physicsEnabled);
      physicsBtn.addEventListener('click', function () {
        physicsEnabled = !physicsEnabled;
        physicsBtn.classList.toggle('active', physicsEnabled);
        if (network) network.setOptions({ physics: { enabled: physicsEnabled } });
      });
    }

    if (orphanBtn) {
      orphanBtn.classList.toggle('active', hideOrphans);
      orphanBtn.addEventListener('click', function () {
        hideOrphans = !hideOrphans;
        orphanBtn.classList.toggle('active', hideOrphans);
        applyFilter();
      });
    }

    if (filterCont)
      filterCont.addEventListener('click', function (e) {
        if (ver !== controlsVersion) return;
        var chip = e.target.closest('.chip');
        if (!chip) return;
        filterCont.querySelectorAll('.chip').forEach(function (c) {
          c.classList.remove('active');
        });
        chip.classList.add('active');
        activeEdgeFilter = chip.dataset.edgeType || 'all';
        applyFilter();
      });

    if (searchInput) {
      var timer;
      searchInput.addEventListener('input', function () {
        if (ver !== controlsVersion) return;
        clearTimeout(timer);
        timer = setTimeout(function () {
          searchQuery = (searchInput.value || '').trim();
          applyFilter();
        }, 300);
      });
    }
  }

  async function loadGraph() {
    var gc = ensureUI();
    if (!gc) return;

    gc.style.cssText =
      'width:100%;height:calc(100vh - 320px);min-height:300px;display:block;visibility:visible;';
    var emptyEl = document.getElementById('graph-empty');
    if (emptyEl) emptyEl.classList.add('hidden');

    await new Promise(function (r) {
      requestAnimationFrame(r);
    });

    try {
      var data;
      var baseUrl = K._baseUrl || '';

      var resp = await fetch(baseUrl + '/api/knowledge/graph-data');
      if (resp.ok) {
        data = await resp.json();
      } else {
        var er = await fetch(baseUrl + '/api/knowledge');
        var entries = await er.json();
        if (!Array.isArray(entries)) entries = [];
        var edgeArr = [];
        var bs = 10;
        for (var i = 0; i < entries.length; i += bs) {
          var batch = entries.slice(i, i + bs);
          var results = await Promise.all(
            batch.map(function (e) {
              return fetch(baseUrl + '/api/knowledge/' + encodeURIComponent(e.path) + '/links')
                .then(function (r) {
                  return r.ok ? r.json() : [];
                })
                .catch(function () {
                  return [];
                });
            }),
          );
          var seen = new Set(
            edgeArr.map(function (e) {
              return e.source + '|' + e.target + '|' + e.rel_type;
            }),
          );
          results.forEach(function (links) {
            if (!Array.isArray(links)) return;
            links.forEach(function (e) {
              var k = e.source + '|' + e.target + '|' + e.rel_type;
              if (!seen.has(k)) {
                seen.add(k);
                edgeArr.push(e);
              }
            });
          });
        }
        data = {
          nodes: entries.map(function (e) {
            var cat = e.category || e.path.split('/')[0] || 'notes';
            var deg = edgeArr.filter(function (d) {
              return d.source === e.path || d.target === e.path;
            }).length;
            return {
              id: e.path,
              label: (e.title || e.path.split('/').pop().replace('.md', '') || e.path).slice(0, 40),
              title: e.path + '\nCategory: ' + cat + '\nEdges: ' + deg,
              group: cat,
              size: Math.max(4, Math.min(16, 4 + deg * 2)),
            };
          }),
          edges: edgeArr.map(function (e) {
            return {
              from: e.source,
              to: e.target,
              title: (e.rel_type || '').replace(/_/g, ' '),
              rel_type: e.rel_type,
            };
          }),
        };
      }

      allNodes = (data.nodes || []).map(function (n) {
        var cat = n.group || 'notes';
        var deg = (data.edges || []).filter(function (e) {
          return e.from === n.id || e.to === n.id;
        }).length;
        var c = CATEGORY_COLORS[cat] || '#888';
        return {
          id: n.id,
          label: n.label,
          title: n.title,
          group: cat,
          color: {
            background: c,
            border: c,
            highlight: { background: c, border: c },
            hover: { background: c, border: c },
          },
          size: Math.max(4, Math.min(16, 4 + deg * 2)),
          font: { size: deg > 3 ? 12 : deg > 0 ? 11 : 9 },
          degree: deg,
        };
      });

      allEdges = (data.edges || []).map(function (e) {
        return {
          from: e.from,
          to: e.to,
          title: e.title || (e.rel_type || '').replace(/_/g, ' '),
          rel_type: e.rel_type,
        };
      });

      console.log('[graph] nodes:', allNodes.length, 'edges:', allEdges.length);

      if (allNodes.length === 0) {
        gc.style.display = 'none';
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }

      buildLegend();
      bindControls();

      var d = getVisibleData();
      updateStats(d.nodes.length, d.edges.length);

      var isDark =
        document.documentElement.getAttribute('data-theme') === 'dark' ||
        localStorage.getItem('agent-knowledge-theme') === 'dark';

      if (network) network.destroy();
      network = new vis.Network(
        gc,
        { nodes: new vis.DataSet(d.nodes), edges: new vis.DataSet(d.edges) },
        getOptions(isDark),
      );

      network.on('click', function (p) {
        if (p.nodes.length > 0 && K.openKnowledgePanel) K.openKnowledgePanel(p.nodes[0]);
      });
      network.on('hoverNode', function () {
        gc.style.cursor = 'pointer';
      });
      network.on('blurNode', function () {
        gc.style.cursor = 'default';
      });
      network.on('stabilizationIterationsDone', function () {
        network.setOptions({ physics: { stabilization: { enabled: false } } });
      });
    } catch (err) {
      console.error('[graph] load failed:', err);
      gc.style.display = 'none';
      var em = document.getElementById('graph-empty');
      if (em) em.classList.remove('hidden');
    }
  }

  K.renderGraph = loadGraph;
  K.setupGraphControls = function () {};
  K.graphFit = function () {
    if (network) network.fit();
  };
})();
