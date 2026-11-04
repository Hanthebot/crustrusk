'use strict';

const STORAGE_KEY = 'crustrusk-config-v2';
const MAX_MATRIX_ROWS = CONFIG.board.matrixRows;
const ROW_COLORS = ['#3fb950', '#d29922', '#f0883e', '#f85149', '#a371f7', '#58a6ff', '#39c5cf'];
const STATE_FILL = {
  used: '#3fb950',
  reserved: '#6e7681',
  free: '#30363d',
  conflict: '#f85149',
  power: '#58a6ff',
};
const KEYCODES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'.split('').map((c) => 'KC_' + c);

let state = defaultState();
let filterText = '';
let toastTimer = null;
let suppressClick = false;

function defaultState() {
  return { columns: {}, peripheral: null, mirror: false, preset: null };
}

function $(selector, root = document) {
  return root.querySelector(selector);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function moduleById(id) {
  return MODULES.find((m) => m.id === id) || null;
}

function moduleKeys(m) {
  return m && m.keys ? m.keys.length : 0;
}

function moduleRows(m) {
  if (!m || !m.keys || !m.keys.length) return 0;
  return Math.max(...m.keys.map((k) => k.row)) + 1;
}

function moduleBounds(m) {
  const keys = m.keys || [];
  const xs = keys.map((k) => k.x);
  const ys = keys.map((k) => k.y);
  return {
    minX: Math.min(...xs, 0),
    maxX: Math.max(...xs, 0),
    minY: Math.min(...ys, 0),
    maxY: Math.max(...ys, 0),
  };
}

/* ------------------------------------------------------------------------- */
/* State                                                                      */
/* ------------------------------------------------------------------------- */

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    /* localStorage can be unavailable on file:// or in private mode */
  }
}

function sanitizeState(raw) {
  const next = defaultState();
  if (!raw || typeof raw !== 'object') return next;
  next.mirror = !!raw.mirror;
  next.preset = typeof raw.preset === 'string' ? raw.preset : null;

  const columns = raw.columns && typeof raw.columns === 'object' ? raw.columns : {};
  for (const c of CONFIG.board.columns) {
    const placed = columns[c.id];
    if (!placed || typeof placed !== 'object') continue;
    const v = moduleById(placed.v);
    if (!v || v.type === 'peripheral') continue;
    const conn = c.connectorOptions.includes(placed.conn) ? placed.conn : v.connector;
    if (!c.connectorOptions.includes(conn)) continue;
    next.columns[c.id] = { v: v.id, conn };
  }

  const per = raw.peripheral;
  if (per && typeof per === 'object') {
    const v = moduleById(per.v);
    if (v && v.type === 'peripheral') {
      const conn = CONFIG.board.peripheral.connectorOptions.includes(per.conn)
        ? per.conn
        : v.connector || CONFIG.board.peripheral.defaultConnector;
      next.peripheral = { v: v.id, conn };
    }
  }

  if (next.preset && !PRESETS.some((p) => p.id === next.preset)) next.preset = null;
  return next;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state = sanitizeState(raw ? JSON.parse(raw) : null);
  } catch (e) {
    state = defaultState();
  }
}

/* ------------------------------------------------------------------------- */
/* Placement / pin checks                                                     */
/* ------------------------------------------------------------------------- */

function computePlacement() {
  const pinUse = {};
  const initPin = (pin) => {
    pinUse[pin.name] = {
      state: pin.kind === 'power' ? 'power' : 'free',
      role: '',
      note: '',
    };
  };
  CONFIG.controllerPins.left.forEach(initPin);
  CONFIG.controllerPins.right.forEach(initPin);
  CONFIG.controllerPins.bottom.forEach(initPin);

  const setPin = (name, pinState, role, note) => {
    if (!pinUse[name]) return;
    pinUse[name].state = pinState;
    pinUse[name].role = role;
    pinUse[name].note = note;
  };

  setPin(CONFIG.board.split.serialPin, 'reserved', 'SERIAL', 'TRRS split link');
  setPin(CONFIG.board.split.sidePin, 'reserved', 'SIDE', 'Side detect (JP1/JP2)');

  const conflicts = [];
  const warnings = [];
  const usedCols = [];
  let maxRowsUsed = 0;
  let maxColIdx = -1;

  for (const c of CONFIG.board.columns) {
    const placed = state.columns[c.id];
    if (!placed) continue;
    const v = moduleById(placed.v);
    if (!v) continue;
    const conn = CONFIG.connectors[placed.conn] || CONFIG.connectors[c.defaultConnector];
    const rows = moduleRows(v);
    const idx = parseInt(c.id.replace('col', ''), 10);
    maxColIdx = Math.max(maxColIdx, idx);
    maxRowsUsed = Math.max(maxRowsUsed, rows);

    const used = { c, v, conn, placed, rows, errors: [], warnings: [] };
    usedCols.push(used);

    if (rows > conn.rows) {
      const msg = `${c.label}: ${v.name} uses ${rows} matrix rows, but ${conn.label} carries ${conn.rows}.`;
      used.errors.push(msg);
      conflicts.push({ level: 'error', msg });
    }
    if (rows > MAX_MATRIX_ROWS) {
      const msg = `${c.label}: ${v.name} needs row ${rows - 1}, but the main board routes only ${MAX_MATRIX_ROWS} rows.`;
      used.errors.push(msg);
      conflicts.push({ level: 'error', msg });
    }
    if (v.connector !== placed.conn) {
      const msg = `${c.label}: ${v.name} has a ${CONFIG.connectors[v.connector].short} connector; the slot is set to ${conn.short}.`;
      used.warnings.push(msg);
      warnings.push({ level: 'warn', msg });
    }
    if (v.connector === 'mc8' && !c.connectorOptions.includes('mc8')) {
      const msg = `${c.label}: ${v.name} needs MCEX0 (8-pin), which is only available on COL0.`;
      used.errors.push(msg);
      conflicts.push({ level: 'error', msg });
    }

    setPin(c.pin, 'used', c.label, `${v.name} · ${conn.short}`);
  }

  for (let r = 0; r < maxRowsUsed; r++) {
    const row = CONFIG.board.rows[r];
    if (!row) break;
    setPin(row.pin, 'used', row.id, `matrix row ${r} in use`);
  }

  let peripheral = null;
  if (state.peripheral) {
    const v = moduleById(state.peripheral.v);
    if (v && v.type === 'peripheral') {
      const conn = CONFIG.connectors[state.peripheral.conn] || CONFIG.connectors[v.connector];
      peripheral = { v, conn, placed: state.peripheral };
      for (const busName of v.bus || []) {
        const bus = CONFIG.board.peripheral.bus.find((b) => b.name === busName);
        if (bus) setPin(bus.pin, 'used', bus.name, `${v.name} peripheral`);
      }
      if (conn.id === 'mpex8') {
        for (const extra of CONFIG.board.peripheral.extra) {
          setPin(extra.pin, 'used', extra.name, `MPEX8 extra (${extra.row})`);
        }
        if (maxRowsUsed > 5) {
          const msg = `MPEX8 exposes matrix rows 5/6 on the peripheral connector, but this build uses ${maxRowsUsed} rows. Use the 6-pin MP connector or a module with 5 rows or fewer.`;
          conflicts.push({ level: 'error', msg });
          for (const extra of CONFIG.board.peripheral.extra) {
            if (pinUse[extra.pin]) pinUse[extra.pin].state = 'conflict';
          }
        }
      }
      if (v.connector !== conn.id) {
        warnings.push({
          level: 'warn',
          msg: `${v.name} has a ${CONFIG.connectors[v.connector].short} connector; the peripheral slot is set to ${conn.short}.`,
        });
      }
    }
  }

  const periphNeedsSCK = peripheral && (peripheral.v.bus || []).includes('SCK');
  if (state.columns.col7 && periphNeedsSCK) {
    conflicts.push({
      level: 'error',
      msg: `COL7 shares the SCK pin (GP2), and ${peripheral.v.name} needs SCK. Drop COL7 or use a peripheral that does not need SCK.`,
    });
    if (pinUse[CONFIG.board.columns[7].pin]) {
      pinUse[CONFIG.board.columns[7].pin].state = 'conflict';
    }
  }

  return { pinUse, conflicts, warnings, maxRowsUsed, maxColIdx, peripheral, usedCols };
}

/* ------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* ------------------------------------------------------------------------- */

function renderKeys(container, m, opts = {}) {
  const unit = opts.unit || 22;
  const keySize = opts.keySize || Math.max(8, unit - 2);
  const pad = opts.pad !== undefined ? opts.pad : Math.round(unit / 2);
  container.innerHTML = '';
  container.classList.add('keymap');

  if (m.type === 'peripheral') {
    container.classList.add('periphmap');
    const knob = el('div', 'knob');
    knob.appendChild(el('span', '', 'EC11'));
    container.appendChild(knob);
    container.style.width = opts.mini ? '70px' : '88px';
    container.style.height = opts.mini ? '50px' : '64px';
    return;
  }

  const b = moduleBounds(m);
  const width = (b.maxX - b.minX + 1) * unit + pad * 2;
  const height = (b.maxY - b.minY + 1) * unit + pad * 2;
  container.style.width = width + 'px';
  container.style.height = height + 'px';

  for (const key of m.keys) {
    const x = opts.mirror ? b.maxX - key.x : key.x;
    const kc = el('div', 'kc');
    kc.style.width = kc.style.height = keySize + 'px';
    kc.style.left = ((x - b.minX) * unit + pad + unit / 2) + 'px';
    kc.style.top = ((key.y - b.minY) * unit + pad + unit / 2) + 'px';
    kc.style.setProperty('--row-color', ROW_COLORS[key.row % ROW_COLORS.length]);
    kc.dataset.row = key.row;
    if (opts.labels) kc.textContent = key.row;
    kc.title = `${m.name} · matrix row ${key.row}`;
    container.appendChild(kc);
  }
}

function renderModuleCard(m) {
  const card = el('div', 'module-card');
  card.draggable = true;
  card.dataset.vid = m.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${m.name}. Click to auto-place or drag to a connector.`);

  const top = el('div', 'module-top');
  top.appendChild(el('div', 'module-name', m.name));
  top.appendChild(el('span', 'badge', m.type === 'peripheral' ? 'peripheral' : `${moduleKeys(m)} keys`));

  const meta = el(
    'div',
    'module-meta',
    m.type === 'peripheral'
      ? `${CONFIG.connectors[m.connector].short} · ${(m.bus || []).join(' + ')}`
      : `${CONFIG.connectors[m.connector].short} · ${moduleRows(m)} matrix rows`
  );

  const preview = el('div', 'module-preview');
  renderKeys(preview, m, { unit: 11, keySize: 9, pad: 4, mini: true });

  const note = el('div', 'module-note', m.note || '');

  card.append(top, meta, preview, note);
  card.title = 'Click to auto-place, or drag onto a connector';

  card.addEventListener('dragstart', (e) => {
    card.classList.add('dragging');
    e.dataTransfer.setData('text/plain', m.id);
    e.dataTransfer.setData('application/x-crustrusk-module', m.id);
    e.dataTransfer.effectAllowed = 'copy';
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    autoPlace(m);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      autoPlace(m);
    }
  });
  return card;
}

function renderPalette() {
  const root = $('#paletteSections');
  root.innerHTML = '';
  const sections = [
    { type: 'column', title: 'Columns', note: 'Vertical key columns' },
    { type: 'thumb', title: 'Thumbs', note: 'Thumb clusters' },
    { type: 'peripheral', title: 'Peripherals', note: 'Knobs and add-ons' },
  ];
  const needle = filterText.toLowerCase();
  let shown = 0;

  for (const section of sections) {
    const modules = MODULES.filter((m) => {
      if (m.type !== section.type) return false;
      if (!needle) return true;
      return `${m.id} ${m.name} ${m.note || ''}`.toLowerCase().includes(needle);
    });
    if (!modules.length) continue;
    shown += modules.length;

    const wrap = el('section', 'palette-section');
    const head = el('div', 'section-head');
    head.appendChild(el('h3', '', section.title));
    head.appendChild(el('span', 'section-count', String(modules.length)));
    wrap.appendChild(head);
    wrap.appendChild(el('p', 'section-note', section.note));

    const grid = el('div', 'module-grid');
    modules.forEach((m) => grid.appendChild(renderModuleCard(m)));
    wrap.appendChild(grid);
    root.appendChild(wrap);
  }

  $('#paletteCount').textContent = `${shown} shown`;
  if (!shown) {
    root.innerHTML = `<p class="empty-note">No modules match “${escapeHtml(filterText)}”.</p>`;
  }
}

function renderSlotColumn(c, opts) {
  const { mirror, placement } = opts;
  const used = placement.usedCols.find((u) => u.c.id === c.id);
  const placed = state.columns[c.id];
  const v = placed ? moduleById(placed.v) : null;

  const wrap = el('div', 'slot-wrap');
  const slot = el('div', 'slot');
  slot.dataset.slot = c.id;
  slot.dataset.kind = 'column';
  if (used && used.errors.length) slot.classList.add('has-error');
  if (used && used.warnings.length) slot.classList.add('has-warning');

  const head = el('div', 'slot-head');
  head.appendChild(el('span', 'slot-ref', c.label));
  head.appendChild(el('span', 'slot-pin', c.pin));
  slot.appendChild(head);

  if (placed && v) {
    const conn = CONFIG.connectors[placed.conn] || CONFIG.connectors[c.defaultConnector];
    slot.classList.add('filled');
    slot.dataset.module = v.id;

    const body = el('div', 'slot-body');
    body.appendChild(el('div', 'slot-module-name', v.name));
    body.appendChild(
      el('div', 'slot-module-meta', `${moduleKeys(v)} keys · ${moduleRows(v)} rows · ${conn.short}`)
    );

    const keyWrap = el('div', 'slot-keymap');
    renderKeys(keyWrap, v, { unit: 22, keySize: 20, pad: 8, labels: true, mirror });
    body.appendChild(keyWrap);

    if (used && (used.errors.length || used.warnings.length)) {
      const issue = el('div', 'slot-issue', used.errors[0] || used.warnings[0]);
      issue.title = [...used.errors, ...used.warnings].join('\n');
      body.appendChild(issue);
    }

    const actions = el('div', 'slot-actions');
    if (c.connectorOptions.length > 1) {
      const select = el('div', 'connector-select');
      c.connectorOptions.forEach((opt) => {
        const connector = CONFIG.connectors[opt];
        const btn = el('button', 'connector-btn', connector.short);
        btn.type = 'button';
        btn.classList.toggle('on', placed.conn === opt);
        btn.disabled = moduleRows(v) > connector.rows;
        btn.title = `${connector.label} · up to ${connector.rows} rows`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.columns[c.id].conn = opt;
          state.preset = null;
          persist();
          renderAll();
        });
        select.appendChild(btn);
      });
      actions.appendChild(select);
    } else {
      actions.appendChild(el('div', 'connector-static', conn.short));
    }

    const remove = el('button', 'remove', '×');
    remove.type = 'button';
    remove.title = `Remove ${v.name} from ${c.label}`;
    remove.setAttribute('aria-label', `Remove ${v.name} from ${c.label}`);
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      delete state.columns[c.id];
      state.preset = null;
      persist();
      renderAll();
    });
    actions.appendChild(remove);
    body.appendChild(actions);
    slot.appendChild(body);
  } else {
    slot.classList.add('empty');
    const empty = el('div', 'slot-empty');
    empty.appendChild(el('span', 'plus', '+'));
    empty.appendChild(el('span', 'slot-empty-label', 'Drop module'));
    empty.appendChild(
      el(
        'span',
        'slot-empty-options',
        c.connectorOptions.map((id) => CONFIG.connectors[id].short).join(' / ')
      )
    );
    slot.appendChild(empty);
  }

  slot.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    slot.classList.add('drag-over');
  });
  slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
  slot.addEventListener('drop', (e) => {
    e.preventDefault();
    slot.classList.remove('drag-over');
    const vid = e.dataTransfer.getData('application/x-crustrusk-module') || e.dataTransfer.getData('text/plain');
    if (vid) placeColumn(c.id, vid);
  });

  wrap.appendChild(slot);
  return wrap;
}

function renderHalf(label, columns, mirror, placement) {
  const block = el('div', 'half-block' + (mirror ? ' mirrored' : ''));
  const head = el('div', 'half-head');
  head.appendChild(el('span', 'half-label', label));
  head.appendChild(el('span', 'half-note', mirror ? 'same modules, opposite hand' : 'configure this side'));
  const row = el('div', 'slot-row');
  columns.forEach((c) => row.appendChild(renderSlotColumn(c, { mirror, placement })));
  block.append(head, row);
  return block;
}

function renderPeripheralZone(placement) {
  const block = el('div', 'peripheral-block');
  const head = el('div', 'peripheral-head');
  const title = el('div', '');
  title.appendChild(el('span', 'half-label', 'Peripheral'));
  title.appendChild(
    el('span', 'half-note', 'MP1 / MPEX1 · SDA GP0 · SCL GP1 · SCK GP2 · MOSI GP3')
  );
  head.appendChild(title);
  block.appendChild(head);

  const slot = el('div', 'slot peripheral-slot');
  slot.dataset.slot = 'peripheral';
  slot.dataset.kind = 'peripheral';
  const placed = state.peripheral;
  const v = placed ? moduleById(placed.v) : null;

  if (placed && v) {
    const conn = CONFIG.connectors[placed.conn] || CONFIG.connectors[v.connector];
    slot.classList.add('filled');
    slot.dataset.module = v.id;
    const body = el('div', 'peripheral-body');

    const keyWrap = el('div', 'peripheral-keymap');
    renderKeys(keyWrap, v, { unit: 22, keySize: 20, pad: 8 });
    body.appendChild(keyWrap);

    const info = el('div', 'peripheral-info');
    info.appendChild(el('div', 'slot-module-name', v.name));
    info.appendChild(el('div', 'slot-module-meta', `${conn.short} · ${(v.bus || []).join(' + ')}`));
    const buses = el('div', 'bus-row');
    (v.bus || []).forEach((name) => buses.appendChild(el('span', 'bus-chip', name)));
    info.appendChild(buses);

    if (placement.peripheral && placement.peripheral.conn.id === 'mpex8' && placement.maxRowsUsed > 5) {
      info.appendChild(el('div', 'slot-issue', 'MPEX8 rows 5/6 conflict with this build.'));
    }

    const actions = el('div', 'peripheral-actions');
    const select = el('div', 'connector-select');
    CONFIG.board.peripheral.connectorOptions.forEach((opt) => {
      const connector = CONFIG.connectors[opt];
      const btn = el('button', 'connector-btn', connector.short);
      btn.type = 'button';
      btn.classList.toggle('on', placed.conn === opt);
      btn.title = `${connector.label}`;
      btn.addEventListener('click', () => {
        state.peripheral.conn = opt;
        state.preset = null;
        persist();
        renderAll();
      });
      select.appendChild(btn);
    });
    actions.appendChild(select);

    const remove = el('button', 'remove', '×');
    remove.type = 'button';
    remove.title = `Remove ${v.name}`;
    remove.setAttribute('aria-label', `Remove ${v.name}`);
    remove.addEventListener('click', () => {
      state.peripheral = null;
      state.preset = null;
      persist();
      renderAll();
    });
    actions.appendChild(remove);
    info.appendChild(actions);
    body.appendChild(info);
    slot.appendChild(body);
  } else {
    slot.classList.add('empty');
    const empty = el('div', 'peripheral-empty');
    empty.appendChild(el('span', 'plus', '+'));
    empty.appendChild(el('span', 'slot-empty-label', 'Drop a peripheral'));
    empty.appendChild(el('span', 'slot-empty-options', 'MP6 / MPEX8 · EC11 encoder'));
    slot.appendChild(empty);
  }

  slot.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    slot.classList.add('drag-over');
  });
  slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
  slot.addEventListener('drop', (e) => {
    e.preventDefault();
    slot.classList.remove('drag-over');
    const vid = e.dataTransfer.getData('application/x-crustrusk-module') || e.dataTransfer.getData('text/plain');
    const m = moduleById(vid);
    if (!m) return;
    if (m.type !== 'peripheral') {
      flashToast('The peripheral connector takes peripherals (for example the EC11 knob).', 'error');
      return;
    }
    placePeripheral(vid);
  });

  block.appendChild(slot);
  return block;
}

function renderBoard(placement) {
  const canvas = $('#boardCanvas');
  canvas.innerHTML = '';

  const halves = el('div', 'halves');
  halves.appendChild(renderHalf('Left half', CONFIG.board.columns, false, placement));
  if (state.mirror) {
    halves.appendChild(
      renderHalf('Right half', [...CONFIG.board.columns].reverse(), true, placement)
    );
  }
  canvas.appendChild(halves);
  canvas.appendChild(renderPeripheralZone(placement));

  const nKeys = placement.usedCols.reduce((sum, u) => sum + moduleKeys(u.v), 0);
  const chips = [
    `${placement.usedCols.length} / ${CONFIG.board.columns.length} connectors`,
    `${nKeys} keys/side`,
    placement.maxRowsUsed ? `${placement.maxRowsUsed} matrix rows` : 'no rows',
  ];
  if (placement.peripheral) chips.push('EC11 knob');
  $('#boardSummary').innerHTML = chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('');
}

/* ------------------------------------------------------------------------- */
/* Pin diagram                                                               */
/* ------------------------------------------------------------------------- */

function pinFill(pin) {
  return STATE_FILL[pin.state] || STATE_FILL.free;
}

function pinTextColor(pinState) {
  if (pinState === 'conflict') return '#ffb3ad';
  if (pinState === 'reserved') return '#c9d1d9';
  return '#c9d1d9';
}

function buildPinSvg(pinUse) {
  const parts = [];
  const L = CONFIG.controllerPins.left;
  const R = CONFIG.controllerPins.right;
  const B = CONFIG.controllerPins.bottom;
  const bodyX = 60;
  const bodyY = 30;
  const bodyW = 140;
  const bodyH = 240;

  parts.push('<svg id="pinSvg" viewBox="0 0 260 344" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="RP2040-Zero pin map">');
  parts.push(`<rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="12" fill="#0d1117" stroke="#30363d" stroke-width="2"/>`);
  parts.push('<text x="130" y="18" text-anchor="middle" fill="#8b98ab" font-size="9" font-family="ui-monospace, monospace" letter-spacing="1">RP2040-ZERO</text>');
  parts.push('<rect x="105" y="316" width="50" height="14" rx="4" fill="#1c2230" stroke="#30363d" stroke-width="2"/>');
  parts.push('<rect x="113" y="321" width="34" height="4" rx="2" fill="#3a465c"/>');
  parts.push('<text x="130" y="340" text-anchor="middle" fill="#8b98ab" font-size="8" font-family="ui-monospace, monospace">USB-C</text>');

  const drawPin = (pin, cx, cy, nameX, nameAnchor, roleX, roleAnchor, nameY, roleY) => {
    const pu = pinUse[pin.name] || { state: 'free', role: '', note: '' };
    const dashed = pu.state === 'reserved' ? ' stroke-dasharray="3 2"' : '';
    const cls = pu.state === 'conflict' ? 'pin conflict' : 'pin';
    parts.push(`<circle class="${cls}" cx="${cx}" cy="${cy}" r="8" fill="${pinFill(pu)}" stroke="#0d1117" stroke-width="1.5"${dashed}><title>${escapeHtml(pin.name)} — ${escapeHtml(pu.role || pu.state)}${pu.note ? ' — ' + escapeHtml(pu.note) : ''}</title></circle>`);
    parts.push(`<text x="${nameX}" y="${nameY}" text-anchor="${nameAnchor}" fill="${pinTextColor(pu.state)}" font-size="8" font-family="ui-monospace, monospace">${escapeHtml(pin.name)}</text>`);
    if (pu.role) {
      parts.push(`<text x="${roleX}" y="${roleY}" text-anchor="${roleAnchor}" fill="#8b98ab" font-size="7" font-family="ui-monospace, monospace">${escapeHtml(pu.role)}</text>`);
    }
  };

  L.forEach((pin, i) => {
    const y = 46 + i * 23;
    drawPin(pin, bodyX, y, bodyX - 12, 'end', bodyX + 12, 'start', y + 3, y + 3);
  });
  R.forEach((pin, i) => {
    const y = 46 + i * 23;
    drawPin(pin, bodyX + bodyW, y, bodyX + bodyW + 12, 'start', bodyX + bodyW - 12, 'end', y + 3, y + 3);
  });
  B.forEach((pin, i) => {
    const x = 80 + i * 22;
    drawPin(pin, x, 286, x, 'middle', x, 'middle', 304, 276);
  });

  parts.push('</svg>');
  return parts.join('');
}

function buildPinLegend() {
  return `<div id="pinLegend">
    <span class="legend-chip"><i style="background:#3fb950"></i> used</span>
    <span class="legend-chip"><i style="background:#6e7681"></i> reserved</span>
    <span class="legend-chip"><i style="background:#30363d"></i> free</span>
    <span class="legend-chip"><i style="background:#f85149"></i> conflict</span>
    <span class="legend-chip"><i style="background:#58a6ff"></i> power</span>
  </div>`;
}

function buildPinUseList(pinUse) {
  const entries = Object.entries(pinUse);
  const active = entries.filter(([, pu]) => pu.state !== 'free');
  const free = entries.filter(([, pu]) => pu.state === 'free');
  const rows = active
    .map(
      ([name, pu]) => `<div class="pin-row"><span class="pin-dot ${pu.state}"></span><span class="pinname">${escapeHtml(name)}</span><span class="pinrole">${escapeHtml(pu.role || pu.state)}</span><span class="pinnote">${escapeHtml(pu.note || '')}</span></div>`
    )
    .join('');

  const freeList = free.map(([name]) => `<span class="free-pin">${escapeHtml(name)}</span>`).join('');
  return `<div class="pin-use-list">
    <div class="pin-use-head"><span>${active.length} pins in use</span><span>${free.length} free</span></div>
    ${rows || '<div class="pin-empty">No pins assigned yet.</div>'}
    <details class="free-details">
      <summary>Free pins (${free.length})</summary>
      <div class="free-pins">${freeList}</div>
    </details>
  </div>`;
}

function renderPinMap(placement) {
  $('#panel-pins').innerHTML = buildPinSvg(placement.pinUse) + buildPinLegend() + buildPinUseList(placement.pinUse);
}

/* ------------------------------------------------------------------------- */
/* Status                                                                    */
/* ------------------------------------------------------------------------- */

function renderStatus(placement) {
  const root = $('#panel-status');
  root.innerHTML = '';
  const nKeys = placement.usedCols.reduce((sum, u) => sum + moduleKeys(u.v), 0);

  const summary = el('div', 'status-summary');
  const summaryRows = [
    ['Connectors', `${placement.usedCols.length} / ${CONFIG.board.columns.length}`],
    ['Keys per side', String(nKeys)],
    ['Matrix rows', placement.maxRowsUsed ? `0–${placement.maxRowsUsed - 1}` : 'none'],
    ['Peripheral', placement.peripheral ? placement.peripheral.v.name : 'none'],
    ['Controller', CONFIG.board.controller],
  ];
  summaryRows.forEach(([label, value]) => {
    const row = el('div', 'summary-row');
    row.appendChild(el('span', '', label));
    row.appendChild(el('strong', '', value));
    summary.appendChild(row);
  });
  root.appendChild(summary);

  const list = el('div', 'status-list');
  const checks = [];
  if (!placement.usedCols.length && !placement.peripheral) {
    checks.push({ level: 'info', msg: 'Nothing placed yet. Drag modules from the palette onto the connectors.' });
  } else {
    checks.push({
      level: 'ok',
      msg: `${placement.usedCols.length} connector${placement.usedCols.length === 1 ? '' : 's'}, ${nKeys} keys per side, ${placement.maxRowsUsed} matrix row${placement.maxRowsUsed === 1 ? '' : 's'}.`,
    });
    if (placement.peripheral) {
      checks.push({
        level: 'ok',
        msg: `Peripheral: ${placement.peripheral.v.name} on ${placement.peripheral.conn.short}.`,
      });
    }
    if (!placement.conflicts.length) {
      checks.push({ level: 'ok', msg: 'No pin conflicts detected.' });
    }
  }

  placement.warnings.forEach((w) => checks.push(w));
  placement.conflicts.forEach((c) => checks.push(c));

  if (placement.maxRowsUsed && placement.maxRowsUsed < MAX_MATRIX_ROWS) {
    checks.push({
      level: 'info',
      msg: `Matrix rows ${placement.maxRowsUsed}–${MAX_MATRIX_ROWS - 1} are free.`,
    });
  }
  if (placement.peripheral && placement.peripheral.conn.id === 'mpex8' && placement.maxRowsUsed <= 5) {
    checks.push({ level: 'info', msg: 'MPEX8 exposes ROW5/ROW6; both are free in this build.' });
  }
  if (state.columns.col7 && !placement.peripheral) {
    checks.push({ level: 'info', msg: 'COL7 shares SCK (GP2); no SCK peripheral is configured.' });
  }

  const usedIdx = placement.usedCols
    .map((u) => parseInt(u.c.id.replace('col', ''), 10))
    .sort((a, b) => a - b);
  if (usedIdx.length) {
    for (let i = usedIdx[0]; i <= usedIdx[usedIdx.length - 1]; i++) {
      if (!usedIdx.includes(i)) {
        checks.push({
          level: 'warn',
          msg: `COL${i} is empty between used connectors; firmware still reserves matrix column ${i}.`,
        });
      }
    }
  }

  checks.forEach((check) => {
    const item = el('div', 'status-item ' + check.level);
    item.appendChild(el('span', 'status-icon', check.level === 'ok' ? '✓' : check.level === 'warn' ? '!' : check.level === 'error' ? '×' : 'i'));
    item.appendChild(el('span', '', check.msg));
    list.appendChild(item);
  });
  root.appendChild(list);
}

/* ------------------------------------------------------------------------- */
/* Firmware export                                                           */
/* ------------------------------------------------------------------------- */

function generatedColumnCount(p) {
  return Math.max(p.maxColIdx + 1, 1);
}

function genConfigH(p) {
  const n = generatedColumnCount(p);
  const colPins = CONFIG.board.columns.slice(0, n).map((c) => c.pin).join(', ');
  const rowPins = CONFIG.board.rows.map((r) => r.pin).join(', ');
  return `// Crustrusk — generated config.h
// Generated by the Crustrusk configurator. MATRIX_ROWS/COLS describe ONE half.
#pragma once

#define MATRIX_ROWS ${MAX_MATRIX_ROWS}
#define MATRIX_COLS ${n}
#define MATRIX_ROW_PINS { ${rowPins} }
#define MATRIX_COL_PINS { ${colPins} }
#define DIODE_DIRECTION ${CONFIG.board.diodeDirection}

// Split: one RP2040 per half, UART (serial) over TRRS
#define SPLIT_KEYBOARD
#define SPLIT_HAND_PIN ${CONFIG.board.split.sidePin}
#define USE_SERIAL
#define SERIAL_PIN ${CONFIG.board.split.serialPin}

// Vial
#define VIAL_KEYBOARD_UID 0x53, 0x48, 0x4B, 0x33, 0x52, 0x32, 0x00, 0x00
#define VIAL_UNLOCK_COMBO_ROWS { 0, 1 }
#define VIAL_UNLOCK_COMBO_COLS { 0, 1 }
#define VIAL_KEY_OVERRIDE_ENTRIES 4
`;
}

function genInfoJson(p) {
  const n = generatedColumnCount(p);
  const data = {
    keyboard_name: 'Crustrusk',
    manufacturer: 'Crustrusk',
    url: 'https://github.com/Hanthebot/crustrusk',
    maintainer: 'Hanthebot',
    processor: 'RP2040',
    bootloader: 'rp2040',
    diode_direction: CONFIG.board.diodeDirection,
    matrix_pins: {
      rows: CONFIG.board.rows.map((r) => r.pin),
      cols: CONFIG.board.columns.slice(0, n).map((c) => c.pin),
    },
    split: {
      handedness: 'matrix_pin',
      matrix_pin: CONFIG.board.split.sidePin,
      serial: { pin: CONFIG.board.split.serialPin },
    },
    features: { via: true },
    vial: { vid: '0x0000', pid: '0x0000' },
  };
  return JSON.stringify(data, null, 2);
}

function genVialJson(p) {
  const n = generatedColumnCount(p);
  const keymap = [];
  const seen = new Set();
  CONFIG.board.columns.slice(0, n).forEach((c, ci) => {
    const placed = state.columns[c.id];
    if (!placed) return;
    const v = moduleById(placed.v);
    if (!v || v.type === 'peripheral') return;
    v.keys.forEach((key) => {
      const id = `${key.row}:${ci}`;
      if (seen.has(id)) return;
      seen.add(id);
      keymap.push([key.row, ci, 0, 0]);
    });
  });
  keymap.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const data = {
    name: 'Crustrusk',
    vendorId: '0x0000',
    productId: '0x0000',
    lighting: 'none',
    matrix: { rows: MAX_MATRIX_ROWS, cols: n },
    layouts: { labels: [], keymap },
  };
  return JSON.stringify(data, null, 2);
}

function genKeymapC(p) {
  const n = generatedColumnCount(p);
  const cells = Array.from({ length: MAX_MATRIX_ROWS }, () => Array(n).fill('KC_NO'));
  const seen = new Set();
  let keycodeIndex = 0;

  CONFIG.board.columns.slice(0, n).forEach((c, ci) => {
    const placed = state.columns[c.id];
    if (!placed) return;
    const v = moduleById(placed.v);
    if (!v || v.type === 'peripheral') return;
    v.keys.forEach((key) => {
      const id = `${key.row}:${ci}`;
      if (seen.has(id)) return;
      seen.add(id);
      cells[key.row][ci] = KEYCODES[keycodeIndex] || 'KC_NO';
      keycodeIndex += 1;
    });
  });

  const rows = cells.map((row) => '        { ' + row.join(', ') + ' }').join(',\n');
  return `// Crustrusk — generated keymap.c
// Placeholder keycodes: the first ${Math.min(keycodeIndex, KEYCODES.length)} keys get A–Z then 1–0.
// Edit this file to taste.
#include QMK_KEYBOARD_H

const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {
    [0] = {
${rows}
    }
};
`;
}

function copyText(text, button) {
  const done = () => {
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
    done();
  } catch (e) {
    flashToast('Could not copy to the clipboard.', 'error');
  }
  area.remove();
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderExport(p) {
  const root = $('#panel-export');
  root.innerHTML = '';

  if (p.maxColIdx < 0) {
    const empty = el('div', 'export-empty');
    empty.appendChild(el('h3', '', 'Nothing to export yet'));
    empty.appendChild(el('p', '', 'Place at least one column or thumb module to generate firmware files.'));
    root.appendChild(empty);
    return;
  }

  const head = el('div', 'export-head');
  const title = el('div', '');
  title.appendChild(el('h3', '', 'Firmware files'));
  title.appendChild(el('p', '', 'Generated from the current module placement.'));
  head.appendChild(title);

  const files = [
    { name: 'config.h', note: 'Matrix, split and Vial defines', gen: () => genConfigH(p) },
    { name: 'info.json', note: 'QMK keyboard metadata', gen: () => genInfoJson(p) },
    { name: 'vial.json', note: 'Vial matrix layout', gen: () => genVialJson(p) },
    { name: 'keymap.c', note: 'Placeholder keymap', gen: () => genKeymapC(p) },
  ];
  const generated = files.map((f) => ({ ...f, text: f.gen() }));

  const allBtn = el('button', 'btn small', 'Download all');
  allBtn.type = 'button';
  allBtn.addEventListener('click', () => {
    generated.forEach((file, index) => {
      setTimeout(() => downloadText(file.name, file.text), index * 180);
    });
  });
  head.appendChild(allBtn);
  root.appendChild(head);

  if (p.conflicts.length) {
    const banner = el('div', 'export-banner');
    banner.appendChild(el('strong', '', 'Resolve conflicts first'));
    banner.appendChild(el('span', '', 'The files below are generated, but the pin map has errors.'));
    root.appendChild(banner);
  }

  generated.forEach((file) => {
    const block = el('div', 'export-block');
    const blockHead = el('div', 'export-block-head');
    blockHead.appendChild(el('h4', '', file.name));
    blockHead.appendChild(el('span', 'export-note', file.note));
    block.appendChild(blockHead);

    const pre = el('pre', '', file.text);
    block.appendChild(pre);

    const actions = el('div', 'export-actions');
    const dl = el('button', 'btn small', 'Download');
    dl.type = 'button';
    dl.addEventListener('click', () => downloadText(file.name, file.text));
    const cp = el('button', 'btn small ghost', 'Copy');
    cp.type = 'button';
    cp.addEventListener('click', () => copyText(file.text, cp));
    actions.append(dl, cp);
    block.appendChild(actions);
    root.appendChild(block);
  });
}

/* ------------------------------------------------------------------------- */
/* Actions                                                                   */
/* ------------------------------------------------------------------------- */

function placeColumn(slotId, vid) {
  const v = moduleById(vid);
  if (!v) {
    flashToast('Unknown module.', 'error');
    return;
  }
  if (v.type === 'peripheral') {
    placePeripheral(vid);
    return;
  }
  const c = CONFIG.board.columns.find((x) => x.id === slotId);
  if (!c) return;

  if (!c.connectorOptions.includes(v.connector)) {
    flashToast(
      `${v.name} needs ${CONFIG.connectors[v.connector].label}; ${c.label} only has ${c.connectorOptions
        .map((id) => CONFIG.connectors[id].short)
        .join(' / ')}.`,
      'error'
    );
    return;
  }

  const rows = moduleRows(v);
  if (rows > CONFIG.connectors[v.connector].rows) {
    flashToast(`${v.name} needs ${rows} rows, which does not fit ${CONFIG.connectors[v.connector].label}.`, 'error');
    return;
  }

  state.columns[slotId] = { v: vid, conn: v.connector };
  state.preset = null;
  persist();
  renderAll();
  flashToast(`${v.name} placed on ${c.label}.`, 'ok');
}

function placePeripheral(vid) {
  const v = moduleById(vid);
  if (!v || v.type !== 'peripheral') {
    flashToast('The peripheral slot takes peripherals only.', 'error');
    return;
  }
  state.peripheral = {
    v: vid,
    conn: v.connector || CONFIG.board.peripheral.defaultConnector,
  };
  state.preset = null;
  persist();
  renderAll();
  flashToast(`${v.name} placed on the peripheral connector.`, 'ok');
}

function autoPlace(v) {
  if (v.type === 'peripheral') {
    placePeripheral(v.id);
    return;
  }
  const empty = CONFIG.board.columns.filter(
    (c) => !state.columns[c.id] && c.connectorOptions.includes(v.connector)
  );
  if (!empty.length) {
    flashToast('No empty connector supports this module.', 'error');
    return;
  }
  const target = v.type === 'thumb' ? empty[empty.length - 1] : empty[0];
  placeColumn(target.id, v.id);
}

function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  const next = defaultState();
  next.mirror = state.mirror;
  next.preset = id;

  Object.entries(preset.columns).forEach(([colId, vid]) => {
    const c = CONFIG.board.columns.find((x) => x.id === colId);
    const v = moduleById(vid);
    if (c && v && v.type !== 'peripheral' && c.connectorOptions.includes(v.connector)) {
      next.columns[colId] = { v: vid, conn: v.connector };
    }
  });

  if (preset.peripheral) {
    const v = moduleById(preset.peripheral);
    if (v && v.type === 'peripheral') {
      next.peripheral = {
        v: v.id,
        conn: v.connector || CONFIG.board.peripheral.defaultConnector,
      };
    }
  }

  state = next;
  persist();
  renderAll();
  flashToast(`Loaded preset: ${preset.name}`, 'ok');
}

function flashToast(message, type = 'error') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = '';
  }, 2800);
}

/* ------------------------------------------------------------------------- */
/* Wiring                                                                    */
/* ------------------------------------------------------------------------- */

function renderAll() {
  const placement = computePlacement();
  renderPalette();
  renderBoard(placement);
  renderPinMap(placement);
  renderStatus(placement);
  renderExport(placement);
  $('#mirrorToggle').checked = state.mirror;
  const presetSelect = $('#presetSelect');
  if (presetSelect) presetSelect.value = state.preset || 'custom';
}

function initPresets() {
  const select = $('#presetSelect');
  select.appendChild(new Option('Custom build', 'custom'));
  PRESETS.forEach((preset) => select.appendChild(new Option(preset.name, preset.id)));
  select.addEventListener('change', () => {
    if (select.value === 'custom') {
      state.preset = null;
      persist();
      return;
    }
    applyPreset(select.value);
  });
}

function initTabs() {
  document.querySelectorAll('#tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#tabs .tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      $('#panel-' + tab.dataset.tab).classList.add('active');
    });
  });
}

function initControls() {
  $('#mirrorToggle').addEventListener('change', (e) => {
    state.mirror = e.target.checked;
    persist();
    renderAll();
  });

  $('#resetBtn').addEventListener('click', () => {
    const hasContent = Object.keys(state.columns).length || state.peripheral;
    if (hasContent && !window.confirm('Clear every module and start over?')) return;
    state = defaultState();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* ignore */
    }
    renderAll();
    flashToast('Cleared the build.', 'ok');
  });

  $('#search').addEventListener('input', (e) => {
    filterText = e.target.value.trim();
    renderPalette();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  initTabs();
  initPresets();
  initControls();
  renderAll();
});
