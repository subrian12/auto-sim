/* Auto Sim — app controller */
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
    return { index: i, color: AC.ROBOT_COLORS[i], team: '', lib: new AC.Library(), steps: [], delay: 0, footprint: { ...DEFAULT_FP }, footprintFromFile: '', mirror: false, base: null, routine: null };
  }

  const state = { fieldId: '2026', alliance: 'blue', robots: [0, 1, 2].map(makeRobot), time: 0, playing: false, events: [], T: 20 };
  const field = () => AC.fields.get(state.fieldId);
  const loaded = () => state.robots.filter((R) => R.routine && R.routine.valid);
  const rname = (i) => state.robots[i].team || `Robot ${i + 1}`;

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

  function buildCards() {
    $('#robots').innerHTML = state.robots
      .map(
        (R, i) => `
      <div class="robot" data-i="${i}" style="--c:${R.color}">
        <div class="robot-head">
          <span class="dot"></span><span class="rname">Robot ${i + 1}</span>
          <input class="team" placeholder="Team #" maxlength="8" aria-label="Team number for robot ${i + 1}">
          <button class="icon-btn act-clear" title="Remove this robot's files">✕</button>
        </div>
        <div class="drop">
          <div class="drop-main">Drop auto files or a folder here</div>
          <div class="drop-btns"><button class="btn sm act-files">Choose files</button><button class="btn sm act-dir">Choose folder</button></div>
        </div>
        <div class="rbody">
          <div class="dyn"></div>
          <div class="params">
            <label class="num-field">Start delay <span class="inputs"><input type="number" class="num in-delay" min="0" step="0.1"> s</span></label>
            <div class="num-field">Bumper size (L × W) <span class="inputs"><input type="number" class="num in-len" min="10" step="0.5" aria-label="Bumper length"> × <input type="number" class="num in-wid" min="10" step="0.5" aria-label="Bumper width"> in</span></div>
          </div>
          <label class="check"><input type="checkbox" class="in-mirror"> Mirror left ↔ right</label>
          <div class="src-note"></div>
        </div>
      </div>`
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
      else if (b.classList.contains('add-traj')) R.steps.push({ kind: b.dataset.kind, name: b.dataset.name });
      else if (b.classList.contains('add-stop')) R.steps.push({ kind: 'wait', time: 1, label: '' });
      else if (b.classList.contains('seq-clear')) R.steps = [];
      else return;
      edited(true);
    });
    // Search box for teams with lots of trajectories
    dyn.addEventListener('input', (e) => {
      if (!e.target.classList.contains('add-filter')) return;
      const q = e.target.value.trim().toLowerCase();
      dyn.querySelectorAll('.add-traj').forEach((b) => (b.hidden = q && !b.dataset.name.toLowerCase().includes(q)));
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
    if (e.autos.length) html += `<label class="stack">Start from a PathPlanner auto<select class="sel sel-auto"><option value="">Choose…</option>${e.autos.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></label>`;

    html += `<div class="steps-head"><span>Auto order</span>${R.steps.length ? '<button class="link seq-clear">Clear</button>' : ''}</div><div class="steps">`;
    if (!R.steps.length) html += '<div class="steps-empty">Click trajectories below to add them in order.</div>';
    let total = 0;
    R.steps.forEach((st, s) => {
      const t = stepTime(R, st);
      total += t || 0;
      const handle = '<span class="grip" title="Drag to reorder">⋮⋮</span>';
      const rm = `<button class="icon-btn seq-rm" data-s="${s}" title="Remove">✕</button>`;
      if (st.kind === 'wait') {
        html += `<div class="step stop" draggable="true" data-s="${s}">${handle}<span class="step-name">${st.label ? esc(st.label) : 'Stop'}</span><span class="stop-time"><input type="number" class="num seq-wait" data-s="${s}" min="0" step="0.1" value="${st.time}" aria-label="Stop seconds"> s</span>${rm}</div>`;
      } else {
        const missing = t == null;
        html += `<div class="step${missing ? ' missing' : ''}" draggable="true" data-s="${s}">${handle}<span class="step-name" title="${esc(st.name)}">${esc(st.name)}</span><span class="step-time">${missing ? 'missing' : t.toFixed(2) + ' s'}</span>${rm}</div>`;
      }
    });
    html += '</div>';
    if (R.steps.length) html += `<div class="steps-total">Total ${total.toFixed(2)} s</div>`;

    const items = e.trajs.map((n) => ['traj', n]).concat(e.paths.map((n) => ['path', n]));
    html += '<div class="add-box"><div class="add-head">Add to auto</div>';
    if (items.length > 10) html += '<input type="text" class="add-filter" placeholder="Search trajectories" aria-label="Search trajectories">';
    html += '<div class="add-list">';
    html += items.map(([k, n]) => `<button class="add-traj" data-kind="${k}" data-name="${esc(n)}" title="Add ${esc(n)}">${esc(n)}</button>`).join('');
    html += '<button class="add-stop">+ Stop</button></div></div>';
    return html;
  }

  function renderCard(R) {
    const el = $(`.robot[data-i="${R.index}"]`);
    const team = $('.team', el);
    if (document.activeElement !== team) team.value = R.team;
    const hasFiles = !R.lib.empty;
    $('.drop', el).classList.toggle('compact', hasFiles);
    $('.act-files', el).textContent = hasFiles ? 'Add files' : 'Choose files';
    $('.act-dir', el).textContent = hasFiles ? 'Folder' : 'Choose folder';
    $('.drop-main', el).textContent = hasFiles ? `${R.lib.fileCount} file${R.lib.fileCount === 1 ? '' : 's'} loaded` : 'Drop auto files or a folder here';

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
    const dur = R.routine && R.routine.valid ? `Runs ${R.routine.duration.toFixed(2)} s. ` : '';
    $('.src-note', el).textContent = dur + (R.footprintFromFile ? `Bumpers from ${R.footprintFromFile}.` : hasFiles ? 'Bumper size not in files, so check it.' : '');
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
    update(true);
    changed(i);
    toast(ok ? `Loaded ${ok} file${ok === 1 ? '' : 's'} into Robot ${i + 1}` : 'Those files could not be read', !ok);
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
    return { team: R.team, steps: R.steps, delay: R.delay, footprint: R.footprint, footprintFromFile: R.footprintFromFile, mirror: !!R.mirror, files: Object.fromEntries(R.lib.raw) };
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
      if (!doc || doc.format !== 'autosim-alliance' || !Array.isArray(doc.robots)) throw new Error('not an Auto Sim alliance file');
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
    for (const R of state.robots) {
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
    $('#empty-state').hidden = state.robots.some((R) => !R.lib.empty);
    $('#time-total').textContent = state.T.toFixed(2);
    draw();
    save();
  }

  function renderResults(rs) {
    const st = $('#status');
    const ev = state.events;
    if (rs.length < 2) {
      st.className = 'status idle';
      st.innerHTML = `<div class="s-title">Waiting for autos</div><div class="s-sub">Load at least two robots.</div>`;
    } else if (ev.length) {
      st.className = 'status bad';
      st.innerHTML = `<div class="s-title">${ev.length} collision${ev.length > 1 ? 's' : ''}</div><div class="s-sub">Click one to see it on the field.</div>`;
    } else {
      st.className = 'status ok';
      st.innerHTML = `<div class="s-title">No collisions</div><div class="s-sub">The ${rs.length} autos never touch.</div>`;
    }
    const late = rs.filter((R) => R.delay + R.routine.duration > field().autoTime + 1e-6);
    $('#events').innerHTML =
      ev
        .map((e, k) => {
          const parked = e.robots.filter((r, j) => !e.moving[j]).map(rname);
          const note = parked.length === 2 ? 'Both robots are stopped here.' : parked.length ? `${esc(parked[0])} is stopped here.` : '';
          return `<button class="event" data-k="${k}"><span class="e-ic">${e.num}</span><span><div class="e-t">${esc(rname(e.robots[0]))} hits ${esc(rname(e.robots[1]))}</div><div class="e-m">${e.t0.toFixed(2)}–${e.t1.toFixed(2)} s · ${(e.depth / U.M_PER_IN).toFixed(1)} in overlap</div>${note ? `<div class="e-n">${note}</div>` : ''}</span></button>`;
        })
        .join('') + late.map((R) => `<div class="msg">${esc(rname(R.index))} is still driving after the ${field().autoTime} s auto period ends.</div>`).join('');
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

  const save = U.debounce(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ fieldId: state.fieldId, alliance: state.alliance, robots: state.robots.map(robotData) }));
    } catch (e) {
      /* storage full or blocked: not important */
    }
  }, 400);

  function restore() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!d) return;
      if (AC.fields.list.some((f) => f.id === d.fieldId)) state.fieldId = d.fieldId;
      if (d.alliance === 'red') state.alliance = 'red';
      d.robots.forEach((r, i) => setRobot(i, r));
    } catch (e) {
      /* ignore a broken saved session */
    }
  }

  /* ---------------- Init ---------------- */

  function init() {
    const fs = $('#field-select');
    fs.innerHTML = AC.fields.list.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    restore();
    fs.value = state.fieldId;
    buildCards();

    view = new AC.FieldView($('#field-canvas'));
    view.requestDraw = draw;
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
    AC.app = { state, update, seek, loadInto, openAlliance, applyRemote, robotData, toast, stepsFromAuto };
    if (AC.live) AC.live.init();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
