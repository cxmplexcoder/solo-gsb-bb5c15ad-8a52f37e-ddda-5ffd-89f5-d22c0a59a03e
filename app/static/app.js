/* 陶瓷窑车层架载荷追踪台 —— 原生 JS 前端
 * 模型为自下而上的 layers 数组；任何输入均触发整架 POST /api/compute 重算。
 */
'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';

let model = emptyModel();
let result = null;
let sideMode = 'xz';           // 'xz' = 沿 Y 看；'yz' = 沿 X 看
const hiddenLayers = new Set();
let selectedKey = null;        // "li-ci"
let recomputeTimer = null;
let reqSeq = 0;

/* ---------------- 工具 ---------------- */

const $ = (sel) => document.querySelector(sel);

function emptyModel() {
  return {
    deck: { width: 200, depth: 120 },
    overlap_tolerance: 0,
    layers: [],
  };
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const v = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(v);
}

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'className') node.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function htmlEl(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'className') node.className = v;
    else if (k.startsWith('data-')) node.setAttribute(k, v);
    else node[k] = v;
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function colState(col) {
  if (!col.supported) return 'float';
  if (col.overloaded) return 'overload';
  if (col.overlap) return 'overlap';
  return 'normal';
}

const STATE_COLOR = {
  normal: '#2e7d32',
  overload: '#c62828',
  overlap: '#ef6c00',
  float: '#6a1b9a',
};
const STATE_LABEL = {
  normal: '正常',
  overload: '超载',
  overlap: '落点重叠',
  float: '悬空',
};

/* ---------------- 录入编辑器 ---------------- */

function renderEditor() {
  $('#deck-width').value = model.deck.width;
  $('#deck-depth').value = model.deck.depth;
  $('#overlap-tol').value = model.overlap_tolerance;

  const wrap = $('#layers-editor');
  wrap.innerHTML = '';

  model.layers.forEach((layer, li) => {
    const card = htmlEl('div', { className: 'layer-card' });
    card.dataset.li = li;

    const head = htmlEl('div', { className: 'layer-head' });
    head.appendChild(htmlEl('span', { className: 'level-badge' }, `L${li + 1}`));
    const nameInput = htmlEl('input', {
      type: 'text', value: layer.name || '', placeholder: `第${li + 1}层名称`,
    });
    nameInput.dataset.li = li;
    nameInput.dataset.f = 'name';
    head.appendChild(nameInput);
    head.appendChild(htmlEl('span', { className: 'spacer' }));

    const upBtn = htmlEl('button', { className: 'icon-btn', type: 'button', title: '上移一层' }, '↑');
    upBtn.dataset.act = 'move-up';
    const downBtn = htmlEl('button', { className: 'icon-btn', type: 'button', title: '下移一层' }, '↓');
    downBtn.dataset.act = 'move-down';
    if (li === 0) upBtn.disabled = true;
    if (li === model.layers.length - 1) downBtn.disabled = true;
    const delBtn = htmlEl('button', { className: 'icon-btn danger', type: 'button', title: '删除该层' }, '删除');
    delBtn.dataset.act = 'del-layer';
    head.append(upBtn, downBtn, delBtn);
    card.appendChild(head);

    const body = htmlEl('div', { className: 'layer-body' });
    const g1 = htmlEl('div', { className: 'grid-3' });
    g1.appendChild(field('左下 X', li, null, 'x', layer.x));
    g1.appendChild(field('左下 Y', li, null, 'y', layer.y));
    g1.appendChild(field('棚板宽(X)', li, null, 'width', layer.width));
    body.appendChild(g1);
    const g2 = htmlEl('div', { className: 'grid-3' });
    g2.appendChild(field('棚板深(Y)', li, null, 'height', layer.height));
    g2.appendChild(field('棚板自重 kg', li, null, 'shelf_weight', layer.shelf_weight));
    g2.appendChild(field('坯件重量 kg', li, null, 'ware_weight', layer.ware_weight));
    body.appendChild(g2);

    const colsTitle = htmlEl('div', { className: 'cols-title' },
      `承托本层的立柱（${layer.columns.length} 根）— 脚坐标落在${li === 0 ? '窑车台面' : `L${li} 棚板`}上`);
    body.appendChild(colsTitle);

    layer.columns.forEach((col, ci) => {
      const row = htmlEl('div', { className: 'col-row' });
      row.appendChild(htmlEl('span', { className: 'col-idx' }, `C${ci + 1}`));
      row.appendChild(fieldNum('', li, ci, 'x', col.x));
      row.appendChild(fieldNum('', li, ci, 'y', col.y));
      row.appendChild(fieldNum('', li, ci, 'capacity', col.capacity, '容量'));
      const del = htmlEl('button', { className: 'col-del', type: 'button', title: '删除立柱' }, '×');
      del.dataset.act = 'del-col';
      del.dataset.li = li;
      del.dataset.ci = ci;
      row.appendChild(del);
      body.appendChild(row);
    });

    const addCol = htmlEl('button', { className: 'btn-add-col', type: 'button' }, '＋ 增加立柱');
    addCol.dataset.act = 'add-col';
    addCol.dataset.li = li;
    body.appendChild(addCol);

    card.appendChild(body);
    wrap.appendChild(card);
  });
}

function field(label, li, ci, f, value) {
  const lab = htmlEl('label', {}, label);
  const inp = htmlEl('input', { type: 'number', step: 'any', value });
  inp.dataset.li = li;
  inp.dataset.f = f;
  if (ci !== null) inp.dataset.ci = ci;
  lab.appendChild(inp);
  return lab;
}
function fieldNum(label, li, ci, f, value, ph) {
  const inp = htmlEl('input', { type: 'number', step: 'any', value, placeholder: ph || '' });
  inp.dataset.li = li;
  inp.dataset.ci = ci;
  inp.dataset.f = f;
  inp.title = { x: '立柱脚坐标 X', y: '立柱脚坐标 Y', capacity: '容量 kg' }[f] || '';
  return inp;
}

/* 输入事件：直接写回 model（保留输入中的原始字符串交后端校验），防抖重算 */
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;

  if (t.dataset.deck) {
    const f = t.dataset.deck;
    if (f === 'tolerance') {
      model.overlap_tolerance = rawOrNum(t.value);
    } else {
      model.deck[f] = rawOrNum(t.value);
    }
  } else if (t.dataset.li !== undefined) {
    const li = Number(t.dataset.li);
    const f = t.dataset.f;
    if (t.dataset.ci !== undefined) {
      model.layers[li].columns[Number(t.dataset.ci)][f] = rawOrNum(t.value);
    } else if (f === 'name') {
      model.layers[li].name = t.value;
    } else {
      model.layers[li][f] = rawOrNum(t.value);
    }
  } else {
    return;
  }
  scheduleRecompute(true);
});

function rawOrNum(v) {
  if (v.trim() === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/* 结构变更（增删层/立柱、移动层级）*/
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  // 增删立柱/层级、移动层级都会改变 "li-ci" 索引，统一清除选中态
  selectedKey = null;

  if (act === 'add-layer') {
    const idx = model.layers.length;
    model.layers.push({
      name: `第${idx + 1}层`, x: 0, y: 0,
      width: model.deck.width, height: model.deck.depth,
      shelf_weight: 0, ware_weight: 0, columns: [],
    });
    renderEditor();
    renderLayerFilters();
    scheduleRecompute(false);
  } else if (act === 'del-layer') {
    const li = Number(btn.closest('.layer-card').dataset.li);
    model.layers.splice(li, 1);
    if (selectedKey) selectedKey = null;
    renderEditor();
    renderLayerFilters();
    scheduleRecompute(false);
  } else if (act === 'add-col') {
    const li = Number(btn.dataset.li);
    const lower = li === 0
      ? { x: 0, y: 0, width: model.deck.width, height: model.deck.depth }
      : model.layers[li - 1];
    model.layers[li].columns.push({
      x: lower.x + Math.round(lower.width / 2),
      y: lower.y + Math.round(lower.height / 2),
      capacity: 100,
    });
    renderEditor();
    scheduleRecompute(false);
  } else if (act === 'del-col') {
    const li = Number(btn.dataset.li);
    const ci = Number(btn.dataset.ci);
    model.layers[li].columns.splice(ci, 1);
    renderEditor();
    scheduleRecompute(false);
  } else if (act === 'move-up' || act === 'move-down') {
    const li = Number(btn.closest('.layer-card').dataset.li);
    const swap = act === 'move-up' ? li - 1 : li + 1;
    if (swap < 0 || swap >= model.layers.length) return;
    [model.layers[li], model.layers[swap]] = [model.layers[swap], model.layers[li]];
    renderEditor();
    renderLayerFilters();
    scheduleRecompute(false);
  }
});

/* ---------------- 计算 ---------------- */

function scheduleRecompute(markDirty) {
  setSyncState(markDirty ? 'dirty' : 'computing');
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, markDirty ? 220 : 0);
}

async function recompute() {
  const seq = ++reqSeq;
  setSyncState('computing');
  try {
    const resp = await fetch('/api/compute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model),
    });
    const data = await resp.json();
    if (seq !== reqSeq) return;
    result = data;
    if (data.ok) {
      $('#error-banner').classList.add('hidden');
      renderAll();
      setSyncState('synced');
    } else {
      showErrors(data.errors);
      setSyncState('error');
    }
  } catch (err) {
    if (seq === reqSeq) {
      showErrors([`计算请求失败：${err.message}`]);
      setSyncState('error');
    }
  }
}

function setSyncState(state) {
  const node = $('#sync-state');
  node.classList.toggle('dirty', state === 'dirty' || state === 'error');
  node.textContent = {
    dirty: '待重算…', computing: '重算中…', synced: '已同步', error: '输入有误',
  }[state];
}

function showErrors(errors) {
  const banner = $('#error-banner');
  banner.innerHTML = '<strong>输入存在问题（已保留上一次有效结果）：</strong>' +
    '<ul>' + errors.map((m) => `<li>${escapeHtml(m)}</li>`).join('') + '</ul>';
  banner.classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------------- 渲染总入口 ---------------- */

function renderAll() {
  renderWarnings();
  renderLayerFilters();
  renderTopView();
  renderSideView();
  renderDetail();
  renderSummary();
}

function renderWarnings() {
  const banner = $('#warning-banner');
  if (!result || !result.ok || result.warnings.length === 0) {
    banner.classList.add('hidden');
    return;
  }
  const counts = { overload: 0, overlap: 0, floating: 0, unsupported: 0 };
  result.warnings.forEach((w) => { counts[w.type] += 1; });
  const parts = [];
  if (counts.overload) parts.push(`${counts.overload} 根立柱超载`);
  if (counts.overlap) parts.push(`${counts.overlap} 组落点重叠`);
  if (counts.floating) parts.push(`${counts.floating} 根立柱悬空`);
  if (counts.unsupported) parts.push(`${counts.unsupported} 层失去支撑`);

  const shown = result.warnings.slice(0, 10);
  const more = result.warnings.length - shown.length;
  banner.innerHTML = `<strong>检出 ${parts.join('，')}：</strong><ul>` +
    shown.map((w) => `<li>${escapeHtml(w.message)}</li>`).join('') +
    (more > 0 ? `<li>…另有 ${more} 条，见逐层汇总</li>` : '') + '</ul>';
  banner.classList.remove('hidden');
}

/* ---------------- 层过滤 chips ---------------- */

function renderLayerFilters() {
  const box = $('#layer-filters');
  box.innerHTML = '';
  if (!result) return;
  const allChip = htmlEl('button', {
    className: 'chip' + (hiddenLayers.size === 0 ? ' active' : ''), type: 'button',
  }, '全部');
  allChip.addEventListener('click', () => {
    hiddenLayers.clear();
    renderTopView();
    renderSideView();
    renderLayerFilters();
  });
  box.appendChild(allChip);

  result.layers.forEach((lr) => {
    const chip = htmlEl('button', {
      className: 'chip' + (hiddenLayers.has(lr.layer_index) ? '' : ' active'),
      type: 'button',
    }, `L${lr.layer_index + 1} ${lr.name}`);
    chip.addEventListener('click', () => {
      if (hiddenLayers.has(lr.layer_index)) hiddenLayers.delete(lr.layer_index);
      else hiddenLayers.add(lr.layer_index);
      renderTopView();
      renderSideView();
      renderLayerFilters();
    });
    box.appendChild(chip);
  });
}

/* ---------------- 俯视图 ---------------- */

function topViewTransform() {
  const deck = result.deck;
  let minX = 0, minY = 0, maxX = deck.width, maxY = deck.depth;
  result.layers.forEach((lr) => {
    minX = Math.min(minX, lr.x);
    minY = Math.min(minY, lr.y);
    maxX = Math.max(maxX, lr.x + lr.width);
    maxY = Math.max(maxY, lr.y + lr.height);
    lr.columns.forEach((c) => {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    });
  });
  const padCoord = Math.max(maxX - minX, maxY - minY) * 0.06 + 4;
  minX -= padCoord; minY -= padCoord; maxX += padCoord; maxY += padCoord;
  const worldW = maxX - minX, worldH = maxY - minY;

  const maxPxW = 780, maxPxH = 460, margin = 34;
  const unit = Math.min((maxPxW - margin * 2) / worldW, (maxPxH - margin * 2) / worldH);
  return {
    unit, margin, minX, minY, maxY,
    width: worldW * unit + margin * 2,
    height: worldH * unit + margin * 2,
    sx: (x) => margin + (x - minX) * unit,
    sy: (y) => margin + (maxY - y) * unit,
  };
}

function renderTopView() {
  const svg = $('#top-view');
  svg.innerHTML = '';
  if (!result || !result.ok) return;

  const T = topViewTransform();
  svg.setAttribute('viewBox', `0 0 ${T.width} ${T.height}`);
  svg.setAttribute('width', T.width);
  svg.setAttribute('height', T.height);

  // 台面
  svg.appendChild(el('rect', {
    className: 'deck-rect',
    x: T.sx(0), y: T.sy(result.deck.depth),
    width: result.deck.width * T.unit, height: result.deck.depth * T.unit,
    rx: 4,
  }));
  const deckLabel = el('text', {
    className: 'svg-label', x: T.sx(0) + 6, y: T.sy(result.deck.depth) + 14,
  }, '窑车台面');
  svg.appendChild(deckLabel);

  // 棚板（自下而上）
  result.layers.forEach((lr) => {
    const hidden = hiddenLayers.has(lr.layer_index);
    svg.appendChild(el('rect', {
      className: 'shelf-rect' + (hidden ? ' dim' : ''),
      x: T.sx(lr.x), y: T.sy(lr.y + lr.height),
      width: lr.width * T.unit, height: lr.height * T.unit,
      rx: 3,
      'fill-opacity': 0.12 + lr.layer_index * 0.07,
    }));
    if (!hidden) {
      svg.appendChild(el('text', {
        className: 'svg-label-layer',
        x: T.sx(lr.x) + 5,
        y: T.sy(lr.y + lr.height) + 14,
      }, `L${lr.layer_index + 1} ${lr.name}`));
    }
  });

  // 立柱
  result.layers.forEach((lr) => {
    if (hiddenLayers.has(lr.layer_index)) return;
    lr.columns.forEach((col) => {
      const key = `${lr.layer_index}-${col.column_index}`;
      const state = colState(col);
      const cx = T.sx(col.x), cy = T.sy(col.y);

      if (col.overlap) {
        svg.appendChild(el('circle', {
          className: 'overlap-ring', cx, cy, r: 11,
        }));
      }
      const dot = el('circle', {
        className: 'col-dot' + (selectedKey === key ? ' selected' : ''),
        cx, cy, r: state === 'float' ? 6 : 7,
        fill: STATE_COLOR[state],
        'fill-opacity': state === 'float' ? 0.85 : 1,
      });
      if (state === 'float') {
        dot.setAttribute('stroke-dasharray', '2 2');
      }
      bindColumnInteractions(dot, lr.layer_index, col, key);
      svg.appendChild(dot);

      if (state === 'float') {
        svg.appendChild(el('text', {
          className: 'float-mark', x: cx + 8, y: cy - 7,
        }, '悬空'));
      } else if (col.overloaded) {
        svg.appendChild(el('text', {
          className: 'float-mark', x: cx + 8, y: cy - 7, style: { fill: '#c62828' },
        }, `超 ${fmt(col.load)}/${fmt(col.capacity)}`));
      }
    });
  });

  // 坐标轴标注
  svg.appendChild(el('text', {
    className: 'svg-label', x: T.width - 70, y: T.height - 6,
  }, `X →  (${fmt(result.deck.width)} cm)`));
  svg.appendChild(el('text', {
    className: 'svg-label', x: 4, y: 14,
  }, `Y ↑  (${fmt(result.deck.depth)} cm)`));
}

/* ---------------- 侧视图 ---------------- */

function renderSideView() {
  const svg = $('#side-view');
  svg.innerHTML = '';
  if (!result || !result.ok) return;

  const n = result.layers.length;
  const axisIsX = sideMode === 'xz';
  const deckLen = axisIsX ? result.deck.width : result.deck.depth;

  let lo = 0, hi = deckLen;
  result.layers.forEach((lr) => {
    const a = axisIsX ? lr.x : lr.y;
    const len = axisIsX ? lr.width : lr.height;
    lo = Math.min(lo, a); hi = Math.max(hi, a + len);
    lr.columns.forEach((c) => {
      const v = axisIsX ? c.x : c.y;
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    });
  });
  const pad = Math.max(hi - lo, 1) * 0.05 + 2;
  lo -= pad; hi += pad;

  const marginX = 40, marginY = 26, slot = 78;
  const width = Math.min(820, Math.max(420, (hi - lo) * 2.4 + marginX * 2));
  const unit = (width - marginX * 2) / (hi - lo);
  const height = marginY * 2 + slot * n;
  const sx = (v) => marginX + (v - lo) * unit;
  const sz = (level) => height - marginY - level * slot;

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  // 台面
  svg.appendChild(el('line', {
    className: 'deck-line', x1: sx(0), x2: sx(deckLen), y1: sz(0), y2: sz(0),
  }));
  svg.appendChild(el('text', { className: 'svg-label', x: sx(0), y: sz(0) + 18 }, '窑车台面'));

  // 棚板线
  result.layers.forEach((lr, i) => {
    const a = axisIsX ? lr.x : lr.y;
    const len = axisIsX ? lr.width : lr.height;
    const hidden = hiddenLayers.has(i);
    svg.appendChild(el('line', {
      className: 'shelf-line' + (hidden ? ' dim' : ''),
      x1: sx(a), x2: sx(a + len), y1: sz(i + 1), y2: sz(i + 1),
    }));
    const t = el('text', {
      className: 'svg-label-layer', x: sx(a), y: sz(i + 1) - 8,
      'fill-opacity': hidden ? 0.3 : 1,
    }, `L${i + 1} ${lr.name}（毛重 ${fmt(lr.gross)} kg）`);
    svg.appendChild(t);
  });

  // 立柱（按层取重叠分组，重叠时轻微横移）
  result.layers.forEach((lr) => {
    if (hiddenLayers.has(lr.layer_index)) return;
    const groups = overlapGroupsFor(lr, axisIsX);
    lr.columns.forEach((col) => {
      const key = `${lr.layer_index}-${col.column_index}`;
      const v = axisIsX ? col.x : col.y;
      const group = groups.find((g) => g.has(col.column_index));
      let dx = 0;
      if (group && group.order.length > 1) {
        const k = group.order.indexOf(col.column_index);
        dx = (k - (group.order.length - 1) / 2) * 4;
      }
      const state = colState(col);
      const x = sx(v) + dx;
      const post = el('line', {
        className: 'col-post' + (selectedKey === key ? ' selected' : ''),
        x1: x, x2: x, y1: sz(lr.layer_index), y2: sz(lr.layer_index + 1),
        stroke: STATE_COLOR[state],
        'stroke-dasharray': state === 'float' ? '5 4' : undefined,
        'stroke-opacity': state === 'float' ? 0.85 : 1,
      });
      bindColumnInteractions(post, lr.layer_index, col, key);
      svg.appendChild(post);

      // 顶端（柱头顶在棚板上）标记
      svg.appendChild(el('circle', {
        cx: x, cy: sz(lr.layer_index + 1), r: 4, fill: STATE_COLOR[state],
        'pointer-events': 'none',
      }));
    });
  });

  svg.appendChild(el('text', {
    className: 'svg-label', x: width - 130, y: height - 6,
  }, axisIsX ? 'X 坐标 →' : 'Y 坐标 →'));
  svg.appendChild(el('text', {
    className: 'svg-label', x: 6, y: 14,
  }, 'Z ↑（层高仅示意）'));
}

/** 侧视图重叠：同层、沿观察轴投影坐标相同（距离 <= 容差）的柱为一组。 */
function overlapGroupsFor(lr, axisIsX) {
  const tol = result.overlap_tolerance || 0;
  const cols = lr.columns;
  const used = new Set();
  const groups = [];
  cols.forEach((c, i) => {
    if (used.has(i)) return;
    const order = [i];
    used.add(i);
    for (let k = i + 1; k < cols.length; k++) {
      if (used.has(k)) continue;
      const vi = axisIsX ? cols[i].x : cols[i].y;
      const vk = axisIsX ? cols[k].x : cols[k].y;
      if (Math.abs(vi - vk) <= tol + 1e-9) { order.push(k); used.add(k); }
    }
    if (order.length > 1) groups.push(order);
  });
  return groups.map((order) => ({
    order,
    has: (idx) => order.includes(idx),
  }));
}

/* ---------------- 悬停提示 / 选中 ---------------- */

let tooltip = null;
function ensureTooltip() {
  if (!tooltip) {
    tooltip = htmlEl('div', { className: 'tooltip' });
    tooltip.style.display = 'none';
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function bindColumnInteractions(node, li, col, key) {
  node.addEventListener('mouseenter', (e) => {
    const tip = ensureTooltip();
    const state = colState(col);
    tip.textContent =
      `${col.id}（${result.layers[li].name}）\n` +
      `坐标：(${fmt(col.x)}, ${fmt(col.y)})\n` +
      `落点：${col.landing_detail}\n` +
      `状态：${STATE_LABEL[state]}\n` +
      `反力：${fmt(col.load)} kg / 容量 ${fmt(col.capacity)} kg\n` +
      `利用率：${col.capacity > 0 ? fmt((col.load / col.capacity) * 100, 1) + ' %' : '-'}`;
    tip.style.display = 'block';
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  node.addEventListener('mousemove', (e) => {
    const tip = ensureTooltip();
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  node.addEventListener('mouseleave', () => {
    ensureTooltip().style.display = 'none';
  });
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedKey = selectedKey === key ? null : key;
    renderTopView();
    renderSideView();
    renderDetail();
  });
}

function renderDetail() {
  const box = $('#column-detail');
  box.innerHTML = '';
  if (!result || !result.ok) {
    box.appendChild(htmlEl('p', { className: 'placeholder' }, '等待有效计算结果…'));
    return;
  }
  if (!selectedKey) {
    box.appendChild(htmlEl('p', { className: 'placeholder' },
      '点击俯视图或侧视图中的立柱，此处展示该立柱分摊到的全部载荷来源。'));
    return;
  }
  const [li, ci] = selectedKey.split('-').map(Number);
  const lr = result.layers[li];
  const col = lr && lr.columns[ci];
  if (!col) {
    selectedKey = null;
    box.appendChild(htmlEl('p', { className: 'placeholder' }, '该立柱已被删除。'));
    return;
  }

  const state = colState(col);
  const head = htmlEl('div', { className: 'detail-head' });
  head.appendChild(htmlEl('span', { className: 'col-tag' }, col.id));
  const badges = htmlEl('span', { className: 'badges' });
  if (!col.supported) badges.appendChild(htmlEl('span', { className: 'badge float' }, '悬空'));
  if (col.overloaded) badges.appendChild(htmlEl('span', { className: 'badge overload' }, '超载'));
  if (col.overlap) badges.appendChild(htmlEl('span', { className: 'badge overlap' }, '落点重叠'));
  if (state === 'normal') badges.appendChild(htmlEl('span', { className: 'badge ok' }, '正常'));
  head.appendChild(badges);
  box.appendChild(head);

  const meta = htmlEl('div', { className: 'detail-meta' });
  const util = col.capacity > 0 ? (col.load / col.capacity) * 100 : 0;
  meta.innerHTML =
    `坐标 <b>(${fmt(col.x)}, ${fmt(col.y)})</b> · ${escapeHtml(col.landing_detail)}<br>` +
    `反力合计 <b class="${col.overloaded ? 'num-over' : ''}">${fmt(col.load)} kg</b>` +
    ` ｜ 容量 ${fmt(col.capacity)} kg ｜ 利用率 ${fmt(util, 1)} %` +
    (col.supported ? '' : '<br><b>悬空柱不参与分摊</b>，本层毛重由其余有效立柱承担。');
  box.appendChild(meta);

  if (col.sources.length === 0) {
    box.appendChild(htmlEl('p', { className: 'placeholder' },
      col.supported ? '该柱无分摊载荷。' : '该柱悬空，不承担载荷。'));
    return;
  }

  const table = htmlEl('table', { className: 'source-table' });
  table.innerHTML =
    '<thead><tr><th>载荷来源</th><th>来源毛重 kg</th><th>分摊到本柱 kg</th></tr></thead>';
  const tbody = htmlEl('tbody');
  col.sources.forEach((s) => {
    const tr = htmlEl('tr');
    const td1 = htmlEl('td');
    const tagCls = s.kind === 'shelf' ? 'kind-shelf' : s.kind === 'ware' ? 'kind-ware' : 'kind-column';
    const tagText = s.kind === 'shelf' ? '棚板' : s.kind === 'ware' ? '坯件' : '上层柱';
    td1.appendChild(htmlEl('span', { className: `kind-tag ${tagCls}` }, tagText));
    td1.appendChild(document.createTextNode(s.label));
    const td2 = htmlEl('td', {}, fmt(s.gross));
    const td3 = htmlEl('td', {}, fmt(s.share));
    tr.append(td1, td2, td3);
    tbody.appendChild(tr);
  });
  const total = htmlEl('tr', { className: 'total' });
  total.innerHTML = `<td>反力合计</td><td>${fmt(lr.gross)}</td><td>${fmt(col.load)}</td>`;
  tbody.appendChild(total);
  table.appendChild(tbody);
  box.appendChild(table);
}

/* ---------------- 汇总表 ---------------- */

function renderSummary() {
  const tbody = $('#summary-table tbody');
  tbody.innerHTML = '';
  if (!result || !result.ok) return;

  result.layers.forEach((lr) => {
    const tr = htmlEl('tr');
    if (lr.status === 'unsupported' || lr.status === 'overloaded') tr.className = 'layer-err';
    else if (lr.status !== 'ok') tr.className = 'layer-warn';

    const tds = [
      htmlEl('td', {}, `L${lr.layer_index + 1} ${lr.name}`),
      htmlEl('td', {}, fmt(lr.shelf_weight)),
      htmlEl('td', {}, fmt(lr.ware_weight)),
      htmlEl('td', {}, fmt(lr.incoming)),
      htmlEl('td', {}, fmt(lr.gross)),
      htmlEl('td', {}, `${lr.supported_count} / ${lr.column_count}`),
      htmlEl('td', {}, lr.supported_count ? fmt(lr.share) : '—'),
    ];
    const stMap = {
      ok: ['ok', '正常'],
      floating: ['floating', '有悬空柱'],
      overloaded: ['overloaded', '存在超载'],
      unsupported: ['unsupported', '失去支撑'],
    };
    const [cls, label] = stMap[lr.status];
    const stTd = htmlEl('td');
    stTd.appendChild(htmlEl('span', { className: `status-pill ${cls}` }, label));
    tds.push(stTd);

    tds.forEach((td, idx) => {
      if (idx === 6 && lr.status === 'overloaded') td.classList.add('num-over');
    });
    tr.append(...tds);

    tr.addEventListener('click', () => {
      if (hiddenLayers.has(lr.layer_index)) hiddenLayers.delete(lr.layer_index);
      renderTopView();
      renderSideView();
      renderLayerFilters();
      document.getElementById('top-view').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    tr.style.cursor = 'pointer';
    tbody.appendChild(tr);
  });
}

/* ---------------- 视图切换 / 工具按钮 ---------------- */

document.querySelectorAll('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    sideMode = btn.dataset.side;
    if (result) renderSideView();
  });
});

$('#btn-sample').addEventListener('click', loadSample);

async function loadSample() {
  try {
    const resp = await fetch('/api/sample');
    const data = await resp.json();
    if (!data.layers) throw new Error('示例数据格式不正确');
    model = data;
    selectedKey = null;
    hiddenLayers.clear();
    renderEditor();
    await recompute();
  } catch (err) {
    showErrors([`载入示例数据失败：${err.message}`]);
  }
}

$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = htmlEl('a', { href: url, download: 'kiln-cart-model.json' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

/* ---------------- 启动 ---------------- */

renderEditor();
loadSample();
