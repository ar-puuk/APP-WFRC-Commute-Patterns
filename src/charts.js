import * as echarts from 'echarts';

let _demoChart     = null;
let _onAreaSelect  = null;
let _sankeyTooltip = null;

let _lastOutflows  = [];
let _lastInflows   = [];
let _lastTotalOut  = 0;
let _lastTotalIn   = 0;
let _lastSelfFlow  = 0;
let _lastState     = null;
let _lastAcsEntry  = null;

// Per-chart UI state (not reset on data change)
let _demoDimension = 'age';      // 'age' | 'earnings' | 'industry'
let _industryDir   = 'outflow';  // 'outflow' | 'inflow'

// ── Public API ────────────────────────────────────────────────────────────────

export function initCharts(onAreaSelect) {
  _onAreaSelect = onAreaSelect;

  const demoEl = document.getElementById('demo-chart');
  if (demoEl) _demoChart = echarts.init(demoEl, null, { renderer: 'canvas' });

  const ro = new ResizeObserver(() => { _demoChart?.resize(); });
  if (demoEl) ro.observe(demoEl);

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
        requestAnimationFrame(() => { _demoChart?.resize(); });
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

export function updateCharts(outflows, inflows, totalOut, totalIn, selfFlow, appState, acsEntry) {
  _lastOutflows = outflows;
  _lastInflows  = inflows;
  _lastTotalOut = totalOut;
  _lastTotalIn  = totalIn;
  _lastSelfFlow = selfFlow ?? 0;
  _lastState    = appState;
  _lastAcsEntry = acsEntry ?? null;

  _renderBar(outflows, inflows, totalOut, totalIn, appState);
  _renderSankey(outflows, inflows, appState);
  _renderFlowSummary(totalIn, totalOut, selfFlow ?? 0, appState);
  _renderDemographics(outflows, inflows, appState);
  _renderReach(outflows, inflows, appState);
  _renderIndustry(outflows, inflows, appState);
  _renderTransport(acsEntry, appState);
  _renderTravelTime(acsEntry, appState);
}

// ── Exports ───────────────────────────────────────────────────────────────────

export function exportBarPng() {
  if (!_lastState) return;
  const { rows: allRows } = _mergeFlows(_lastOutflows, _lastInflows, 10);
  const rows = allRows.filter(r => !r.isOthers);
  if (!rows.length) return;

  const dk      = _lastState.theme === 'dark';
  const W       = 560, PAD = 24;
  const NUM_W   = 50, NAME_W = 110;
  const SIDE_W  = (W - PAD * 2 - NUM_W * 2 - NAME_W) / 2;
  const ROW_H   = 22, BAR_H = 14;
  const LEGEND_H = 28, AXIS_H = 22;
  const H = PAD + LEGEND_H + AXIS_H + rows.length * ROW_H + PAD;

  const canvas = document.createElement('canvas');
  canvas.width  = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const bg       = dk ? '#0a0e17' : '#f6f3eb';
  const ink      = dk ? '#e8e5dc' : '#121726';
  const ink3     = dk ? '#92929a' : '#5b6071';
  const ink4     = dk ? '#696a73' : '#898d9c';
  const ruleStr  = dk ? 'rgba(232,229,220,0.20)' : 'rgba(18,23,38,0.22)';
  const highlight = dk ? '#1a1f30' : '#f4ecd9';
  const inflow   = dk ? '#5aa6a7' : '#1e6f6f';
  const outflow  = dk ? '#e4895a' : '#cc683a';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const max     = Math.max(...rows.flatMap(r => [r.out, r.in]));
  const step    = max <= 6000 ? 2000 : max <= 12000 ? 4000 : 8000;
  const axisMax = Math.ceil(max / step) * step || 1;
  const bw      = n => (n / axisMax) * SIDE_W;

  // x anchors
  const xInNum   = PAD;
  const xInSide  = PAD + NUM_W;
  const xName    = PAD + NUM_W + SIDE_W;
  const xOutSide = PAD + NUM_W + SIDE_W + NAME_W;
  const xOutNum  = PAD + NUM_W + SIDE_W + NAME_W + SIDE_W;

  let y = PAD;

  // Legend
  const pipS = 8;
  ctx.fillStyle = inflow;
  ctx.fillRect(W / 2 - 60, y + (LEGEND_H - pipS) / 2, pipS, pipS);
  ctx.fillStyle = ink3;
  ctx.font = '600 10.5px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('INFLOW', W / 2 - 60 + pipS + 6, y + LEGEND_H / 2);
  ctx.fillStyle = outflow;
  ctx.fillRect(W / 2 + 10, y + (LEGEND_H - pipS) / 2, pipS, pipS);
  ctx.fillStyle = ink3;
  ctx.fillText('OUTFLOW', W / 2 + 10 + pipS + 6, y + LEGEND_H / 2);
  y += LEGEND_H;

  // Axis line
  ctx.fillStyle = ruleStr;
  ctx.fillRect(xInSide, y + AXIS_H - 1, SIDE_W * 2 + NAME_W, 1);

  ctx.font = '400 9.5px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink4;
  ctx.textAlign = 'left';
  ctx.fillText(axisMax.toLocaleString(), xInNum + 2, y + AXIS_H - 4);
  ctx.textAlign = 'center';
  ctx.fillStyle = ink3;
  ctx.fillText('0', xName + NAME_W / 2, y + AXIS_H - 4);
  ctx.textAlign = 'right';
  ctx.fillStyle = ink4;
  ctx.fillText(axisMax.toLocaleString(), xOutNum + NUM_W - 2, y + AXIS_H - 4);
  y += AXIS_H;

  // Rows
  rows.forEach((r, i) => {
    if (i % 2 === 0) {
      ctx.fillStyle = highlight;
      ctx.fillRect(PAD, y, W - PAD * 2, ROW_H);
    }

    const barY = y + (ROW_H - BAR_H) / 2;

    // Inflow bar (right-aligned inside left side)
    ctx.fillStyle = inflow;
    const inW = bw(r.in);
    ctx.fillRect(xInSide + SIDE_W - inW, barY, inW, BAR_H);

    // Outflow bar (left-aligned inside right side)
    ctx.fillStyle = outflow;
    ctx.fillRect(xOutSide, barY, bw(r.out), BAR_H);

    // Numbers
    ctx.fillStyle = ink;
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText(r.in.toLocaleString(),  xInSide - 4,       y + ROW_H / 2);
    ctx.textAlign = 'left';
    ctx.fillText(r.out.toLocaleString(), xOutNum + 4,       y + ROW_H / 2);

    // City name
    ctx.fillStyle = ink3;
    ctx.font = '500 11.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(r.name, xName + NAME_W / 2, y + ROW_H / 2, NAME_W - 8);

    y += ROW_H;
  });

  const area = _lastState.selectedArea ?? 'chart';
  _dlUrl(canvas.toDataURL('image/png'), `commute-balance-${area}-${_lastState.year ?? ''}.png`);
}
export function exportSankeyPng() {
  const svgEl    = document.getElementById('sankey-svg');
  const sumSvgEl = document.getElementById('flow-summary')?.querySelector('svg');
  if (!svgEl || !_lastState) return;
  const dk   = _lastState.theme === 'dark';
  const font = 'Inter, system-ui, sans-serif';
  const bgCol  = dk ? '#0a0e17' : '#f6f3eb';
  const ruleCol = dk ? 'rgba(232,229,220,0.15)' : 'rgba(18,23,38,0.15)';

  const vars = {
    '--inflow':    dk ? '#5aa6a7' : '#1e6f6f',
    '--inflow-2':  dk ? '#408687' : '#155656',
    '--outflow':   dk ? '#e4895a' : '#cc683a',
    '--outflow-2': dk ? '#c5703f' : '#b35828',
    '--ink':       dk ? '#e8e5dc' : '#121726',
    '--ink-2':     dk ? '#c4c1b8' : '#2a2f40',
    '--ink-3':     dk ? '#92929a' : '#5b6071',
    '--ink-4':     dk ? '#696a73' : '#898d9c',
  };

  function resolveVarFills(el) {
    el.querySelectorAll('[fill]').forEach(n => {
      const m = n.getAttribute('fill').match(/var\((--[^)]+)\)/);
      if (m && vars[m[1]]) n.setAttribute('fill', vars[m[1]]);
    });
  }

  function svgToImage(clone) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const xml  = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.src = url;
    });
  }

  // ── Sankey clone ──────────────────────────────────────────────
  const sankeyClone = svgEl.cloneNode(true);
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('width', '460'); bgRect.setAttribute('height', '280');
  bgRect.setAttribute('fill', bgCol);
  sankeyClone.insertBefore(bgRect, sankeyClone.firstChild);
  resolveVarFills(sankeyClone);
  sankeyClone.querySelectorAll('.sankey-label').forEach(el => {
    el.setAttribute('font-size', '10.5'); el.setAttribute('font-weight', '600');
    el.setAttribute('font-family', font); el.setAttribute('fill', vars['--ink-2']);
    if (el.classList.contains('in'))     el.setAttribute('fill', vars['--inflow-2']);
    if (el.classList.contains('out'))    el.setAttribute('fill', vars['--outflow-2']);
    if (el.classList.contains('center')) { el.setAttribute('fill', vars['--ink']); el.setAttribute('font-weight', '700'); el.setAttribute('font-size', '12'); }
  });
  sankeyClone.querySelectorAll('.sankey-num').forEach(el => {
    el.setAttribute('font-size', '9.5'); el.setAttribute('font-weight', '500');
    el.setAttribute('font-family', font); el.setAttribute('fill', vars['--ink-4']);
  });

  // ── Flow summary clone ────────────────────────────────────────
  const SUM_H = 92;
  let sumPromise = Promise.resolve(null);
  if (sumSvgEl) {
    const sumClone = sumSvgEl.cloneNode(true);
    resolveVarFills(sumClone);
    sumClone.querySelectorAll('.fs-val').forEach(el => {
      el.setAttribute('font-size', '11.5'); el.setAttribute('font-weight', '700');
      el.setAttribute('font-family', font); el.setAttribute('fill', vars['--ink-3']);
      if (el.classList.contains('in'))  el.setAttribute('fill', vars['--inflow-2']);
      if (el.classList.contains('out')) el.setAttribute('fill', vars['--outflow-2']);
    });
    sumClone.querySelectorAll('.fs-lbl').forEach(el => {
      el.setAttribute('font-size', '9'); el.setAttribute('font-weight', '400');
      el.setAttribute('font-family', font); el.setAttribute('fill', vars['--ink-4']);
    });
    sumPromise = svgToImage(sumClone);
  }

  Promise.all([svgToImage(sankeyClone), sumPromise]).then(([sankeyImg, sumImg]) => {
    const TOTAL_H = 280 + (sumImg ? 1 + SUM_H : 0);
    const canvas  = document.createElement('canvas');
    canvas.width  = 920; canvas.height = TOTAL_H * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.fillStyle = bgCol;
    ctx.fillRect(0, 0, 460, TOTAL_H);
    ctx.drawImage(sankeyImg, 0, 0, 460, 280);
    if (sumImg) {
      ctx.fillStyle = ruleCol;
      ctx.fillRect(0, 280, 460, 1);
      ctx.drawImage(sumImg, 0, 281, 460, SUM_H);
    }
    _dlUrl(canvas.toDataURL('image/png'), `commute-flow-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}.png`);
  });
}
export function exportDemoPng() {
  _pngDownload(_demoChart, `worker-demographics-${_lastState?.selectedArea ?? 'chart'}-${_lastState?.year ?? ''}`);
}
export function exportReachPng() {
  if (!_lastState) return;
  const outB = _bucketFlows(_lastOutflows);
  const inB  = _bucketFlows(_lastInflows);
  const outT = outB.reduce((s, v) => s + v, 0) || 1;
  const inT  = inB.reduce((s, v) => s + v, 0) || 1;
  const dk   = _lastState.theme === 'dark';

  // Band colors per direction — approximating color-mix(in oklab, base, paper X%)
  // Outflow (orange): #cc683a light / #e4895a dark; Inflow (teal): #1e6f6f light / #5aa6a7 dark
  const outflowBands = dk
    ? ['#e4895a', '#d07344', '#bc5d2e', '#a84a1e']   // dark outflow tints (8/26/44/62% paper)
    : ['#cc683a', '#b85528', '#a44216', '#904000'];   // light outflow tints
  const inflowBands = dk
    ? ['#5aa6a7', '#478e8f', '#347677', '#215e5f']    // dark inflow tints
    : ['#1e6f6f', '#185a5a', '#124545', '#0c3030'];   // light inflow tints

  const W = 560, PAD = 24, LBL_W = 84, BAR_H = 36, ROW_GAP = 10;
  const LGD_ROW_H = 16;
  const H = PAD + BAR_H + ROW_GAP + BAR_H + 14 + 1 + 10 + LGD_ROW_H + PAD;

  const canvas = document.createElement('canvas');
  canvas.width  = W * 2; canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const bg    = dk ? '#0a0e17' : '#f6f3eb';
  const ink4  = dk ? '#696a73' : '#898d9c';
  const rule  = dk ? 'rgba(232,229,220,0.20)' : 'rgba(18,23,38,0.22)';
  const paper = dk ? '#0a0e17' : '#f6f3eb';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const barW = W - PAD - LBL_W - PAD;
  const barX = PAD + LBL_W;

  function drawRow(buckets, total, y, label, bandColors) {
    ctx.fillStyle = ink4;
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, PAD, y + BAR_H / 2);

    let x = barX;
    buckets.forEach((n, i) => {
      const pct = n / total;
      const sw  = pct * barW;
      if (sw < 0.5) { x += sw; return; }
      ctx.fillStyle = bandColors[i];
      ctx.fillRect(x, y, sw, BAR_H);
      if (pct >= 0.10) {
        ctx.fillStyle = paper;
        ctx.font = '700 11px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(pct * 100)}%`, x + sw / 2, y + BAR_H / 2);
      }
      x += sw;
    });
  }

  let y = PAD;
  drawRow(outB, outT, y, 'Outflow', outflowBands);
  y += BAR_H + ROW_GAP;
  drawRow(inB,  inT,  y, 'Inflow',  inflowBands);
  y += BAR_H + 14;

  ctx.fillStyle = rule;
  ctx.fillRect(PAD, y, W - PAD * 2, 1);
  y += 10;

  const SW = 13;
  let lx = PAD;
  ctx.font = '600 10px Inter, system-ui, sans-serif';
  REACH_LABELS.forEach((lbl, i) => {
    // Top-left triangle — inflow
    ctx.fillStyle = inflowBands[i];
    ctx.beginPath();
    ctx.moveTo(lx,      y);
    ctx.lineTo(lx + SW, y);
    ctx.lineTo(lx,      y + SW);
    ctx.closePath();
    ctx.fill();
    // Bottom-right triangle — outflow
    ctx.fillStyle = outflowBands[i];
    ctx.beginPath();
    ctx.moveTo(lx + SW, y);
    ctx.lineTo(lx + SW, y + SW);
    ctx.lineTo(lx,      y + SW);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = ink4;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(lbl, lx + SW + 5, y + SW / 2);
    lx += SW + 5 + ctx.measureText(lbl).width + 14;
  });

  _dlUrl(canvas.toDataURL('image/png'), `commute-reach-${_lastState.selectedArea ?? 'chart'}-${_lastState.year ?? ''}.png`);
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

export function exportIndustryPng() {
  if (!_lastState) return;
  const flows = _industryDir === 'outflow' ? _lastOutflows : _lastInflows;
  const top5  = flows.slice(0, 5);
  if (!top5.length) return;

  const totals   = top5.map(f => Number(f.SI01||0) + Number(f.SI02||0) + Number(f.SI03||0));
  const maxTotal = Math.max(...totals) || 1;
  const dk       = _lastState.theme === 'dark';

  const W = 560, PAD = 24, BAR_H = 12, ROW_GAP = 14, HEAD_H = 18;
  const ROW_H = HEAD_H + BAR_H + ROW_GAP;
  const H = PAD + top5.length * ROW_H + 20 + 22 + PAD; // rows + legend rule + legend + padding

  const canvas = document.createElement('canvas');
  canvas.width  = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const bg      = dk ? '#0a0e17' : '#f6f3eb';
  const ink     = dk ? '#e8e5dc' : '#121726';
  const ink3    = dk ? '#92929a' : '#5b6071';
  const ruleBg  = dk ? 'rgba(232,229,220,0.09)' : 'rgba(18,23,38,0.10)';
  const ruleStr = dk ? 'rgba(232,229,220,0.20)' : 'rgba(18,23,38,0.22)';
  const goodsC  = dk ? '#b58e54' : '#8b6b3a';
  const tradeC  = dk ? '#e4895a' : '#cc683a';
  const servC   = dk ? '#5aa6a7' : '#1e6f6f';
  const paper   = dk ? '#0a0e17' : '#f6f3eb';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const maxBarW = W - PAD * 2;
  let y = PAD;

  top5.forEach((f, i) => {
    const total = totals[i];
    const gN = Number(f.SI01 || 0);
    const tN = Number(f.SI02 || 0);
    const sN = Number(f.SI03 || 0);
    const barW = (total / maxTotal) * maxBarW;

    // ir-head
    ctx.fillStyle = ink;
    ctx.font = '600 11.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(f.dest_name, PAD, y + HEAD_H / 2);
    ctx.fillStyle = ink3;
    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(total.toLocaleString(), W - PAD, y + HEAD_H / 2);

    y += HEAD_H;

    // Bar background
    ctx.fillStyle = ruleBg;
    ctx.fillRect(PAD, y, maxBarW, BAR_H);

    // Segments
    let x = PAD;
    [{ n: gN, c: goodsC }, { n: tN, c: tradeC }, { n: sN, c: servC }].forEach(seg => {
      const sw = total > 0 ? (seg.n / total) * barW : 0;
      if (sw < 0.5) { x += sw; return; }
      ctx.fillStyle = seg.c;
      ctx.fillRect(x, y, sw, BAR_H);
      const pct = total > 0 ? seg.n / total : 0;
      if (pct >= 0.18) {
        ctx.fillStyle = paper;
        ctx.font = '700 9px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(pct * 100)}%`, x + sw / 2, y + BAR_H / 2);
      }
      x += sw;
    });

    y += BAR_H + ROW_GAP;
  });

  // Legend
  ctx.fillStyle = ruleStr;
  ctx.fillRect(PAD, y, maxBarW, 1);
  y += 11;

  let lx = PAD;
  [{ label: 'GOODS', c: goodsC }, { label: 'TRADE', c: tradeC }, { label: 'SERVICES', c: servC }].forEach(item => {
    ctx.fillStyle = item.c;
    ctx.fillRect(lx, y, 10, 10);
    ctx.fillStyle = ink3;
    ctx.font = '600 10.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.label, lx + 14, y + 5);
    lx += 14 + ctx.measureText(item.label).width + 16;
  });

  const area = _lastState.selectedArea ?? 'chart';
  _dlUrl(canvas.toDataURL('image/png'), `industry-mix-${area}-${_lastState.year ?? ''}.png`);
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
  _demoChart?.resize();
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

// ── 1. Commute Balance — hand-built diverging bar (design-spec HTML) ──────────

function _renderBar(outflows, inflows, totalOut, totalIn, state) {
  const rowsEl = document.getElementById('balance-rows');
  const axisL  = document.getElementById('balance-axis-l');
  const axisR  = document.getElementById('balance-axis-r');
  if (!rowsEl) return;

  const { rows: allRows } = _mergeFlows(outflows, inflows, 10);
  const rows = allRows.filter(r => !r.isOthers);
  if (!rows.length) { rowsEl.innerHTML = ''; return; }

  const max     = Math.max(...rows.flatMap(r => [r.out, r.in]));
  const step    = max <= 6000 ? 2000 : max <= 12000 ? 4000 : 8000;
  const axisMax = Math.ceil(max / step) * step || 1;
  const bw      = n => ((n / axisMax) * 100).toFixed(2);

  if (axisL) axisL.textContent = axisMax.toLocaleString();
  if (axisR) axisR.textContent = axisMax.toLocaleString();

  rowsEl.innerHTML = rows.map(r => `
    <div class="balance-row" data-peer="${r.name}">
      <div class="b-num left">${r.in.toLocaleString()}</div>
      <div class="b-side left"><div class="b-bar in" style="width:${bw(r.in)}%"></div></div>
      <div class="b-name">${r.name}</div>
      <div class="b-side right"><div class="b-bar" style="width:${bw(r.out)}%"></div></div>
      <div class="b-num right">${r.out.toLocaleString()}</div>
    </div>
  `).join('');

  rowsEl.querySelectorAll('.balance-row').forEach(el => {
    el.addEventListener('click', () => {
      _onAreaSelect?.(el.dataset.peer, state.aggregation);
    });
  });
}

// ── Shared ribbon path (used by Sankey + flow summary) ───────────────────────
function _ribbonPath(x1, y1, h1, x2, y2, h2) {
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1},${cx} ${y2},${x2} ${y2} L ${x2} ${y2+h2} C ${cx} ${y2+h2},${cx} ${y1+h1},${x1} ${y1+h1} Z`;
}

function _ensureSankeyTooltip() {
  if (!_sankeyTooltip) {
    _sankeyTooltip = document.createElement('div');
    _sankeyTooltip.className = 'sankey-tooltip';
    document.body.appendChild(_sankeyTooltip);
  }
  return _sankeyTooltip;
}

// ── 2. Flow Diagram — bilateral SVG alluvial ──────────────────────────────────

function _renderSankey(outflows, inflows, state) {
  const svgEl = document.getElementById('sankey-svg');
  if (!svgEl) return;

  const sel = state.selectedArea;
  if (!inflows.length && !outflows.length) { svgEl.innerHTML = ''; return; }

  function trunc(str, max = 14) {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  // Include cities that represent ≥5% of their side's total, up to 6. Fall back to top 3.
  function buildSide(flows) {
    const sideTotal = flows.reduce((s, f) => s + Number(f.S000), 0) || 1;
    const included  = [];
    for (const f of flows) {
      const n = Number(f.S000);
      if (n / sideTotal >= 0.05 && included.length < 6) included.push({ name: f.dest_name, n });
      else break;
    }
    if (included.length < 3) {
      included.length = 0;
      flows.slice(0, 3).forEach(f => included.push({ name: f.dest_name, n: Number(f.S000) }));
    }
    const othersN = flows.slice(included.length).reduce((s, f) => s + Number(f.S000), 0);
    return othersN > 0 ? [...included, { name: 'Others', n: othersN, isOthers: true }] : included;
  }

  const inSide   = buildSide(inflows);
  const outSide  = buildSide(outflows);
  const inTotal  = inSide.reduce((s, d) => s + d.n, 0);
  const outTotal = outSide.reduce((s, d) => s + d.n, 0);

  const nShown = Math.max(inSide.filter(d => !d.isOthers).length, outSide.filter(d => !d.isOthers).length);
  const subEl  = document.getElementById('sankey-sub');
  if (subEl) subEl.textContent = `02 · Top ${nShown} by volume`;

  const W = 460, H = 280, PAD = 10;
  const LABEL_PAD = 90, CENTER_W = 120, SIDE_W = 14;
  const totalH   = H - PAD * 2;
  const maxTotal = Math.max(inTotal, outTotal, 1);
  const scale    = totalH / maxTotal;

  function makeBlocks(side, total, x) {
    let y = PAD + (totalH - total * scale) / 2;
    return side.map(s => {
      const h = Math.max(s.n * scale, 2);
      const b = { ...s, x, y, w: SIDE_W, h };
      y += h;
      return b;
    });
  }

  const leftBlocks  = makeBlocks(inSide,  inTotal,  LABEL_PAD);
  const rightBlocks = makeBlocks(outSide, outTotal, W - LABEL_PAD - SIDE_W);

  const centerX    = (W - CENTER_W) / 2;
  const centerInH  = inTotal  * scale;
  const centerOutH = outTotal * scale;
  const centerInY  = PAD + (totalH - centerInH)  / 2;
  const centerOutY = PAD + (totalH - centerOutH) / 2;

  // ribbonData includes n + sideTotal for tooltip percentage
  const ribbonData = [];
  let leftY = centerInY;
  leftBlocks.forEach(b => {
    ribbonData.push({ d: _ribbonPath(b.x + b.w, b.y, b.h, centerX, leftY, b.h), color: 'var(--inflow)', name: b.name, n: b.n, sideTotal: inTotal, isOthers: b.isOthers });
    leftY += b.h;
  });
  let rightY = centerOutY;
  rightBlocks.forEach(b => {
    ribbonData.push({ d: _ribbonPath(centerX + CENTER_W, rightY, b.h, b.x, b.y, b.h), color: 'var(--outflow)', name: b.name, n: b.n, sideTotal: outTotal, isOthers: b.isOthers });
    rightY += b.h;
  });

  const BASE_OPACITY = 0.52;

  const ribbonMarkup = ribbonData.map((r, i) =>
    `<path class="sankey-ribbon" data-idx="${i}" d="${r.d}" fill="${r.color}" opacity="${r.isOthers ? BASE_OPACITY * 0.55 : BASE_OPACITY}"/>`
  ).join('');

  const leftMarkup = leftBlocks.map(b => {
    const my = b.y + b.h / 2;
    const op = b.isOthers ? '0.4' : '0.82';
    return `<g class="sankey-block">
      <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="var(--inflow)" opacity="${op}" rx="1"/>
      <text x="${b.x - 7}" y="${my + 3}" text-anchor="end" class="sankey-label in">${trunc(b.name)}</text>
      <text x="${b.x - 7}" y="${my + 14}" text-anchor="end" class="sankey-num">${b.n.toLocaleString()}</text>
    </g>`;
  }).join('');

  const rightMarkup = rightBlocks.map(b => {
    const my = b.y + b.h / 2;
    const op = b.isOthers ? '0.4' : '0.82';
    return `<g class="sankey-block">
      <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="var(--outflow)" opacity="${op}" rx="1"/>
      <text x="${b.x + b.w + 7}" y="${my + 3}" text-anchor="start" class="sankey-label out">${trunc(b.name)}</text>
      <text x="${b.x + b.w + 7}" y="${my + 14}" text-anchor="start" class="sankey-num">${b.n.toLocaleString()}</text>
    </g>`;
  }).join('');

  // Center node: split halves showing inflow/outflow proportion, area name centered
  const centerTopY    = Math.min(centerInY, centerOutY);
  const centerBottomY = Math.max(centerInY + centerInH, centerOutY + centerOutH);
  const centerMarkup  = `
    <rect x="${centerX}"              y="${centerInY}"  width="${CENTER_W/2}" height="${centerInH}"  fill="var(--inflow-2)"  opacity="0.82" rx="1"/>
    <rect x="${centerX + CENTER_W/2}" y="${centerOutY}" width="${CENTER_W/2}" height="${centerOutH}" fill="var(--outflow-2)" opacity="0.82" rx="1"/>
    <text x="${W/2}" y="${(centerTopY + centerBottomY) / 2 + 4}" text-anchor="middle" class="sankey-label center">${trunc(sel, 16)}</text>`;

  svgEl.innerHTML = ribbonMarkup + leftMarkup + centerMarkup + rightMarkup;

  // Hover: highlight matching ribbons, show custom tooltip
  const paths = svgEl.querySelectorAll('.sankey-ribbon');
  paths.forEach((path, i) => {
    const rd = ribbonData[i];

    path.addEventListener('mouseenter', () => {
      paths.forEach((p, j) => {
        const jBase = ribbonData[j].isOthers ? BASE_OPACITY * 0.55 : BASE_OPACITY;
        p.setAttribute('opacity', ribbonData[j].name === rd.name ? String(Math.min(jBase + 0.25, 1)) : '0.12');
      });
    });

    path.addEventListener('mousemove', (e) => {
      const tt  = _ensureSankeyTooltip();
      const pct = rd.sideTotal > 0 ? Math.round(rd.n / rd.sideTotal * 100) : 0;
      tt.innerHTML = `<strong>${rd.name}</strong><br>${rd.n.toLocaleString()} commuters · ${pct}%`;
      tt.style.display = 'block';
      tt.style.left    = `${e.clientX + 14}px`;
      tt.style.top     = `${e.clientY - 32}px`;
    });

    path.addEventListener('mouseleave', () => {
      paths.forEach((p, j) => {
        p.setAttribute('opacity', String(ribbonData[j].isOthers ? BASE_OPACITY * 0.55 : BASE_OPACITY));
      });
      if (_sankeyTooltip) _sankeyTooltip.style.display = 'none';
    });

    path.style.cursor = rd.isOthers ? 'default' : 'pointer';
    if (!rd.isOthers) path.addEventListener('click', () => _onAreaSelect?.(rd.name, state.aggregation));
  });
}

// ── 2b. Flow Summary — total inflow / self-flow / total outflow bars ──────────

function _renderFlowSummary(totalIn, totalOut, selfFlow, state) {
  const el = document.getElementById('flow-summary');
  if (!el) return;

  function fmt(n) {
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000)  return `${parseFloat((n / 1000).toFixed(1))}k`;
    return n ? n.toLocaleString() : '—';
  }

  const W = 460, H = 92;
  const TOP_PAD = 22, BAR_H = 50, BOTTOM_PAD = 20;
  const BASE_Y  = TOP_PAD + BAR_H;   // y=72, bottom of bars
  const COLW = 88, GUTTER = 38;
  const START_X = (W - (3 * COLW + 2 * GUTTER)) / 2; // ≈ 57

  const inX   = START_X;
  const selfX = START_X + COLW + GUTTER;
  const outX  = START_X + 2 * (COLW + GUTTER);

  const maxVal = Math.max(totalIn, totalOut, selfFlow, 1);
  const inH    = Math.max((totalIn  / maxVal) * BAR_H, 4);
  const selfH  = Math.max((selfFlow / maxVal) * BAR_H, 4);
  const outH   = Math.max((totalOut / maxVal) * BAR_H, 4);

  const inY   = BASE_Y - inH;
  const selfY = BASE_Y - selfH;
  const outY  = BASE_Y - outH;

  const ribIn  = _ribbonPath(inX + COLW, inY,   inH,   selfX,        selfY, selfH);
  const ribOut = _ribbonPath(selfX + COLW, selfY, selfH, outX,        outY,  outH);

  const selfPct = totalOut > 0 ? Math.round(selfFlow / (totalOut + selfFlow) * 100) : 0;

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block;overflow:visible">
      <path d="${ribIn}"  fill="var(--inflow)"  opacity="0.15"/>
      <path d="${ribOut}" fill="var(--outflow)" opacity="0.15"/>

      <rect x="${inX}"   y="${inY}"   width="${COLW}" height="${inH}"   fill="var(--inflow)"  opacity="0.72" rx="2"/>
      <rect x="${selfX}" y="${selfY}" width="${COLW}" height="${selfH}" fill="var(--ink-3)"   opacity="0.45" rx="2"/>
      <rect x="${outX}"  y="${outY}"  width="${COLW}" height="${outH}"  fill="var(--outflow)" opacity="0.72" rx="2"/>

      <text x="${inX   + COLW/2}" y="${inY   - 5}" text-anchor="middle" class="fs-val in">${fmt(totalIn)}</text>
      <text x="${selfX + COLW/2}" y="${selfY - 5}" text-anchor="middle" class="fs-val">${fmt(selfFlow)}</text>
      <text x="${outX  + COLW/2}" y="${outY  - 5}" text-anchor="middle" class="fs-val out">${fmt(totalOut)}</text>

      <text x="${inX   + COLW/2}" y="${BASE_Y + 14}" text-anchor="middle" class="fs-lbl">workers in</text>
      <text x="${selfX + COLW/2}" y="${BASE_Y + 14}" text-anchor="middle" class="fs-lbl">live &amp; work · ${selfPct}%</text>
      <text x="${outX  + COLW/2}" y="${BASE_Y + 14}" text-anchor="middle" class="fs-lbl">residents out</text>
    </svg>`;
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

// ── 4. Commute Reach — distance-band stacked bars (HTML/CSS) ─────────────────

function _renderReach(outflows, inflows, state) {
  const bandsEl  = document.getElementById('reach-bands');
  const legendEl = document.getElementById('reach-legend');
  if (!bandsEl) return;

  const outB = _bucketFlows(outflows);
  const inB  = _bucketFlows(inflows);
  const outT = outB.reduce((s, v) => s + v, 0) || 1;
  const inT  = inB.reduce((s, v) => s + v, 0) || 1;

  function row(label, buckets, total, dirClass) {
    const segs = buckets.map((n, i) => {
      const pct = n / total;
      const w   = (pct * 100).toFixed(1);
      return `<span class="rb-${i}" style="width:${w}%">${pct >= 0.10 ? Math.round(pct * 100) + '%' : ''}</span>`;
    }).join('');
    return `<div class="reach-row ${dirClass}"><span class="reach-row-lbl">${label}</span><div class="reach-bar">${segs}</div></div>`;
  }

  bandsEl.innerHTML = row('Outflow', outB, outT, 'outflow') + row('Inflow', inB, inT, 'inflow');

  if (legendEl) {
    legendEl.innerHTML = REACH_LABELS.map((l, i) =>
      `<span class="rk"><span class="rk-sw rk-diag-${i}"></span>${l}</span>`
    ).join('');
  }
}

// ── 5. Industry Mix — hand-built horizontal stacked bars (design-spec HTML) ───

function _renderIndustry(outflows, inflows, state) {
  const stackEl = document.getElementById('industry-stack');
  if (!stackEl) return;

  const flows = _industryDir === 'outflow' ? outflows : inflows;
  const top5  = flows.slice(0, 5);
  if (!top5.length) { stackEl.innerHTML = ''; return; }

  const totals   = top5.map(f => Number(f.SI01||0) + Number(f.SI02||0) + Number(f.SI03||0));
  const maxTotal = Math.max(...totals) || 1;

  stackEl.innerHTML = top5.map((f, i) => {
    const total    = totals[i];
    const goods    = Number(f.SI01 || 0);
    const trade    = Number(f.SI02 || 0);
    const services = Number(f.SI03 || 0);
    const barW     = ((total / maxTotal) * 100).toFixed(1);
    const gPct = total > 0 ? goods    / total : 0;
    const tPct = total > 0 ? trade    / total : 0;
    const sPct = total > 0 ? services / total : 0;
    return `
      <div class="industry-row">
        <div class="ir-head">
          <span class="ir-name">${f.dest_name}</span>
          <span class="ir-total">${total.toLocaleString()}</span>
        </div>
        <div class="ir-bar" style="width:${barW}%">
          <span class="seg-goods"    style="width:${(gPct*100).toFixed(1)}%">${gPct >= 0.18 ? Math.round(gPct*100)+'%' : ''}</span>
          <span class="seg-trade"    style="width:${(tPct*100).toFixed(1)}%">${tPct >= 0.18 ? Math.round(tPct*100)+'%' : ''}</span>
          <span class="seg-services" style="width:${(sPct*100).toFixed(1)}%">${sPct >= 0.18 ? Math.round(sPct*100)+'%' : ''}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ── 05 · Means of Transportation (ACS) ───────────────────────────────────────

// keys are summed together; 'other' (020E) = taxicab, motorcycle, other means
const _TRANS_ROWS = [
  { keys: ['drove', 'other'], label: 'Drove alone' },
  { keys: ['carpool'],        label: 'Carpool' },
  { keys: ['transit'],        label: 'Public transit' },
  { keys: ['bike', 'walk'],   label: 'Bike / Walk' },
  { keys: ['wfh'],            label: 'Work from home' },
];

function _renderTransport(acsEntry, appState) {
  const el = document.getElementById('transport-body');
  if (!el) return;

  if (!acsEntry) {
    el.innerHTML = `<div class="acs-na">ACS data not available for ${appState?.year < 2009 ? 'years before 2009' : 'this area'}.</div>`;
    return;
  }

  // inflow → workers commuting IN → workplace geography (where they work)
  // outflow → residents commuting OUT → residence geography (where they live)
  const isInflow = appState?.direction === 'inflow';
  const data  = isInflow ? (acsEntry.wrk?.trans ?? null) : (acsEntry.res?.trans ?? null);
  const geoLabel = isInflow ? 'Workers at this location' : 'Residents of this area';

  if (!data) {
    el.innerHTML = `<div class="acs-na">Workplace geography data not available for this area.</div>
      <div class="acs-source">ACS 5-Year Estimates · ${appState?.year ?? ''} · Census Bureau</div>`;
    return;
  }

  const total = data.total || 1;
  const rows = _TRANS_ROWS.map(({ keys, label }) => {
    const val = keys.reduce((sum, k) => sum + (data[k] ?? 0), 0);
    const pct = total > 0 ? (val / total) * 100 : 0;
    return `<div class="acs-row">
      <span class="acs-lbl">${label}</span>
      <div class="acs-bar-track"><div class="acs-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <span class="acs-pct">${pct.toFixed(0)}%</span>
      <span class="acs-count">${val.toLocaleString()}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="acs-geo-label">${geoLabel}</div>${rows}
    <div class="acs-source">ACS 5-Year Estimates · ${appState?.year ?? ''} · Census Bureau</div>`;
}

// ── 06 · Travel Time to Work (ACS) ───────────────────────────────────────────

const _TIME_ROWS = [
  { key: 'lt10',    label: '< 10 min' },
  { key: 't10_19',  label: '10–19 min' },
  { key: 't20_29',  label: '20–29 min' },
  { key: 't30_44',  label: '30–44 min' },
  { key: 't45_59',  label: '45–59 min' },
  { key: 't60plus', label: '60+ min' },
];

function _renderTravelTime(acsEntry, appState) {
  const el = document.getElementById('traveltime-body');
  if (!el) return;

  if (!acsEntry) {
    el.innerHTML = `<div class="acs-na">ACS data not available for ${appState?.year < 2009 ? 'years before 2009' : 'this area'}.</div>`;
    return;
  }

  const isInflow = appState?.direction === 'inflow';
  const data  = isInflow ? (acsEntry.wrk?.time ?? null) : (acsEntry.res?.time ?? null);
  const geoLabel = isInflow ? 'Workers at this location' : 'Residents of this area';

  if (!data) {
    el.innerHTML = `<div class="acs-na">Workplace geography data not available for this area.</div>
      <div class="acs-source">ACS 5-Year Estimates · ${appState?.year ?? ''} · Census Bureau</div>`;
    return;
  }

  const total = data.total || 1;
  const rows = _TIME_ROWS.map(({ key, label }) => {
    const val = data[key] ?? 0;
    const pct = total > 0 ? (val / total) * 100 : 0;
    return `<div class="acs-row">
      <span class="acs-lbl">${label}</span>
      <div class="acs-bar-track"><div class="acs-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <span class="acs-pct">${pct.toFixed(0)}%</span>
      <span class="acs-count">${val.toLocaleString()}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="acs-geo-label">${geoLabel}</div>${rows}
    <div class="acs-source">ACS 5-Year Estimates · ${appState?.year ?? ''} · Census Bureau</div>`;
}

// ── ACS exports ───────────────────────────────────────────────────────────────

export function exportTransportCsv() {
  if (!_lastState || !_lastAcsEntry) return;
  const area = _lastState.selectedArea;
  const year = _lastState.year;
  const header = ['Area', 'Year', 'Geography', 'Mode', 'Count', 'Pct'];
  const rows   = [header];

  for (const [geoKey, geoLabel] of [['res', 'Residence'], ['wrk', 'Workplace']]) {
    const data = _lastAcsEntry[geoKey]?.trans;
    if (!data) continue;
    const total = data.total || 1;
    for (const { keys, label } of _TRANS_ROWS) {
      const val = keys.reduce((sum, k) => sum + (data[k] ?? 0), 0);
      rows.push([area, year, geoLabel, label, val, ((val / total) * 100).toFixed(1)]);
    }
  }
  _csvDownload(rows, `transport_${area}_${year}`);
}

export function exportTravelTimeCsv() {
  if (!_lastState || !_lastAcsEntry) return;
  const area = _lastState.selectedArea;
  const year = _lastState.year;
  const header = ['Area', 'Year', 'Geography', 'TravelTime', 'Count', 'Pct'];
  const rows   = [header];

  for (const [geoKey, geoLabel] of [['res', 'Residence'], ['wrk', 'Workplace']]) {
    const data = _lastAcsEntry[geoKey]?.time;
    if (!data) continue;
    const total = data.total || 1;
    for (const { key, label } of _TIME_ROWS) {
      const val = data[key] ?? 0;
      rows.push([area, year, geoLabel, label, val, ((val / total) * 100).toFixed(1)]);
    }
  }
  _csvDownload(rows, `traveltime_${area}_${year}`);
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
