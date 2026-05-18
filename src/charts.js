import * as echarts from 'echarts';

let _barChart      = null;
let _sankeyChart   = null;
let _demoChart     = null;
let _reachChart    = null;
let _industryChart = null;
let _onAreaSelect  = null;

let _lastOutflows = [];
let _lastInflows  = [];
let _lastTotalOut = 0;
let _lastTotalIn  = 0;
let _lastState    = null;

// Per-chart UI state (not reset on data change)
let _demoDimension = 'age';      // 'age' | 'earnings' | 'industry'
let _industryDir   = 'outflow';  // 'outflow' | 'inflow'

// ── Public API ────────────────────────────────────────────────────────────────

export function initCharts(onAreaSelect) {
  _onAreaSelect = onAreaSelect;

  const barEl      = document.getElementById('bar-chart');
  const sankeyEl   = document.getElementById('sankey-chart');
  const demoEl     = document.getElementById('demo-chart');
  const reachEl    = document.getElementById('reach-chart');
  const industryEl = document.getElementById('industry-chart');

  if (barEl)      _barChart      = echarts.init(barEl,      null, { renderer: 'canvas' });
  if (sankeyEl)   _sankeyChart   = echarts.init(sankeyEl,   null, { renderer: 'canvas' });
  if (demoEl)     _demoChart     = echarts.init(demoEl,     null, { renderer: 'canvas' });
  if (reachEl)    _reachChart    = echarts.init(reachEl,    null, { renderer: 'canvas' });
  if (industryEl) _industryChart = echarts.init(industryEl, null, { renderer: 'canvas' });

  const all = [barEl, sankeyEl, demoEl, reachEl, industryEl];
  const ro = new ResizeObserver(() => {
    _barChart?.resize(); _sankeyChart?.resize(); _demoChart?.resize();
    _reachChart?.resize(); _industryChart?.resize();
  });
  all.forEach(el => { if (el) ro.observe(el); });

  // ── Collapse on header click — no .chart-section-header in new HTML;
  //    querySelectorAll returns empty NodeList so this is a safe no-op ──────
  document.querySelectorAll('.chart-section-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.closest('button:not(.chart-collapse-btn), input')) return;
      const btn     = header.querySelector('.chart-collapse-btn');
      const section = btn ? document.getElementById(btn.dataset.target) : null;
      if (!section) return;
      const nowCollapsed = section.classList.toggle('collapsed');
      if (btn) btn.setAttribute('aria-expanded', String(!nowCollapsed));
      if (!nowCollapsed) {
        requestAnimationFrame(() => {
          _barChart?.resize(); _sankeyChart?.resize(); _demoChart?.resize();
          _reachChart?.resize(); _industryChart?.resize();
        });
      }
    });
  });

  // ── Worker Demographics dimension toggle (hidden demo chart) ──────────────
  document.querySelectorAll('#dim-toggle .mini-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#dim-toggle .mini-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _demoDimension = btn.dataset.dim;
      if (_lastState) _renderDemographics(_lastOutflows, _lastInflows, _lastState);
    });
  });

  // ── Industry Mix direction toggle ─────────────────────────────────────────
  document.querySelectorAll('#industry-dir-toggle .mini-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#industry-dir-toggle .mini-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _industryDir = btn.dataset.dir;
      if (_lastState) _renderIndustry(_lastOutflows, _lastInflows, _lastState);
    });
  });
}

export function updateCharts(outflows, inflows, totalOut, totalIn, appState) {
  _lastOutflows = outflows;
  _lastInflows  = inflows;
  _lastTotalOut = totalOut;
  _lastTotalIn  = totalIn;
  _lastState    = appState;

  _renderBar(outflows, inflows, totalOut, totalIn, appState);
  _renderSankey(outflows, inflows, appState);
  _renderDemographics(outflows, inflows, appState);
  _renderReach(outflows, inflows, appState);
  _renderIndustry(outflows, inflows, appState);
}

// ── Exports ───────────────────────────────────────────────────────────────────

export function exportBarPng() {
  _pngDownload(_barChart, `commute-balance-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}`);
}
export function exportSankeyPng() {
  _pngDownload(_sankeyChart, `commute-flow-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}`);
}
export function exportDemoPng() {
  _pngDownload(_demoChart, `worker-demographics-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}`);
}
export function exportReachPng() {
  _pngDownload(_reachChart, `commute-reach-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}`);
}
export function exportIndustryPng() {
  _pngDownload(_industryChart, `industry-mix-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}`);
}

export function exportBarCsv() {
  if (!_lastState) return;
  const { rows } = _mergeFlows(_lastOutflows, _lastInflows, 9);
  const header = ['Area', 'Inflow (Workers In)', 'Inflow %', 'Outflow (Residents Out)', 'Outflow %'];
  const data = rows.map(d => [
    d.name,
    d.in,
    _lastTotalIn  > 0 ? ((d.in  / _lastTotalIn)  * 100).toFixed(1) + '%' : '0.0%',
    d.out,
    _lastTotalOut > 0 ? ((d.out / _lastTotalOut) * 100).toFixed(1) + '%' : '0.0%',
  ]);
  _csvDownload([header, ...data], `commute-balance-${_lastState.selectedArea}-${_lastState.year}`);
}

export function exportSankeyCsv() {
  if (!_lastState) return;
  const area = _lastState.selectedArea;
  const header = ['Direction', 'From', 'To', 'Commuters'];
  const rows = [
    ..._lastInflows.slice(0, 5).map(f  => ['Inflow',  f.dest_name, area,        Number(f.S000)]),
    ..._lastOutflows.slice(0, 5).map(f => ['Outflow', area,        f.dest_name, Number(f.S000)]),
  ];
  _csvDownload([header, ...rows], `commute-flow-${area}-${_lastState.year}`);
}

export function exportDemoCsv() {
  if (!_lastState) return;
  const aggrOut = _aggregate(_lastOutflows);
  const aggrIn  = _aggregate(_lastInflows);
  const header = ['Dimension', 'Category', 'Outflow (Residents Out)', 'Inflow (Workers In)'];
  const rows = [
    ['Age', 'Under 30',  aggrOut.SA01, aggrIn.SA01],
    ['Age', '30–54',     aggrOut.SA02, aggrIn.SA02],
    ['Age', '55+',       aggrOut.SA03, aggrIn.SA03],
    ['Earnings', '≤$1,250/mo',    aggrOut.SE01, aggrIn.SE01],
    ['Earnings', '$1,251–3,333',  aggrOut.SE02, aggrIn.SE02],
    ['Earnings', '>$3,333',       aggrOut.SE03, aggrIn.SE03],
    ['Industry', 'Goods',         aggrOut.SI01, aggrIn.SI01],
    ['Industry', 'Trade/Transport', aggrOut.SI02, aggrIn.SI02],
    ['Industry', 'Services',      aggrOut.SI03, aggrIn.SI03],
  ];
  _csvDownload([header, ...rows], `worker-demographics-${_lastState.selectedArea}-${_lastState.year}`);
}

export function exportReachCsv() {
  if (!_lastState) return;
  const labels = ['< 10 mi', '10–25 mi', '25–50 mi', '50+ mi'];
  const outB = _bucketFlows(_lastOutflows);
  const inB  = _bucketFlows(_lastInflows);
  const header = ['Direction', ...labels, 'Total'];
  const rows = [
    ['Outflow', ...outB, outB.reduce((s, v) => s + v, 0)],
    ['Inflow',  ...inB,  inB.reduce((s, v) => s + v, 0)],
  ];
  _csvDownload([header, ...rows], `commute-reach-${_lastState.selectedArea}-${_lastState.year}`);
}

export function exportIndustryCsv() {
  if (!_lastState) return;
  const flows = _industryDir === 'outflow' ? _lastOutflows : _lastInflows;
  const top5  = flows.slice(0, 5);
  const header = ['City', 'Goods (SI01)', 'Trade/Transport (SI02)', 'Services (SI03)', 'Total'];
  const rows = top5.map(f => [
    f.dest_name,
    Number(f.SI01 || 0),
    Number(f.SI02 || 0),
    Number(f.SI03 || 0),
    Number(f.S000),
  ]);
  _csvDownload([header, ...rows], `industry-mix-${_lastState.selectedArea}-${_lastState.year}`);
}

export function resizeCharts() {
  _barChart?.resize(); _sankeyChart?.resize(); _demoChart?.resize();
  _reachChart?.resize(); _industryChart?.resize();
}

// ── Shared data helpers ───────────────────────────────────────────────────────

function _mergeFlows(outflows, inflows, topN) {
  const byCity = {};
  outflows.forEach(f => {
    byCity[f.dest_name] = byCity[f.dest_name] || { name: f.dest_name, out: 0, in: 0 };
    byCity[f.dest_name].out = Number(f.S000);
  });
  inflows.forEach(f => {
    byCity[f.dest_name] = byCity[f.dest_name] || { name: f.dest_name, out: 0, in: 0 };
    byCity[f.dest_name].in = Number(f.S000);
  });
  const sorted = Object.values(byCity).sort((a, b) => (b.out + b.in) - (a.out + a.in));
  const rows   = sorted.slice(0, topN);
  const rest   = sorted.slice(topN);
  if (rest.length > 0) {
    rows.push({
      name: 'Others',
      out: rest.reduce((s, d) => s + d.out, 0),
      in:  rest.reduce((s, d) => s + d.in,  0),
      isOthers: true,
    });
  }
  return { rows, all: sorted };
}

function _aggregate(flows) {
  return flows.reduce((acc, f) => ({
    SA01: acc.SA01 + Number(f.SA01 || 0),
    SA02: acc.SA02 + Number(f.SA02 || 0),
    SA03: acc.SA03 + Number(f.SA03 || 0),
    SE01: acc.SE01 + Number(f.SE01 || 0),
    SE02: acc.SE02 + Number(f.SE02 || 0),
    SE03: acc.SE03 + Number(f.SE03 || 0),
    SI01: acc.SI01 + Number(f.SI01 || 0),
    SI02: acc.SI02 + Number(f.SI02 || 0),
    SI03: acc.SI03 + Number(f.SI03 || 0),
  }), { SA01:0, SA02:0, SA03:0, SE01:0, SE02:0, SE03:0, SI01:0, SI02:0, SI03:0 });
}

const REACH_BANDS  = [10, 25, 50, Infinity];
const REACH_LABELS = ['< 10 mi', '10–25 mi', '25–50 mi', '50+ mi'];

function _bucketFlows(flows) {
  const counts = [0, 0, 0, 0];
  flows.forEach(f => {
    if (f.home_lat == null || f.work_lat == null) return;
    const mi = _haversineMiles(f.home_lat, f.home_lon, f.work_lat, f.work_lon);
    const n  = Number(f.S000);
    for (let i = 0; i < REACH_BANDS.length; i++) {
      if (mi < REACH_BANDS[i]) { counts[i] += n; break; }
    }
  });
  return counts;
}

function _haversineMiles(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Theme colors ──────────────────────────────────────────────────────────────

function _tc(theme) {
  const dk = theme === 'dark';
  return {
    text:         dk ? '#c4c1b8' : '#2a2f40',
    muted:        dk ? '#696a73' : '#898d9c',
    axis:         dk ? 'rgba(232,229,220,0.09)' : 'rgba(18,23,38,0.10)',
    outflow:      dk ? '#e4895a' : '#cc683a',
    outflowMuted: dk ? 'rgba(228,137,90,0.32)'  : 'rgba(204,104,58,0.32)',
    inflow:       dk ? '#5aa6a7' : '#1e6f6f',
    inflowMuted:  dk ? 'rgba(90,166,167,0.32)'  : 'rgba(30,111,111,0.32)',
    mid:          dk ? '#7fa8a9' : '#4a8080',
    selectedNode: dk ? '#1b2031' : '#efebde',
    ttBg:         dk ? '#0a0e17' : '#f6f3eb',
    ttBorder:     dk ? 'rgba(232,229,220,0.20)' : 'rgba(18,23,38,0.22)',
  };
}

// ── 1. Commute Balance — diverging bar ────────────────────────────────────────

function _renderBar(outflows, inflows, totalOut, totalIn, state) {
  if (!_barChart) return;
  const tc = _tc(state.theme);
  const { rows } = _mergeFlows(outflows, inflows, 9);
  if (!rows.length) { _barChart.clear(); return; }

  const reversed = [...rows].reverse(); // ECharts: index 0 = bottom
  const names   = reversed.map(r => r.name);
  const inData  = reversed.map(r => -r.in);   // negative → renders left
  const outData = reversed.map(r => r.out);   // positive → renders right
  const lookup  = Object.fromEntries(rows.map(r => [r.name, r]));

  _barChart.setOption({
    backgroundColor: 'transparent',
    animation: true, animationDuration: 400,
    legend: {
      top: 2, left: 'center', itemWidth: 10, itemHeight: 8,
      textStyle: { color: tc.muted, fontSize: 9 },
      data: [
        { name: 'Inflow',  icon: 'rect', itemStyle: { color: tc.inflow  } },
        { name: 'Outflow', icon: 'rect', itemStyle: { color: tc.outflow } },
      ],
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: tc.ttBg, borderColor: tc.ttBorder,
      textStyle: { color: tc.text, fontSize: 11 },
      formatter: params => {
        const row = lookup[params[0]?.name];
        if (!row) return params[0]?.name;
        const inPct  = totalIn  > 0 ? ((row.in  / totalIn)  * 100).toFixed(1) : '0.0';
        const outPct = totalOut > 0 ? ((row.out / totalOut) * 100).toFixed(1) : '0.0';
        return [
          `<strong>${row.name}</strong>`,
          `<span style="color:${tc.inflow}">← ${row.in.toLocaleString()}</span>&nbsp; ${inPct}% of workforce`,
          `<span style="color:${tc.outflow}">→ ${row.out.toLocaleString()}</span>&nbsp; ${outPct}% of commuters`,
        ].join('<br/>');
      },
    },
    grid: { top: 22, right: 44, bottom: 4, left: 4, containLabel: true },
    xAxis: {
      type: 'value',
      axisLabel: { color: tc.muted, fontSize: 9, formatter: v => { const a = Math.abs(v); return a >= 1000 ? `${(a/1000).toFixed(0)}k` : String(a); } },
      splitLine: { lineStyle: { color: tc.axis } },
      axisLine: { show: false }, axisTick: { show: false },
    },
    yAxis: {
      type: 'category', data: names,
      axisLabel: { color: tc.text, fontSize: 10, overflow: 'truncate', width: 82 },
      axisLine: { lineStyle: { color: tc.axis } }, axisTick: { show: false },
    },
    series: [
      {
        name: 'Inflow', type: 'bar', barMaxWidth: 16,
        data: inData.map((v, i) => ({ value: v, itemStyle: { color: reversed[i].isOthers ? tc.inflowMuted : tc.inflow, borderRadius: [1,0,0,1] } })),
        label: { show: true, position: 'left', color: tc.muted, fontSize: 8, hideOverlap: true, formatter: p => p.value < -99 ? Number(-p.value).toLocaleString() : '' },
        emphasis: { itemStyle: { opacity: 0.8 } },
      },
      {
        name: 'Outflow', type: 'bar', barMaxWidth: 16,
        data: outData.map((v, i) => ({ value: v, itemStyle: { color: reversed[i].isOthers ? tc.outflowMuted : tc.outflow, borderRadius: [0,1,1,0] } })),
        label: { show: true, position: 'right', color: tc.muted, fontSize: 8, hideOverlap: true, formatter: p => p.value > 99 ? Number(p.value).toLocaleString() : '' },
        emphasis: { itemStyle: { opacity: 0.8 } },
      },
    ],
  }, true);

  _barChart.resize();
  _barChart.off('click');
  _barChart.on('click', params => {
    const name = params.componentType === 'series' ? params.name
               : params.componentType === 'yAxis'  ? params.value : null;
    if (name && name !== 'Others') _onAreaSelect?.(name, state.aggregation);
  });
}

// ── 2. Flow Diagram — bilateral Sankey ────────────────────────────────────────

function _renderSankey(outflows, inflows, state) {
  if (!_sankeyChart) return;
  const tc  = _tc(state.theme);
  const sel = state.selectedArea;
  const topIn  = inflows.slice(0, 4);
  const topOut = outflows.slice(0, 4);
  if (!topIn.length && !topOut.length) { _sankeyChart.clear(); return; }

  const restIn  = inflows.slice(4).reduce((s, f) => s + Number(f.S000), 0);
  const restOut = outflows.slice(4).reduce((s, f) => s + Number(f.S000), 0);

  const nodes = [
    ...topIn.map(f => ({ name: `←${f.dest_name}`, depth: 0, itemStyle: { color: tc.inflow } })),
    ...(restIn  > 0 ? [{ name: '←Others', depth: 0, itemStyle: { color: tc.inflowMuted } }] : []),
    { name: sel, depth: 1, itemStyle: { color: tc.selectedNode }, label: { fontWeight: 700 } },
    ...topOut.map(f => ({ name: `→${f.dest_name}`, depth: 2, itemStyle: { color: tc.outflow } })),
    ...(restOut > 0 ? [{ name: '→Others', depth: 2, itemStyle: { color: tc.outflowMuted } }] : []),
  ];

  const links = [
    ...topIn.map(f => ({ source: `←${f.dest_name}`, target: sel, value: Number(f.S000), lineStyle: { color: tc.inflow, opacity: 0.35 } })),
    ...(restIn  > 0 ? [{ source: '←Others', target: sel, value: restIn,  lineStyle: { color: tc.inflowMuted,  opacity: 0.45 } }] : []),
    ...topOut.map(f => ({ source: sel, target: `→${f.dest_name}`, value: Number(f.S000), lineStyle: { color: tc.outflow, opacity: 0.35 } })),
    ...(restOut > 0 ? [{ source: sel, target: '→Others', value: restOut, lineStyle: { color: tc.outflowMuted, opacity: 0.45 } }] : []),
  ];

  _sankeyChart.setOption({
    backgroundColor: 'transparent', animation: true, animationDuration: 400,
    tooltip: {
      trigger: 'item', backgroundColor: tc.ttBg, borderColor: tc.ttBorder,
      textStyle: { color: tc.text, fontSize: 11 },
      formatter: p => {
        if (p.dataType === 'edge') return `${_sd(p.data.source)} → ${_sd(p.data.target)}<br/><strong>${Number(p.data.value).toLocaleString()}</strong> commuters`;
        return `<strong>${_sd(p.name)}</strong>`;
      },
    },
    series: [{
      type: 'sankey', data: nodes, links,
      emphasis: { focus: 'adjacency' },
      lineStyle: { curveness: 0.5 },
      label: { color: tc.text, fontSize: 10, overflow: 'truncate', width: 88, formatter: p => _sd(p.name) },
      nodeWidth: 8, nodeGap: 8, layoutIterations: 32,
      left: '18%', right: '22%', top: '4%', bottom: '4%',
    }],
  }, true);

  _sankeyChart.resize();
  _sankeyChart.off('click');
  _sankeyChart.on('click', params => {
    if (params.dataType !== 'node') return;
    const raw = params.name;
    if (raw === sel || raw === '←Others' || raw === '→Others') return;
    _onAreaSelect?.(_sd(raw), state.aggregation);
  });
}

function _sd(name) { // strip direction prefix
  return (name.startsWith('←') || name.startsWith('→')) ? name.slice(1) : name;
}

// ── 3. Worker Demographics — diverging grouped bar ────────────────────────────

function _renderDemographics(outflows, inflows, state) {
  if (!_demoChart) return;
  const tc      = _tc(state.theme);
  const aggrOut = _aggregate(outflows);
  const aggrIn  = _aggregate(inflows);

  let categories, outVals, inVals;
  if (_demoDimension === 'age') {
    categories = ['55+', '30–54', 'Under 30'];
    outVals    = [aggrOut.SA03, aggrOut.SA02, aggrOut.SA01];
    inVals     = [aggrIn.SA03,  aggrIn.SA02,  aggrIn.SA01];
  } else if (_demoDimension === 'earnings') {
    categories = ['>$3,333/mo', '$1,251–3,333', '≤$1,250/mo'];
    outVals    = [aggrOut.SE03, aggrOut.SE02, aggrOut.SE01];
    inVals     = [aggrIn.SE03,  aggrIn.SE02,  aggrIn.SE01];
  } else { // industry
    categories = ['Services', 'Trade/Transport', 'Goods'];
    outVals    = [aggrOut.SI03, aggrOut.SI02, aggrOut.SI01];
    inVals     = [aggrIn.SI03,  aggrIn.SI02,  aggrIn.SI01];
  }

  if (!outVals.some(v => v) && !inVals.some(v => v)) { _demoChart.clear(); return; }

  _demoChart.setOption({
    backgroundColor: 'transparent', animation: true, animationDuration: 400,
    legend: {
      top: 2, left: 'center', itemWidth: 10, itemHeight: 8,
      textStyle: { color: tc.muted, fontSize: 9 },
      data: [
        { name: 'Inflow',  icon: 'rect', itemStyle: { color: tc.inflow  } },
        { name: 'Outflow', icon: 'rect', itemStyle: { color: tc.outflow } },
      ],
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: tc.ttBg, borderColor: tc.ttBorder,
      textStyle: { color: tc.text, fontSize: 11 },
      formatter: params => {
        const cat = params[0]?.name;
        const idx = categories.indexOf(cat);
        const iv  = idx >= 0 ? inVals[idx] : 0;
        const ov  = idx >= 0 ? outVals[idx] : 0;
        return [
          `<strong>${cat}</strong>`,
          `<span style="color:${tc.inflow}">← ${iv.toLocaleString()}</span> inflow`,
          `<span style="color:${tc.outflow}">→ ${ov.toLocaleString()}</span> outflow`,
        ].join('<br/>');
      },
    },
    grid: { top: 22, right: 44, bottom: 4, left: 4, containLabel: true },
    xAxis: {
      type: 'value',
      axisLabel: { color: tc.muted, fontSize: 9, formatter: v => { const a = Math.abs(v); return a >= 1000 ? `${(a/1000).toFixed(0)}k` : String(a); } },
      splitLine: { lineStyle: { color: tc.axis } },
      axisLine: { show: false }, axisTick: { show: false },
    },
    yAxis: {
      type: 'category', data: categories,
      axisLabel: { color: tc.text, fontSize: 10 },
      axisLine: { lineStyle: { color: tc.axis } }, axisTick: { show: false },
    },
    series: [
      {
        name: 'Inflow', type: 'bar', barMaxWidth: 18,
        data: inVals.map(v => ({ value: -v, itemStyle: { color: tc.inflow, borderRadius: [1,0,0,1] } })),
        label: { show: true, position: 'left', color: tc.muted, fontSize: 8, hideOverlap: true, formatter: p => p.value < -99 ? Number(-p.value).toLocaleString() : '' },
        emphasis: { itemStyle: { opacity: 0.8 } },
      },
      {
        name: 'Outflow', type: 'bar', barMaxWidth: 18,
        data: outVals.map(v => ({ value: v, itemStyle: { color: tc.outflow, borderRadius: [0,1,1,0] } })),
        label: { show: true, position: 'right', color: tc.muted, fontSize: 8, hideOverlap: true, formatter: p => p.value > 99 ? Number(p.value).toLocaleString() : '' },
        emphasis: { itemStyle: { opacity: 0.8 } },
      },
    ],
  }, true);

  _demoChart.resize();
}

// ── 4. Commute Reach — distance-band stacked bars ─────────────────────────────

function _renderReach(outflows, inflows, state) {
  if (!_reachChart) return;
  const tc  = _tc(state.theme);
  const outB = _bucketFlows(outflows);
  const inB  = _bucketFlows(inflows);
  const outT = outB.reduce((s, v) => s + v, 0) || 1;
  const inT  = inB.reduce((s, v) => s + v, 0) || 1;

  if (outT === 1 && inT === 1) { _reachChart.clear(); return; }

  const dk = state.theme === 'dark';
  const outflowRgb = dk ? '228,137,90'  : '204,104,58';
  const inflowRgb  = dk ? '90,166,167'  : '30,111,111';
  const opacities  = [1.0, 0.70, 0.42, 0.22];

  const yCategories = ['Outflow', 'Inflow'];

  _reachChart.setOption({
    backgroundColor: 'transparent', animation: true, animationDuration: 400,
    legend: {
      top: 2, left: 'center', itemWidth: 8, itemHeight: 8,
      textStyle: { color: tc.muted, fontSize: 9 },
      data: REACH_LABELS.map((l, i) => ({ name: l, icon: 'rect', itemStyle: { color: `rgba(${outflowRgb},${opacities[i]})` } })),
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: tc.ttBg, borderColor: tc.ttBorder,
      textStyle: { color: tc.text, fontSize: 11 },
      formatter: params => {
        const cat   = params[0]?.name;
        const isOut = cat === 'Outflow';
        const buckets = isOut ? outB : inB;
        const total   = isOut ? outT : inT;
        return [
          `<strong>${cat}</strong>`,
          ...REACH_LABELS.map((l, i) => `${l}: <strong>${buckets[i].toLocaleString()}</strong> (${Math.round(buckets[i]/total*100)}%)`),
        ].join('<br/>');
      },
    },
    grid: { top: 20, right: 10, bottom: 4, left: 4, containLabel: true },
    xAxis: {
      type: 'value', max: 100, axisLabel: { show: false },
      splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false },
    },
    yAxis: {
      type: 'category', data: yCategories,
      axisLabel: { color: tc.text, fontSize: 10 },
      axisLine: { lineStyle: { color: tc.axis } }, axisTick: { show: false },
    },
    series: REACH_LABELS.map((label, i) => ({
      name: label, type: 'bar', stack: 'total', barMaxWidth: 28,
      data: [
        // Outflow row: outflow palette
        { value: Math.round(outB[i] / outT * 100), itemStyle: { color: `rgba(${outflowRgb},${opacities[i]})` } },
        // Inflow row: inflow palette
        { value: Math.round(inB[i]  / inT  * 100), itemStyle: { color: `rgba(${inflowRgb},${opacities[i]})` } },
      ],
      label: {
        show: true, color: i < 2 ? '#fff' : tc.text, fontSize: 8, fontWeight: 600,
        formatter: p => p.value >= 9 ? `${p.value}%` : '',
      },
      emphasis: { itemStyle: { opacity: 0.9 } },
    })),
  }, true);

  _reachChart.resize();
}

// ── 5. Industry Mix — stacked vertical bar per top-5 destination/origin ───────

function _renderIndustry(outflows, inflows, state) {
  if (!_industryChart) return;
  const tc    = _tc(state.theme);
  const flows = _industryDir === 'outflow' ? outflows : inflows;
  const top5  = flows.slice(0, 5);
  if (!top5.length) { _industryChart.clear(); return; }

  const dk       = state.theme === 'dark';
  const goodsCol = dk ? '#b58e54' : '#8b6b3a';

  const names    = top5.map(f => f.dest_name);
  const goods    = top5.map(f => Number(f.SI01 || 0));
  const trade    = top5.map(f => Number(f.SI02 || 0));
  const services = top5.map(f => Number(f.SI03 || 0));

  _industryChart.setOption({
    backgroundColor: 'transparent', animation: true, animationDuration: 400,
    legend: {
      top: 2, left: 'center', itemWidth: 10, itemHeight: 8,
      textStyle: { color: tc.muted, fontSize: 9 },
      data: [
        { name: 'Goods',           icon: 'rect', itemStyle: { color: goodsCol   } },
        { name: 'Trade/Transport', icon: 'rect', itemStyle: { color: tc.outflow } },
        { name: 'Services',        icon: 'rect', itemStyle: { color: tc.inflow  } },
      ],
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: tc.ttBg, borderColor: tc.ttBorder,
      textStyle: { color: tc.text, fontSize: 11 },
      formatter: params => {
        const city  = params[0]?.name;
        const total = params.reduce((s, p) => s + p.value, 0);
        const lines = [`<strong>${city}</strong>`];
        params.forEach(p => {
          const pct = total > 0 ? ((p.value / total) * 100).toFixed(0) : '0';
          lines.push(`<span style="color:${p.color}">■</span> ${p.seriesName}: <strong>${Number(p.value).toLocaleString()}</strong> (${pct}%)`);
        });
        return lines.join('<br/>');
      },
    },
    grid: { top: 22, right: 8, bottom: 4, left: 4, containLabel: true },
    xAxis: {
      type: 'category', data: names,
      axisLabel: { color: tc.text, fontSize: 9, interval: 0, overflow: 'truncate', width: 72, rotate: -20 },
      axisLine: { lineStyle: { color: tc.axis } }, axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: tc.muted, fontSize: 9, formatter: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v) },
      splitLine: { lineStyle: { color: tc.axis } },
      axisLine: { show: false }, axisTick: { show: false },
    },
    series: [
      { name: 'Goods',           type: 'bar', stack: 'total', data: goods,    itemStyle: { color: goodsCol   }, emphasis: { itemStyle: { opacity: 0.85 } } },
      { name: 'Trade/Transport', type: 'bar', stack: 'total', data: trade,    itemStyle: { color: tc.outflow }, emphasis: { itemStyle: { opacity: 0.85 } } },
      { name: 'Services',        type: 'bar', stack: 'total', data: services, itemStyle: { color: tc.inflow  }, emphasis: { itemStyle: { opacity: 0.85 } } },
    ],
  }, true);

  _industryChart.resize();
  _industryChart.off('click');
  _industryChart.on('click', params => {
    if (params.componentType === 'series' && params.name) _onAreaSelect?.(params.name, state.aggregation);
  });
}

// ── Download helpers ──────────────────────────────────────────────────────────

function _pngDownload(chart, filename) {
  if (!chart || !_lastState) return;
  const bg = _lastState.theme === 'dark' ? '#0a0e17' : '#f6f3eb';
  _dlUrl(chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: bg }), `${filename}.png`);
}

function _csvDownload(rows, filename) {
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  _dlUrl(url, `${filename}.csv`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _dlUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
}
