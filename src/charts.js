import * as echarts from 'echarts';

let _barChart   = null;
let _sankeyChart = null;
let _onAreaSelect = null;
let _lastFlows = [];
let _lastTotal = 0;
let _lastState = null;

// ── Public API ────────────────────────────────────────────────────────────────

export function initCharts(onAreaSelect) {
  _onAreaSelect = onAreaSelect;

  const barEl    = document.getElementById('bar-chart');
  const sankeyEl = document.getElementById('sankey-chart');

  if (barEl)    _barChart    = echarts.init(barEl,    null, { renderer: 'canvas' });
  if (sankeyEl) _sankeyChart = echarts.init(sankeyEl, null, { renderer: 'canvas' });

  // Re-size when container dimensions change
  const ro = new ResizeObserver(() => {
    _barChart?.resize();
    _sankeyChart?.resize();
  });
  if (barEl)    ro.observe(barEl);
  if (sankeyEl) ro.observe(sankeyEl);
}

export function updateCharts(flows, total, appState) {
  _lastFlows = flows;
  _lastTotal = total;
  _lastState = appState;

  const top5 = flows.slice(0, 5);
  _renderBar(top5, appState);
  _renderSankey(top5, appState);

  // Update bar section title
  const titleEl = document.getElementById('bar-title');
  if (titleEl) {
    titleEl.textContent = appState.direction === 'outflow'
      ? 'Top 5 Destinations'
      : 'Top 5 Origins';
  }
}

export function exportBarPng() {
  if (!_barChart || !_lastFlows.length) return;
  const bg = _lastState?.theme === 'dark' ? '#1a1a2e' : '#ffffff';
  _downloadUrl(
    _barChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: bg }),
    `commute-bar-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}.png`
  );
}

export function exportSankeyPng() {
  if (!_sankeyChart || !_lastFlows.length) return;
  const bg = _lastState?.theme === 'dark' ? '#1a1a2e' : '#ffffff';
  _downloadUrl(
    _sankeyChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: bg }),
    `commute-sankey-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}.png`
  );
}

export function exportBarCsv() {
  if (!_lastFlows.length || !_lastState) return;
  const isOutflow = _lastState.direction === 'outflow';
  const header = ['Rank', isOutflow ? 'Destination' : 'Origin', 'Commuters', '% of Area Total'];
  const rows = _lastFlows.slice(0, 5).map((d, i) => {
    const pct = _lastTotal > 0 ? ((Number(d.S000) / _lastTotal) * 100).toFixed(1) : '0.0';
    return [i + 1, d.dest_name, Number(d.S000), pct + '%'];
  });
  _downloadCsv(
    [header, ...rows],
    `commute-top5-${_lastState.selectedArea}-${_lastState.year}.csv`
  );
}

export function exportSankeyCsv() {
  exportBarCsv();
}

// ── Chart renderers ───────────────────────────────────────────────────────────

function _tc(theme) {
  const dk = theme === 'dark';
  return {
    text:     dk ? '#c0c0d8' : '#333',
    muted:    dk ? '#6a6a8a' : '#aaa',
    axis:     dk ? '#2e2e4e' : '#ebebeb',
    accent:   dk ? '#ffb440' : '#ff8c00',
    selected: dk ? '#3a70a8' : '#1a3a5c',
    ttBg:     dk ? '#1a1a2e' : '#fff',
    ttBorder: dk ? '#3a3a5c' : '#ddd',
  };
}

function _renderBar(top5, state) {
  if (!_barChart) return;

  const tc = _tc(state.theme);

  if (!top5.length) {
    _barChart.clear();
    return;
  }

  const names  = top5.map(d => d.dest_name).reverse();
  const values = top5.map(d => Number(d.S000)).reverse();
  const maxVal = Math.max(...values, 1);

  _barChart.setOption({
    backgroundColor: 'transparent',
    animation: true,
    animationDuration: 400,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: p => {
        const v = p[0];
        return `${v.name}<br/><strong>${Number(v.value).toLocaleString()}</strong> commuters`;
      },
      backgroundColor: tc.ttBg,
      borderColor: tc.ttBorder,
      textStyle: { color: tc.text, fontSize: 12 },
    },
    grid: { top: 6, right: 56, bottom: 4, left: 4, containLabel: true },
    xAxis: {
      type: 'value',
      axisLabel: {
        color: tc.muted,
        fontSize: 9,
        formatter: v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v),
      },
      splitLine: { lineStyle: { color: tc.axis } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'category',
      data: names,
      axisLabel: { color: tc.text, fontSize: 10, overflow: 'truncate', width: 90 },
      axisLine: { lineStyle: { color: tc.axis } },
      axisTick: { show: false },
    },
    series: [{
      type: 'bar',
      data: values.map(v => ({
        value: v,
        itemStyle: {
          color: tc.accent,
          borderRadius: [0, 3, 3, 0],
          opacity: 0.45 + 0.55 * (v / maxVal),
        },
      })),
      label: {
        show: true,
        position: 'right',
        color: tc.text,
        fontSize: 9,
        formatter: p => Number(p.value).toLocaleString(),
      },
      emphasis: { itemStyle: { opacity: 1 } },
    }],
  }, true);

  _barChart.resize();

  _barChart.off('click');
  _barChart.on('click', params => {
    if (params.componentType === 'series' && params.name) {
      _onAreaSelect?.(params.name, state.aggregation);
    }
  });
}

function _renderSankey(top5, state) {
  if (!_sankeyChart) return;

  const tc = _tc(state.theme);

  if (!top5.length) {
    _sankeyChart.clear();
    return;
  }

  const selectedArea = state.selectedArea;
  const isOutflow    = state.direction === 'outflow';
  const destNames    = [...new Set(top5.map(d => d.dest_name))];

  const nodes = [
    { name: selectedArea, itemStyle: { color: tc.selected } },
    ...destNames.map(n => ({ name: n, itemStyle: { color: tc.accent } })),
  ];

  const links = top5.map(d => ({
    source: isOutflow ? selectedArea : d.dest_name,
    target: isOutflow ? d.dest_name  : selectedArea,
    value:  Number(d.S000),
  }));

  _sankeyChart.setOption({
    backgroundColor: 'transparent',
    animation: true,
    animationDuration: 400,
    tooltip: {
      trigger: 'item',
      formatter: p => {
        if (p.dataType === 'edge') {
          return `${p.data.source} &rarr; ${p.data.target}<br/><strong>${Number(p.data.value).toLocaleString()}</strong> commuters`;
        }
        return `<strong>${p.name}</strong>`;
      },
      backgroundColor: tc.ttBg,
      borderColor: tc.ttBorder,
      textStyle: { color: tc.text, fontSize: 12 },
    },
    series: [{
      type: 'sankey',
      data: nodes,
      links,
      emphasis: { focus: 'adjacency' },
      lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.45 },
      label: { fontSize: 10, color: tc.text, overflow: 'truncate' },
      nodeWidth: 10,
      nodeGap: 10,
      layoutIterations: 32,
      left: '4%',
      right: '4%',
      top: '6%',
      bottom: '6%',
    }],
  }, true);

  _sankeyChart.resize();

  _sankeyChart.off('click');
  _sankeyChart.on('click', params => {
    if (params.dataType === 'node' && params.name !== state.selectedArea) {
      _onAreaSelect?.(params.name, state.aggregation);
    }
  });
}

// ── Download helpers ──────────────────────────────────────────────────────────

function _downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
}

function _downloadCsv(rows, filename) {
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  _downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
