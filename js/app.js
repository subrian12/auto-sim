/* Auto Simulator — app controller */
(function () {
  'use strict';
  const AC = window.AC;
  const U = AC.util;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = U.escapeHtml;

  const STORE_KEY = 'autosim.v1';
  const DEFAULT_FP = { length: 0.9, width: 0.9, offsetX: 0 };
  const SKIP_DIRS = new Set(['build', 'bin', '.gradle', 'node_modules', '.git', '.vscode', '.idea', 'out', 'vendordeps', '.wpilib']);

  /** Each robot runs a list of steps in order: {kind:'traj'|'path', name} or {kind:'wait', time, label}. */
  function makeRobot(i) {
    return { index: i, color: AC.ROBOT_COLORS[i], team: '', lib: new AC.Library(), steps: [], delay: 0, footprint: { ...DEFAULT_FP }, footprintFromFile: '', mirror: false, options: [], base: null, routine: null };
  }

  const state = { fieldId: '2026', alliance: 'blue', robots: [0, 1, 2].map(makeRobot), time: 0, playing: false, events: [], T: 20 };
  const field = () => AC.fields.get(state.fieldId);
  const loaded = () => state.robots.filter((R) => R.routine && R.routine.valid);
  // Robots are named by driver station, like the field displays: Blue 1, Blue 2, Blue 3.
  const station = (i) => `${state.alliance === 'red' ? 'Red' : 'Blue'} ${i + 1}`;
  const rname = (i) => state.robots[i].team || station(i);

  /** Tell the live session (if any) that this device changed robot i (or the field, i = -1). */
  const changed = (i) => AC.live && AC.live.send(i);

  let toastTimer = 0;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  /* ---------------- Steps ---------------- */

  /** Turn a PathPlanner .auto into steps: paths in order, commands become stops to fill in. */
  function stepsFromAuto(auto) {
    const steps = [];
    const kind = auto.choreoAuto ? 'traj' : 'path';
    const findPath = (cmds) => {
      for (const c of cmds || []) {
        if (c.type === 'path') return c;
        const inner = findPath(c.data && c.data.commands);
        if (inner) return inner;
      }
      return null;
    };
    const walk = (c) => {
      if (!c) return;
      const d = c.data || {};
      if (c.type === 'sequential') d.commands.forEach(walk);
      else if (c.type === 'path') steps.push({ kind, name: d.pathName });
      else if (c.type === 'wait') steps.push({ kind: 'wait', time: +d.waitTime || 0, label: 'wait' });
      else if (c.type === 'named') steps.push({ kind: 'wait', time: 0, label: d.name });
      else if (d.commands) {
        // Parallel group: if it drives, the drive is what matters (intake-while-driving etc.)
        const p = findPath(d.commands);
        if (p) walk(p);
        else {
          const n = d.commands.find((x) => x.type === 'named');
          steps.push({ kind: 'wait', time: 0, label: n ? n.data.name : 'command' });
        }
      }
    };
    walk(auto.command);
    return steps;
  }

  function defaultSteps(lib) {
    const e = lib.entries();
    if (e.autos.length) return stepsFromAuto(lib.autos.get(e.autos[0]));
    // One trajectory is unambiguous; with several, the team clicks them in order.
    const all = e.trajs.map((n) => ({ kind: 'traj', name: n })).concat(e.paths.map((n) => ({ kind: 'path', name: n })));
    return all.length === 1 ? all : [];
  }

  /* ---------------- Mirroring ---------------- */

  /**
   * Paths are written in blue-alliance coordinates. A robot can be mirrored left/right
   * (top/bottom of the field), and the whole alliance can be moved to the red side
   * using the season's real field symmetry (2025/2026 rotate, 2024 mirrors).
   */
  function poseTransform(R) {
    const f = field();
    const mirror = R.mirror;
    const red = state.alliance === 'red';
    if (!mirror && !red) return null;
    return (p) => {
      let { x, y, h, vx, vy, w } = p;
      if (mirror) [y, h, vy, w] = [f.width - y, -h, -vy, -w];
      if (red && f.id === '2024') [x, h, vx, w] = [f.length - x, Math.PI - h, -vx, -w];
      else if (red) [x, y, h, vx, vy] = [f.length - x, f.width - y, h + Math.PI, -vx, -vy];
      return { ...p, x, y, h, vx, vy, w };
    };
  }

  function transformed(routine, tf) {
    if (!tf || !routine) return routine;
    const out = Object.create(routine);
    out.poseAt = (t) => {
      const p = routine.poseAt(t);
      return p && tf(p);
    };
    let poly = null;
    out.timedPolyline = () => (poly = poly || routine.timedPolyline().map((q) => ({ t: q.t, ...tf({ x: q.x, y: q.y, h: 0, vx: 0, vy: 0, w: 0 }) })));
    return out;
  }

  /* ---------------- Robot cards ---------------- */

  // Which robot sections are expanded (the first one starts open).
  const openCards = new Set([0]);
  function setOpen(i, open) {
    if (open) openCards.add(i);
    else openCards.delete(i);
    const el = $(`.robot[data-i="${i}"]`);
    if (el) el.classList.toggle('open', open);
  }

  function buildCards() {
    $('#robots').innerHTML = state.robots
      .map(
        (R, i) => `
      <section class="robot${openCards.has(i) ? ' open' : ''}" data-i="${i}" style="--c:${R.color}">
        <div class="robot-head" title="Show or hide this robot's settings">
          <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="station"></span><span class="swatch" title="Path color"></span>
          <input class="team" placeholder="Team" maxlength="8" aria-label="Team number for robot ${i + 1}">
          <span class="r-sum"></span>
          <button class="icon-btn act-clear" title="Reset this robot" aria-label="Reset robot ${i + 1}"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
        </div>
        <div class="rbody">
        <div class="row files-row">
          <span class="row-label" title="Drop files or a folder anywhere on this robot">Files</span>
          <span class="files-info"></span>
          <span class="files-btns"><button class="btn sm act-files">Files…</button><button class="btn sm act-dir">Folder…</button></span>
        </div>
        <div class="dyn"></div>
        <div class="row">
          <label class="row-label" for="dl${i}">Start delay</label>
          <span class="inputs"><input type="number" id="dl${i}" class="num in-delay" min="0" step="0.1"><span class="unit">s</span></span>
        </div>
        <div class="row">
          <span class="row-label">Bumpers</span>
          <span class="inputs"><input type="number" class="num in-len" min="10" step="0.5" aria-label="Bumper length"><span class="unit">×</span><input type="number" class="num in-wid" min="10" step="0.5" aria-label="Bumper width"><span class="unit">in</span></span>
        </div>
        <div class="src-note"></div>
        <div class="row">
          <span class="row-label">Mirror</span>
          <label class="check"><input type="checkbox" class="in-mirror"> Flip left ↔ right</label>
        </div>
        </div>
      </section>`
      )
      .join('');
    state.robots.forEach((R) => bindCard(R));
  }

  function bindCard(R) {
    const i = R.index;
    const el = $(`.robot[data-i="${i}"]`);
    const edited = (rebuild) => {
      update(rebuild);
      changed(i);
    };
    $('.robot-head', el).addEventListener('click', (e) => {
      if (e.target.closest('input, button')) return;
      setOpen(i, !openCards.has(i));
    });
    $('.team', el).addEventListener('input', (e) => {
      R.team = e.target.value.trim();
      edited(false);
    });
    $('.act-clear', el).addEventListener('click', () => {
      Object.assign(R, makeRobot(i));
      edited(true);
    });
    $('.act-files', el).addEventListener('click', () => pick(i, '#file-input'));
    $('.act-dir', el).addEventListener('click', () => pick(i, '#dir-input'));
    $('.in-delay', el).addEventListener('input', (e) => {
      R.delay = Math.max(0, +e.target.value || 0);
      edited(false);
    });
    const fp = () => {
      const l = +$('.in-len', el).value * U.M_PER_IN;
      const w = +$('.in-wid', el).value * U.M_PER_IN;
      if (l > 0.25 && w > 0.25) {
        R.footprint = { ...R.footprint, length: l, width: w };
        R.footprintFromFile = '';
        edited(false);
      }
    };
    $('.in-len', el).addEventListener('input', fp);
    $('.in-mirror', el).addEventListener('change', (e) => {
      R.mirror = e.target.checked;
      edited(true);
    });
    $('.in-wid', el).addEventListener('input', fp);

    const dyn = $('.dyn', el);
    dyn.addEventListener('change', (e) => {
      const t = e.target;
      if (t.classList.contains('sel-auto')) {
        if (!t.value) return;
        R.steps = stepsFromAuto(R.lib.autos.get(t.value));
      } else if (t.classList.contains('add-sel')) {
        if (!t.value) return;
        const k = t.value.indexOf(':');
        R.steps.push({ kind: t.value.slice(0, k), name: t.value.slice(k + 1) });
      } else if (t.classList.contains('seq-sel')) {
        const k = t.value.indexOf(':');
        R.steps[+t.dataset.s] = { kind: t.value.slice(0, k), name: t.value.slice(k + 1) };
      } else return;
      edited(true);
    });
    // Stop times update the timing without redrawing the card, so the box keeps focus.
    dyn.addEventListener('input', (e) => {
      if (!e.target.classList.contains('seq-wait')) return;
      R.steps[+e.target.dataset.s].time = Math.max(0, +e.target.value || 0);
      edited(true);
    });
    dyn.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('seq-rm')) R.steps.splice(+b.dataset.s, 1);
      else if (b.classList.contains('add-stop')) R.steps.push({ kind: 'wait', time: 1, label: '' });
      else if (b.classList.contains('seq-clear')) R.steps = [];
      else return;
      edited(true);
    });
    // Drag a step row to reorder it
    let dragFrom = -1;
    dyn.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.step');
      if (!row) return;
      dragFrom = +row.dataset.s;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'step');
      row.classList.add('dragging');
    });
    dyn.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const row = e.target.closest('.step');
      dyn.querySelectorAll('.step').forEach((r) => r.classList.toggle('drop-target', r === row));
    });
    dyn.addEventListener('drop', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const row = e.target.closest('.step');
      const to = row ? +row.dataset.s : R.steps.length - 1;
      const [st] = R.steps.splice(dragFrom, 1);
      R.steps.splice(to, 0, st);
      dragFrom = -1;
      edited(true);
    });
    dyn.addEventListener('dragend', () => {
      dragFrom = -1;
      dyn.querySelectorAll('.step').forEach((r) => r.classList.remove('dragging', 'drop-target'));
    });

    let depth = 0;
    const isFiles = (e) => [...(e.dataTransfer.types || [])].includes('Files');
    el.addEventListener('dragenter', (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth++;
      el.classList.add('dragover');
    });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        el.classList.remove('dragover');
      }
    });
    el.addEventListener('drop', async (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      el.classList.remove('dragover');
      loadInto(i, await filesFromDrop(e.dataTransfer));
    });
  }

  /** How long one step takes, or null if its file is missing. */
  function stepTime(R, st) {
    if (st.kind === 'wait') return st.time;
    try {
      const t = st.kind === 'traj' ? R.lib.getChoreo(st.name) || R.lib.getPP(st.name) : R.lib.getPP(st.name) || R.lib.getChoreo(st.name);
      return t ? t.duration : null;
    } catch (e) {
      return null;
    }
  }

  function stepsHtml(R) {
    const e = R.lib.entries();
    let html = '';
    if (e.autos.length) html += `<div class="row"><label class="row-label">PP auto</label><select class="sel sel-auto"><option value="">Load an auto…</option>${e.autos.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></div>`;

    let total = 0;
    let rows = '';
    R.steps.forEach((st, s) => {
      const t = stepTime(R, st);
      total += t || 0;
      const idx = `<span class="step-idx" title="Drag to reorder">${s + 1}</span>`;
      const rm = `<button class="icon-btn seq-rm" data-s="${s}" title="Remove" aria-label="Remove step"><svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`;
      if (st.kind === 'wait') {
        rows += `<div class="step stop" draggable="true" data-s="${s}">${idx}<span class="step-name">${st.label ? esc(st.label) : 'Stop'}</span><span class="stop-time"><input type="number" class="num seq-wait" data-s="${s}" min="0" step="0.1" value="${st.time}" aria-label="Stop seconds"></span><span class="unit">s</span>${rm}</div>`;
      } else {
        const missing = t == null;
        rows += `<div class="step${missing ? ' missing' : ''}" draggable="true" data-s="${s}">${idx}<span class="step-name" title="${esc(st.name)}">${esc(st.name)}</span><span class="step-time">${missing ? 'missing' : t.toFixed(2)}</span><span class="unit">${missing ? '' : 's'}</span>${rm}</div>`;
      }
    });
    html += `<div class="steps-head"><span class="row-label">Sequence</span>${R.steps.length ? `<span class="steps-total">${total.toFixed(2)} s</span><button class="link seq-clear">Clear</button>` : ''}</div>`;
    html += `<div class="steps">${rows || '<div class="steps-empty">Empty. Add a trajectory below.</div>'}</div>`;

    const opt = (k, n) => `<option value="${k}:${esc(n)}">${esc(n)}</option>`;
    let opts = '';
    if (e.trajs.length && e.paths.length) opts = `<optgroup label="Choreo">${e.trajs.map((n) => opt('traj', n)).join('')}</optgroup><optgroup label="PathPlanner">${e.paths.map((n) => opt('path', n)).join('')}</optgroup>`;
    else opts = e.trajs.map((n) => opt('traj', n)).join('') + e.paths.map((n) => opt('path', n)).join('');
    html += `<div class="add-row"><select class="sel add-sel" aria-label="Add a trajectory"><option value="">Add trajectory…</option>${opts}</select><button class="btn sm add-stop">Add stop</button></div>`;
    return html;
  }

  function renderCard(R) {
    const el = $(`.robot[data-i="${R.index}"]`);
    const team = $('.team', el);
    const sum = $('.r-sum', el);
    const nTraj = R.steps.filter((st) => st.kind !== 'wait').length;
    sum.textContent = R.lib.empty ? 'No files' : R.routine && R.routine.valid ? `${nTraj} path${nTraj === 1 ? '' : 's'} · ${(R.delay + R.routine.duration).toFixed(2)} s` : 'No sequence';
    const stn = $('.station', el);
    stn.textContent = station(R.index);
    stn.classList.toggle('red', state.alliance === 'red');
    if (document.activeElement !== team) team.value = R.team;
    const hasFiles = !R.lib.empty;
    $('.files-info', el).textContent = hasFiles ? `${R.lib.fileCount} loaded` : 'None';
    $('.files-info', el).classList.toggle('none', !hasFiles);

    let html = '';
    if (hasFiles) {
      html += stepsHtml(R);
      const msgs = [...R.lib.messages.map((m) => m.text), ...(R.routine ? R.routine.warnings : [])];
      html += msgs.slice(0, 4).map((m) => `<div class="msg">${esc(m)}</div>`).join('');
    }
    const dyn = $('.dyn', el);
    const typing = document.activeElement && document.activeElement.tagName === 'INPUT' && dyn.contains(document.activeElement);
    if (!typing) dyn.innerHTML = html;

    const d = $('.in-delay', el);
    if (document.activeElement !== d) d.value = +R.delay.toFixed(2);
    $('.in-mirror', el).checked = !!R.mirror;
    const l = $('.in-len', el);
    const w = $('.in-wid', el);
    if (document.activeElement !== l) l.value = +(R.footprint.length / U.M_PER_IN).toFixed(1);
    if (document.activeElement !== w) w.value = +(R.footprint.width / U.M_PER_IN).toFixed(1);
    $('.src-note', el).textContent = R.footprintFromFile ? `From ${R.footprintFromFile}` : hasFiles ? 'Default size. Not found in project files.' : '';
  }

  /* ---------------- Loading files ---------------- */

  function pick(i, sel) {
    pick.target = i;
    const inp = $(sel);
    inp.value = '';
    inp.click();
  }

  const isAlliance = (name) => U.ext(name) === '.autosim';

  async function filesFromDrop(dt) {
    const entries = [...(dt.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...(dt.files || [])].map((f) => ({ file: f, path: f.name }));
    const out = [];
    const walk = async (entry, path) => {
      if (entry.isFile) {
        if (!AC.Library.accepts(entry.name) && !isAlliance(entry.name)) return;
        const file = await new Promise((res) => entry.file(res, () => res(null)));
        if (file) out.push({ file, path: path + entry.name });
      } else if (entry.isDirectory && !SKIP_DIRS.has(entry.name.toLowerCase())) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const e of batch) await walk(e, path + entry.name + '/');
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  }

  async function loadInto(i, list) {
    const alliance = list.find((f) => isAlliance(f.path));
    if (alliance) return openAlliance(alliance.file);
    const wanted = list.filter((f) => AC.Library.accepts(f.path) && !f.path.split('/').some((seg) => SKIP_DIRS.has(seg.toLowerCase())));
    if (!wanted.length) return toast('No PathPlanner or Choreo files found there', true);
    // A project folder can hold several settings.json files; use the PathPlanner one.
    const settings = wanted.filter((f) => U.fileName(f.path).toLowerCase() === 'settings.json');
    const pp = settings.find((f) => /pathplanner/i.test(f.path));
    const R = state.robots[i];
    R.lib.messages = [];
    let ok = 0;
    for (const f of wanted) {
      if (pp && settings.includes(f) && f !== pp) continue;
      if (R.lib.addFile(f.path, await f.file.text())) ok++;
    }
    applyDefaults(R);
    if (ok) setOpen(i, true);
    update(true);
    changed(i);
    toast(ok ? `${station(i)}: loaded ${ok} file${ok === 1 ? '' : 's'}` : 'Those files could not be read', !ok);
  }

  function applyDefaults(R) {
    const fp = R.lib.footprint();
    if (fp) {
      R.footprint = { length: fp.length, width: fp.width, offsetX: fp.offsetX || 0 };
      R.footprintFromFile = fp.source;
    }
    if (!R.steps.length) R.steps = defaultSteps(R.lib);
  }

  /* ---------------- Robot data (alliance files, saved session, live sessions) ---------------- */

  function robotData(R) {
    return { team: R.team, steps: R.steps, delay: R.delay, footprint: R.footprint, footprintFromFile: R.footprintFromFile, mirror: !!R.mirror, options: R.options, files: Object.fromEntries(R.lib.raw) };
  }

  function setRobot(i, d) {
    const R = state.robots[i];
    Object.assign(R, makeRobot(i));
    if (!d) return;
    for (const [name, t] of Object.entries(d.files || {})) R.lib.addFile(name, t);
    R.team = d.team || '';
    // Older saves stored a single selection instead of a list of steps.
    const sel = d.selection;
    R.steps = d.steps || (sel && sel.type === 'seq' ? sel.steps : sel && sel.type === 'auto' && R.lib.autos.has(sel.name) ? stepsFromAuto(R.lib.autos.get(sel.name)) : sel && sel.name ? [{ kind: sel.type, name: sel.name }] : []);
    R.delay = +d.delay || 0;
    R.mirror = !!d.mirror;
    R.options = Array.isArray(d.options) ? d.options.filter((o) => o && Array.isArray(o.steps)) : [];
    applyDefaults(R);
    if (d.footprint && d.footprint.length > 0) R.footprint = d.footprint;
    R.footprintFromFile = d.footprintFromFile || '';
  }

  async function saveAlliance() {
    if (!loaded().length) return toast('Load a robot first', true);
    const doc = { format: 'autosim-alliance', version: 3, fieldId: state.fieldId, alliance: state.alliance, robots: state.robots.map(robotData) };
    let blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
    if (typeof CompressionStream === 'function') blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    const teams = state.robots.map((R) => R.team).filter(Boolean);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (teams.length ? teams.join('-') : 'alliance') + '.autosim';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Saved ${a.download}`);
  }

  async function openAlliance(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
      const text = gz ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(bytes);
      let doc = null;
      try {
        doc = JSON.parse(text);
      } catch (e) {
        doc = null;
      }
      if (!doc || doc.format !== 'autosim-alliance' || !Array.isArray(doc.robots)) throw new Error('not an Auto Simulator alliance file');
      if (AC.fields.list.some((f) => f.id === doc.fieldId)) state.fieldId = doc.fieldId;
      state.alliance = doc.alliance === 'red' ? 'red' : 'blue';
      syncAlliance();
      state.robots.forEach((R, i) => setRobot(i, doc.robots[i]));
      state.time = 0;
      $('#field-select').value = state.fieldId;
      update(true);
      [-1, 0, 1, 2].forEach(changed);
      toast(`Opened ${file.name}`);
    } catch (e) {
      toast(`Couldn’t open ${file.name}: ${e.message}`, true);
    }
  }

  /** Called by the live session with data from another device. */
  function applyRemote(msg) {
    if (msg.fieldId && AC.fields.list.some((f) => f.id === msg.fieldId)) {
      state.fieldId = msg.fieldId;
      $('#field-select').value = state.fieldId;
    }
    if (msg.alliance) {
      state.alliance = msg.alliance === 'red' ? 'red' : 'blue';
      syncAlliance();
    }
    if (msg.robots) msg.robots.forEach((d, i) => setRobot(i, d));
    if (msg.robot) setRobot(msg.i, msg.robot);
    update(true);
  }

  /* ---------------- Update + results ---------------- */

  /** rebuild = files or steps changed, so routines need regenerating. */
  function update(rebuild) {
    // Always rebuild the mirrored view: it depends on the field and alliance too.
    if (rebuild && combo.result && !combo.applying) combo.stale = true;
    for (const R of state.robots) {
      R.short = `${state.alliance === 'red' ? 'R' : 'B'}${R.index + 1}`;
      if (rebuild || !R.base) R.base = R.lib.empty ? null : AC.buildRoutine(R.lib, { type: 'seq', steps: R.steps }, {});
      R.routine = transformed(R.base, poseTransform(R));
    }
    const rs = loaded();
    const res = rs.length > 1 ? AC.collide.analyze(rs, field()) : { events: [], T: Math.max(field().autoTime, ...rs.map((R) => R.delay + R.routine.duration)) };
    state.events = res.events;
    state.T = res.T;
    state.time = U.clamp(state.time, 0, state.T);
    state.robots.forEach(renderCard);
    renderResults(rs);
    renderCombos();
    $('#time-total').textContent = state.T.toFixed(2);
    draw();
    save();
  }

  function renderResults(rs) {
    const st = $('#status');
    const ev = state.events;
    const span = `<b>${state.T.toFixed(2)}</b> s simulated`;
    if (rs.length < 2) {
      st.className = 'status idle';
      st.innerHTML = '<span class="badge">Idle</span><span class="s-text">Load two or more robots.</span>';
    } else if (ev.length) {
      st.className = 'status bad';
      st.innerHTML = `<span class="badge">Collision</span><span class="s-text"><b>${ev.length}</b> contact${ev.length > 1 ? 's' : ''} · ${span}</span>`;
    } else {
      st.className = 'status ok';
      st.innerHTML = `<span class="badge">Clear</span><span class="s-text"><b>0</b> contacts · ${span}</span>`;
    }
    const late = rs.filter((R) => R.delay + R.routine.duration > field().autoTime + 1e-6);
    const head = ev.length ? '<div class="tbl-head ev-grid"><span>#</span><span>Robots</span><span>Time (s)</span><span>Depth</span></div>' : '';
    $('#events').innerHTML =
      head +
      ev
        .map((e, k) => {
          const parked = e.robots.filter((r, j) => !e.moving[j]).map(rname);
          const note = parked.length === 2 ? 'Both stationary' : parked.length ? `${esc(parked[0])} stationary` : '';
          return `<button class="event ev-grid" data-k="${k}" title="Jump to this contact"><span class="e-ic">${e.num}</span><span class="e-t">${esc(rname(e.robots[0]))} × ${esc(rname(e.robots[1]))}${note ? `<span class="e-n">${note}</span>` : ''}</span><span class="e-m">${e.t0.toFixed(2)}–${e.t1.toFixed(2)}</span><span class="e-m">${(e.depth / U.M_PER_IN).toFixed(1)} in</span></button>`;
        })
        .join('') +
      late.map((R) => `<div class="msg">${esc(rname(R.index))} runs past the ${field().autoTime} s autonomous period.</div>`).join('');
  }

  /* ---------------- Combinations ---------------- */

  /**
   * Every robot gets a list of candidate autos: the PathPlanner autos in its files, any
   * sequences saved as options, and its current sequence (optionally each one mirrored).
   * Each pair of candidates from two robots is simulated once, then a combination works
   * when none of its pairs collide.
   */
  const combo = { mirrorToo: false, running: false, progress: 0, result: null, stale: false, applied: -1, applying: false };
  const sameSteps = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const comboRobots = () => state.robots.filter((R) => !R.lib.empty);

  function stepsLabel(steps) {
    const n = steps.filter((st) => st.kind !== 'wait').map((st) => st.name);
    if (!n.length) return 'Stops only';
    return n.length > 3 ? `${n[0]} → … → ${n[n.length - 1]}` : n.join(' → ');
  }

  function candidates(R) {
    const out = [];
    const add = (name, steps) => {
      if (steps.length && !out.some((c) => sameSteps(c.steps, steps))) out.push({ name, steps });
    };
    for (const n of R.lib.entries().autos) add(n, stepsFromAuto(R.lib.autos.get(n)));
    for (const o of R.options) add(o.name, o.steps);
    add('Current sequence', R.steps);
    const mirrors = combo.mirrorToo ? [false, true] : [!!R.mirror];
    return out.flatMap((c) => mirrors.map((m) => ({ ...c, mirror: m })));
  }

  const comboCount = () => {
    const rs = comboRobots();
    return rs.length < 2 ? 0 : rs.reduce((n, R) => n * candidates(R).length, 1);
  };

  async function runCombos() {
    const robots = comboRobots();
    if (robots.length < 2) return toast('Load at least two robots', true);
    const f = field();
    const sets = robots.map((R) =>
      candidates(R)
        .map((c) => {
          let routine = null;
          try {
            routine = transformed(AC.buildRoutine(R.lib, { type: 'seq', steps: c.steps }, {}), poseTransform({ mirror: c.mirror }));
          } catch (e) {
            routine = null;
          }
          return { ...c, sim: { index: R.index, routine, delay: R.delay, footprint: R.footprint } };
        })
        .filter((c) => c.sim.routine && c.sim.routine.valid)
    );
    const empty = robots.find((R, r) => !sets[r].length);
    if (empty) return toast(`${rname(empty.index)} has no auto that drives`, true);

    combo.running = true;
    combo.progress = 0;
    renderCombos();
    // Simulate each pair of candidates once (20 ms steps is plenty to screen combinations).
    const hits = new Map();
    let jobs = 0;
    let done = 0;
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) jobs += sets[i].length * sets[j].length;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        for (let a = 0; a < sets[i].length; a++) {
          for (let b = 0; b < sets[j].length; b++) {
            const n = AC.collide.analyze([sets[i][a].sim, sets[j][b].sim], f, 0.02).events.length;
            hits.set(`${i}.${a}|${j}.${b}`, n);
            if (++done % 15 === 0) {
              combo.progress = done / jobs;
              renderCombos();
              await new Promise((r) => setTimeout(r));
            }
          }
        }
      }
    }
    // Every combination = one candidate per robot.
    const list = [];
    const pick = new Array(sets.length).fill(0);
    for (;;) {
      const clashes = [];
      for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) if (hits.get(`${i}.${pick[i]}|${j}.${pick[j]}`)) clashes.push([robots[i].index, robots[j].index]);
      const time = Math.max(...pick.map((a, r) => sets[r][a].sim.delay + sets[r][a].sim.routine.duration));
      list.push({ picks: pick.map((a, r) => ({ R: robots[r], cand: sets[r][a] })), clashes, time });
      let r = sets.length - 1;
      while (r >= 0 && ++pick[r] === sets[r].length) pick[r--] = 0;
      if (r < 0) break;
    }
    list.sort((x, y) => x.clashes.length - y.clashes.length || x.time - y.time);
    combo.result = { list, total: list.length, ok: list.filter((c) => !c.clashes.length).length };
    combo.running = false;
    combo.stale = false;
    combo.applied = -1;
    renderCombos();
  }

  function applyCombo(k) {
    const c = combo.result.list[k];
    combo.applying = true;
    for (const { R, cand } of c.picks) {
      R.steps = cand.steps.map((st) => ({ ...st }));
      R.mirror = cand.mirror;
    }
    update(true);
    combo.applying = false;
    c.picks.forEach(({ R }) => changed(R.index));
    combo.applied = k;
    seek(0);
    renderCombos();
  }

  const X_ICON = '<svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  function renderCombos() {
    const el = $('#combos');
    if (!el) return;
    const rs = comboRobots();
    if (rs.length < 2) {
      el.innerHTML = '<div class="c-note">Load two or more robots to compare every auto combination.</div>';
      return;
    }
    let html = '<div class="c-robots">';
    for (const R of rs) {
      const base = candidates(R).length / (combo.mirrorToo ? 2 : 1);
      html += `<div class="c-robot" style="--c:${R.color}"><span class="swatch"></span><span class="c-name">${esc(rname(R.index))}</span><span class="c-count">${base} option${base === 1 ? '' : 's'}</span><button class="link c-save" data-i="${R.index}" title="Add the current sequence to this robot's options">Save sequence</button></div>`;
      R.options.forEach((o, k) => {
        html += `<div class="c-opt"><span title="${esc(o.name)}">${esc(o.name)}</span><button class="icon-btn c-del" data-i="${R.index}" data-o="${k}" title="Remove option" aria-label="Remove option">${X_ICON}</button></div>`;
      });
    }
    html += '</div>';
    const n = comboCount();
    html += `<label class="check"><input type="checkbox" class="c-mirror"${combo.mirrorToo ? ' checked' : ''}> Include mirrored variants</label>`;
    html += combo.running
      ? `<div class="c-progress"><span style="width:${(combo.progress * 100).toFixed(0)}%"></span></div>`
      : `<button class="btn c-run">Run ${n} combination${n === 1 ? '' : 's'}</button>`;

    const res = combo.result;
    if (res && !combo.running) {
      html += `<div class="c-sum ${res.ok ? 'ok' : 'bad'}">${res.ok ? `<b>${res.ok}</b> of <b>${res.total}</b> clear` : `<b>0</b> of <b>${res.total}</b> clear. Closest:`}${combo.stale ? '<span class="c-stale">Inputs changed since this run.</span>' : ''}</div><div class="c-list">`;
      const shown = res.ok ? res.list.filter((c) => !c.clashes.length).slice(0, 40) : res.list.slice(0, 5);
      shown.forEach((c) => {
        const k = res.list.indexOf(c);
        const lines = c.picks.map(({ R, cand }) => `<div class="c-line" style="--c:${R.color}"><span class="swatch"></span><span class="c-team">${esc(rname(R.index))}</span><span class="c-auto" title="${esc(cand.name)}">${esc(cand.name)}${cand.mirror ? ' <i>(mirrored)</i>' : ''}</span></div>`).join('');
        const clash = c.clashes.map(([a, b]) => `${esc(rname(a))} × ${esc(rname(b))}`).join(', ');
        html += `<button class="combo${k === combo.applied ? ' on' : ''}" data-k="${k}" title="Show this combination on the field">${lines}<div class="c-meta">${clash ? `<span class="c-clash">${clash}</span>` : '<span class="c-okay">Clear</span>'}<span><b>${c.time.toFixed(2)}</b> s</span></div></button>`;
      });
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function bindCombos() {
    const el = $('#combos');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('c-run')) runCombos();
      else if (b.classList.contains('combo')) applyCombo(+b.dataset.k);
      else if (b.classList.contains('c-save')) {
        const R = state.robots[+b.dataset.i];
        if (!R.steps.length) return toast('This robot has no sequence yet', true);
        if (R.options.some((o) => sameSteps(o.steps, R.steps))) return toast('That sequence is already saved');
        R.options.push({ name: stepsLabel(R.steps), steps: R.steps.map((st) => ({ ...st })) });
        renderCombos();
        changed(R.index);
        save();
      } else if (b.classList.contains('c-del')) {
        const R = state.robots[+b.dataset.i];
        R.options.splice(+b.dataset.o, 1);
        renderCombos();
        changed(R.index);
        save();
      }
    });
    el.addEventListener('change', (e) => {
      if (!e.target.classList.contains('c-mirror')) return;
      combo.mirrorToo = e.target.checked;
      renderCombos();
    });
  }

  /* ---------------- Drawing + playback ---------------- */

  let view;
  let timeline;
  let needsDraw = true;
  const draw = () => (needsDraw = true);

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state.playing) {
      state.time += dt;
      if (state.time >= state.T) {
        state.time = state.T;
        setPlaying(false);
      }
      needsDraw = true;
    }
    if (needsDraw) {
      const S = { field: field(), alliance: state.alliance, robots: loaded(), time: state.time, events: state.events, T: state.T };
      view.draw(S);
      timeline.draw(S);
      $('#time-now').textContent = state.time.toFixed(2);
      needsDraw = false;
    }
    requestAnimationFrame(frame);
  }

  function setPlaying(p) {
    if (p && state.time >= state.T - 1e-3) state.time = 0;
    state.playing = p;
    document.body.classList.toggle('playing', p);
  }
  function seek(t) {
    setPlaying(false);
    state.time = U.clamp(t, 0, state.T);
    draw();
  }

  function syncAlliance() {
    document.querySelectorAll('#alliance-seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.alliance));
  }

  /* ---------------- Remember the last session ---------------- */

  /**
   * Everything (files included) is kept in the browser's IndexedDB, which holds far more
   * than localStorage, so a refresh or reopening the page brings the whole setup back.
   */
  const store = {
    db: null,
    open() {
      if (!this.db)
        this.db = new Promise((res, rej) => {
          const r = indexedDB.open('autosim', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      return this.db;
    },
    async get(key) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const q = db.transaction('kv').objectStore('kv').get(key);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    },
    async set(key, value) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(value, key);
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
    },
  };

  /*
   * Settings (teams, sequences, delays, alliance...) are small, so they are written to
   * localStorage instantly on every change and survive even an immediate refresh.
   * Path files can be many MB, so each robot's files go to IndexedDB once, when they change.
   */
  const META_KEY = 'autosim.v2';
  let restoring = true; // don't overwrite the saved setup before it has been loaded
  const savedSig = [];
  const filesSig = (R) => [...R.lib.raw].map(([n, t]) => `${n}:${t.length}`).join('|');

  function save() {
    if (restoring) return;
    const meta = { fieldId: state.fieldId, alliance: state.alliance, robots: state.robots.map((R) => ({ ...robotData(R), files: undefined })) };
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch (e) {
      /* storage blocked */
    }
    state.robots.forEach((R, i) => {
      const sig = filesSig(R);
      if (sig === savedSig[i]) return;
      savedSig[i] = sig;
      store.set(`files:${i}`, Object.fromEntries(R.lib.raw)).catch(() => {});
    });
  }

  async function restore() {
    let meta = null;
    try {
      meta = JSON.parse(localStorage.getItem(META_KEY) || 'null');
    } catch (e) {
      meta = null;
    }
    try {
      if (meta && Array.isArray(meta.robots)) {
        const files = await Promise.all([0, 1, 2].map((i) => store.get(`files:${i}`).catch(() => null)));
        if (AC.fields.list.some((f) => f.id === meta.fieldId)) state.fieldId = meta.fieldId;
        state.alliance = meta.alliance === 'red' ? 'red' : 'blue';
        meta.robots.forEach((r, i) => setRobot(i, { ...r, files: files[i] || {} }));
      } else {
        // Older versions kept everything (files included) in one localStorage entry.
        const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (d && Array.isArray(d.robots)) {
          if (AC.fields.list.some((f) => f.id === d.fieldId)) state.fieldId = d.fieldId;
          state.alliance = d.alliance === 'red' ? 'red' : 'blue';
          d.robots.forEach((r, i) => setRobot(i, r));
        }
      }
      state.robots.forEach((R, i) => {
        savedSig[i] = filesSig(R);
        if (!R.lib.empty) openCards.add(i);
      });
    } catch (e) {
      /* ignore a broken saved setup */
    }
    restoring = false;
  }

  /* ---------------- Init ---------------- */

  async function init() {
    const fs = $('#field-select');
    fs.innerHTML = AC.fields.list.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    await restore();
    fs.value = state.fieldId;
    buildCards();

    view = new AC.FieldView($('#field-canvas'));
    view.requestDraw = draw;
    // Redraw once the number font arrives so canvas labels use it.
    if (document.fonts) document.fonts.load(AC.NUM_FONT, '0123456789').then(() => draw()).catch(() => {});
    AC.fields.list.forEach((f) => view.image(f)); // preload every season's field image
    view.onPick = (e) => seek(e.t0);
    timeline = new AC.Timeline($('#timeline-canvas'), seek);
    timeline.requestDraw = draw;

    $('#alliance-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.dataset.v === state.alliance) return;
      state.alliance = b.dataset.v;
      syncAlliance();
      update();
      changed(-1);
    });
    syncAlliance();
    fs.addEventListener('change', () => {
      state.fieldId = fs.value;
      update();
      changed(-1);
    });
    bindCombos();
    $('#btn-save').addEventListener('click', saveAlliance);
    $('#btn-open').addEventListener('click', () => pick(-1, '#alliance-input'));
    $('#alliance-input').addEventListener('change', (e) => e.target.files[0] && openAlliance(e.target.files[0]));
    $('#file-input').addEventListener('change', (e) => loadInto(pick.target, [...e.target.files].map((f) => ({ file: f, path: f.name }))));
    $('#dir-input').addEventListener('change', (e) => loadInto(pick.target, [...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))));
    $('#btn-play').addEventListener('click', () => setPlaying(!state.playing));
    $('#btn-start').addEventListener('click', () => seek(0));
    $('#events').addEventListener('click', (e) => {
      const b = e.target.closest('.event');
      if (b) seek(state.events[+b.dataset.k].t0);
    });

    // Dropping outside a card goes to the first empty robot (or opens an alliance file).
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const target = state.robots.findIndex((R) => R.lib.empty);
      loadInto(target >= 0 ? target : 0, await filesFromDrop(e.dataTransfer));
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.target.closest('input, select, button')) {
        e.preventDefault();
        setPlaying(!state.playing);
      }
    });

    update(true);
    requestAnimationFrame(frame);
    AC.app = { state, combo, runCombos, update, seek, loadInto, openAlliance, applyRemote, robotData, toast, stepsFromAuto };
    if (AC.live) AC.live.init();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
