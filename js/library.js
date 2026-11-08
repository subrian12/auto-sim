/* Auto Sim — per-robot file library: parses Choreo + PathPlanner project files */
(function () {
  'use strict';
  const AC = (window.AC = window.AC || {});
  const U = AC.util;

  /* ---------------- Choreo ---------------- */

  function choreoSamples(raw) {
    return raw.map((s) => {
      const t = U.num(s.t, U.num(s.timestamp, 0));
      const h = U.num(s.heading, 0);
      let vx = U.num(s.vx, U.num(s.velocityX, 0));
      let vy = U.num(s.vy, U.num(s.velocityY, 0));
      if (s.vl != null && s.vr != null && s.vx == null) {
        const vv = (s.vl + s.vr) / 2;
        vx = vv * Math.cos(h);
        vy = vv * Math.sin(h);
      }
      return { t, x: U.num(s.x, 0), y: U.num(s.y, 0), h, vx, vy, w: U.num(s.omega, U.num(s.angularVelocity, 0)) };
    });
  }

  /** Returns {traj, splits} or throws. Handles Choreo 2025+ (v1..v3) and 2024 formats. */
  function parseChoreoTraj(json, name) {
    let raw;
    let splits = [];
    const events = [];
    if (json.trajectory && Array.isArray(json.trajectory.samples)) {
      raw = json.trajectory.samples;
      splits = Array.isArray(json.trajectory.splits) ? json.trajectory.splits.slice() : [];
      const wptTimes = Array.isArray(json.trajectory.waypoints) ? json.trajectory.waypoints : [];
      for (const ev of json.events || []) {
        const from = ev.from || {};
        let t = U.num(from.targetTimestamp, null);
        if (t == null && typeof from.target === 'number') t = U.num(wptTimes[from.target], null);
        if (t == null) continue;
        t += U.val(from.offset, 0);
        const nm = ev.name || (ev.event && ev.event.data && ev.event.data.name) || 'event';
        events.push({ t, name: nm });
      }
    } else if (Array.isArray(json.samples)) {
      raw = json.samples;
      for (const m of json.eventMarkers || []) {
        if (typeof m.timestamp === 'number') events.push({ t: m.timestamp, name: m.name || 'marker' });
      }
    } else if (Array.isArray(json.trajectory)) {
      raw = json.trajectory; // 2024 .chor path entry
    } else {
      throw new Error('not a Choreo trajectory');
    }
    if (!raw.length) throw new Error('has no samples — generate it in Choreo first');
    const samples = choreoSamples(raw).sort((a, b) => a.t - b.t);
    const traj = new AC.Trajectory(name, samples, { source: 'choreo', events });
    if (splits.length && splits[0] !== 0) splits.unshift(0);
    return { traj, splits: splits.filter((i) => i >= 0 && i < samples.length) };
  }

  /* ---------------- Library ---------------- */

  class Library {
    constructor() {
      this.raw = new Map(); // fileName -> text (for persistence)
      this.trajs = new Map(); // name -> {traj, splits}
      this.ppPaths = new Map(); // name -> json
      this.autos = new Map(); // name -> json
      this.settings = null; // PathPlanner settings.json
      this.choreoConfig = null; // footprint from .chor
      this.messages = []; // {level, text}
      this.cache = new Map();
    }

    get empty() {
      return !this.trajs.size && !this.ppPaths.size && !this.autos.size;
    }

    get fileCount() {
      return this.raw.size;
    }

    /** Is this a file name we care about? */
    static accepts(fileName) {
      const e = U.ext(fileName);
      const f = U.fileName(fileName).toLowerCase();
      return e === '.traj' || e === '.chor' || e === '.path' || e === '.auto' || f === 'settings.json';
    }

    addFile(fileName, text) {
      const file = U.fileName(fileName);
      const ext = U.ext(file);
      const base = U.baseName(file);
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        this.messages.push({ level: 'error', text: `${file}: not valid JSON` });
        return false;
      }
      this.cache.clear();
      try {
        if (ext === '.traj') {
          this.trajs.set(base, parseChoreoTraj(json, base));
        } else if (ext === '.chor') {
          this.parseChor(json, file);
        } else if (ext === '.path') {
          if (!Array.isArray(json.waypoints)) throw new Error('missing waypoints');
          this.ppPaths.set(base, json);
        } else if (ext === '.auto') {
          if (!json.command) throw new Error('missing command tree');
          this.autos.set(base, json);
        } else if (file.toLowerCase() === 'settings.json') {
          if (json.robotWidth == null && json.defaultMaxVel == null && json.robotLength == null) return false;
          this.settings = json;
        } else {
          return false;
        }
      } catch (e) {
        this.messages.push({ level: 'error', text: `${file}: ${e.message}` });
        return false;
      }
      this.raw.set(file, text);
      return true;
    }

    parseChor(json, file) {
      const cfg = json.config;
      if (cfg && cfg.bumper) {
        const front = U.val(cfg.bumper.front, null);
        const back = U.val(cfg.bumper.back, null);
        const side = U.val(cfg.bumper.side, null);
        if (front != null && back != null && side != null) {
          this.choreoConfig = { length: front + back, width: 2 * side, offsetX: (front - back) / 2, source: file };
        }
      } else if (json.robotConfiguration) {
        const rc = json.robotConfiguration;
        if (rc.bumperLength && rc.bumperWidth) this.choreoConfig = { length: rc.bumperLength, width: rc.bumperWidth, offsetX: 0, source: file };
      }
      // Choreo 2024 kept every path (with its generated trajectory) inside the .chor file.
      if (json.paths && typeof json.paths === 'object') {
        for (const [name, p] of Object.entries(json.paths)) {
          if (Array.isArray(p.trajectory) && p.trajectory.length) {
            try {
              this.trajs.set(name, parseChoreoTraj({ samples: p.trajectory, eventMarkers: p.eventMarkers }, name));
            } catch (e) {
              this.messages.push({ level: 'warn', text: `${file} → ${name}: ${e.message}` });
            }
          }
        }
      }
    }

    /** Best-known bumper footprint from loaded config files. */
    footprint() {
      if (this.settings && this.settings.robotWidth && this.settings.robotLength) {
        return {
          length: this.settings.robotLength,
          width: this.settings.robotWidth,
          offsetX: U.num(this.settings.bumperOffsetX, 0),
          source: 'PathPlanner settings.json',
        };
      }
      if (this.choreoConfig) return { ...this.choreoConfig, source: this.choreoConfig.source };
      return null;
    }

    /** Selector entries, grouped. */
    entries() {
      const sort = (m) => [...m.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return {
        autos: sort(this.autos),
        paths: sort(this.ppPaths),
        trajs: sort(this.trajs),
      };
    }

    defaultSelection() {
      const e = this.entries();
      if (e.autos.length) return { type: 'auto', name: e.autos[0] };
      if (e.trajs.length === 1 && !e.paths.length) return { type: 'traj', name: e.trajs[0] };
      if (e.paths.length === 1 && !e.trajs.length) return { type: 'path', name: e.paths[0] };
      if (e.trajs.length) return { type: 'traj', name: e.trajs[0] };
      if (e.paths.length) return { type: 'path', name: e.paths[0] };
      return null;
    }

    /** Resolve a Choreo trajectory by name, supporting split references like "Name.1". */
    getChoreo(name) {
      if (this.trajs.has(name)) return this.trajs.get(name).traj;
      const m = /^(.*)\.(\d+)$/.exec(name);
      if (m && this.trajs.has(m[1])) {
        const key = 'split:' + name;
        if (this.cache.has(key)) return this.cache.get(key);
        const { traj, splits } = this.trajs.get(m[1]);
        const idx = +m[2];
        if (!splits.length) return idx === 0 ? traj : null;
        if (idx >= splits.length) return null;
        const i0 = splits[idx];
        const i1 = idx + 1 < splits.length ? splits[idx + 1] : traj.samples.length - 1;
        const out = traj.sliceIndices(name, i0, i1);
        this.cache.set(key, out);
        return out;
      }
      return null;
    }

    /** Generate (and cache) a PathPlanner path. */
    getPP(name, startRotDeg, startVel) {
      const json = this.ppPaths.get(name);
      if (!json) return null;
      const key = `pp:${name}:${startRotDeg == null ? '-' : startRotDeg.toFixed(3)}:${startVel == null ? '-' : startVel.toFixed(3)}`;
      if (this.cache.has(key)) return this.cache.get(key);
      const traj = AC.ppgen.generate(json, { name, startRotDeg, startVel, settings: this.settings });
      this.cache.set(key, traj);
      return traj;
    }

    clear() {
      Object.assign(this, new Library());
    }
  }

  AC.Library = Library;
  AC.parseChoreoTraj = parseChoreoTraj;
})();
