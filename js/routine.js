/* Auto Sim — turns a selection (PathPlanner auto / path / Choreo traj / custom chain)
 * into a Routine: a list of timed motion segments plus timeline activities. */
(function () {
  'use strict';
  const AC = (window.AC = window.AC || {});
  const U = AC.util;

  class Routine {
    constructor() {
      this.segments = []; // {t0, t1, traj, label}
      this.activities = []; // {t0, t1, kind: 'path'|'wait'|'named', label}
      this.events = []; // {t, name}
      this.warnings = [];
      this.named = new Set();
      this.duration = 0;
      this.label = '';
      this.approximate = false;
    }

    get valid() {
      return this.segments.length > 0;
    }

    /** Pose at routine-local time t (t < 0 => waiting at the start pose). */
    poseAt(t) {
      const segs = this.segments;
      if (!segs.length) return null;
      let seg = segs[0];
      for (let i = 1; i < segs.length; i++) {
        if (segs[i].t0 <= t) seg = segs[i];
        else break;
      }
      const span = seg.t1 - seg.t0;
      const local = U.clamp(t - seg.t0, 0, span);
      const p = seg.traj.sample(local);
      const moving = t >= seg.t0 && t < seg.t1;
      if (!moving) {
        p.vx = 0;
        p.vy = 0;
        p.w = 0;
      }
      p.moving = moving;
      p.label = seg.label;
      return p;
    }

    /** Dense polyline of the whole driven route, for drawing. */
    polyline() {
      if (this._poly) return this._poly;
      const out = [];
      for (const s of this.segments) {
        for (const p of s.traj.samples) {
          if (p.t > s.t1 - s.t0 + 1e-9) break;
          out.push([p.x, p.y]);
        }
        const e = s.traj.sample(s.t1 - s.t0);
        out.push([e.x, e.y]);
      }
      this._poly = out;
      return out;
    }

    /** Polyline points along with routine time, for drawing travelled vs. remaining. */
    timedPolyline() {
      if (this._tpoly) return this._tpoly;
      const out = [];
      for (const s of this.segments) {
        let lastT = -1;
        const span = s.t1 - s.t0;
        for (const p of s.traj.samples) {
          if (p.t > span + 1e-9) break;
          if (p.t - lastT < 0.02 && p !== s.traj.samples[0]) continue;
          out.push({ t: s.t0 + p.t, x: p.x, y: p.y });
          lastT = p.t;
        }
        const e = s.traj.sample(span);
        out.push({ t: s.t1, x: e.x, y: e.y });
      }
      this._tpoly = out;
      return out;
    }
  }

  /** Build context while walking a PathPlanner command tree. */
  function makeCtx(lib, opts, routine, choreo) {
    return { lib, opts, routine, choreo, lastHeadingDeg: null, lastVel: null };
  }

  function addPath(ctx, name, t0) {
    const { lib, routine } = ctx;
    let traj = null;
    let isChoreo = ctx.choreo;
    try {
      if (isChoreo) {
        traj = lib.getChoreo(name);
        if (!traj && lib.ppPaths.has(name)) {
          isChoreo = false;
          traj = lib.getPP(name, ctx.lastHeadingDeg, ctx.lastVel);
        }
      } else {
        traj = lib.getPP(name, ctx.lastHeadingDeg, ctx.lastVel);
        if (!traj) {
          traj = lib.getChoreo(name);
          isChoreo = !!traj;
        }
      }
    } catch (e) {
      routine.warnings.push(`Path “${name}”: ${e.message}`);
      return { d: 0, limiting: true };
    }
    if (!traj) {
      routine.warnings.push(`Missing ${isChoreo ? 'Choreo trajectory' : 'path'} “${name}” — add its ${isChoreo ? '.traj' : '.path'} file`);
      return { d: 0, limiting: true };
    }
    if (!isChoreo) routine.approximate = true;
    const d = traj.duration;
    routine.segments.push({ t0, t1: t0 + d, traj, label: name });
    routine.activities.push({ t0, t1: t0 + d, kind: 'path', label: name });
    for (const e of traj.events) routine.events.push({ t: t0 + e.t, name: e.name });
    ctx.lastHeadingDeg = U.deg(traj.end.h);
    ctx.lastVel = traj.meta.endVel != null ? traj.meta.endVel : Math.hypot(traj.end.vx, traj.end.vy);
    return { d, limiting: true };
  }

  /** Clip segments/activities added since index marks so nothing runs past `end`. */
  function clip(routine, segMark, actMark, end) {
    for (let i = routine.segments.length - 1; i >= segMark; i--) {
      const s = routine.segments[i];
      if (s.t0 >= end - 1e-9 && s.t1 > s.t0) routine.segments.splice(i, 1);
      else if (s.t1 > end) s.t1 = end;
    }
    for (let i = routine.activities.length - 1; i >= actMark; i--) {
      const a = routine.activities[i];
      if (a.t0 >= end - 1e-9 && a.t1 > a.t0) routine.activities.splice(i, 1);
      else if (a.t1 > end) a.t1 = end;
    }
  }

  /** Returns {d, limiting}. `limiting` is false for named commands with no known duration. */
  function evalCmd(cmd, t0, ctx) {
    if (!cmd || typeof cmd !== 'object') return { d: 0, limiting: false };
    const data = cmd.data || {};
    const R = ctx.routine;
    switch (cmd.type) {
      case 'sequential': {
        let t = t0;
        let limiting = false;
        for (const c of data.commands || []) {
          const r = evalCmd(c, t, ctx);
          t += r.d;
          limiting = limiting || r.limiting;
        }
        return { d: t - t0, limiting };
      }
      case 'parallel':
      case 'race':
      case 'deadline': {
        const kids = data.commands || [];
        const segMark = R.segments.length;
        const actMark = R.activities.length;
        const results = [];
        const headingIn = ctx.lastHeadingDeg;
        const velIn = ctx.lastVel;
        let headingOut = headingIn;
        let velOut = velIn;
        for (const c of kids) {
          ctx.lastHeadingDeg = headingIn;
          ctx.lastVel = velIn;
          const before = R.segments.length;
          results.push(evalCmd(c, t0, ctx));
          if (R.segments.length > before) {
            headingOut = ctx.lastHeadingDeg;
            velOut = ctx.lastVel;
          }
        }
        ctx.lastHeadingDeg = headingOut;
        ctx.lastVel = velOut;
        let d;
        if (cmd.type === 'parallel') d = Math.max(0, ...results.map((r) => r.d));
        else if (cmd.type === 'deadline') d = results.length ? results[0].d : 0;
        else {
          const lim = results.filter((r) => r.limiting);
          d = lim.length ? Math.min(...lim.map((r) => r.d)) : Math.max(0, ...results.map((r) => r.d));
        }
        clip(R, segMark, actMark, t0 + d);
        const motion = R.segments.slice(segMark);
        for (let i = 1; i < motion.length; i++) {
          if (motion[i].t0 < motion[i - 1].t1 - 1e-6) {
            R.warnings.push(`Two paths run at once in a ${cmd.type} group (“${motion[i - 1].label}” and “${motion[i].label}”) — only the first is simulated`);
            R.segments.splice(segMark + i, 1);
            i--;
          }
        }
        return { d, limiting: results.some((r) => r.limiting) };
      }
      case 'path': {
        const name = data.pathName;
        if (!name) return { d: 0, limiting: false };
        return addPath(ctx, name, t0);
      }
      case 'wait': {
        const d = Math.max(0, U.num(data.waitTime, 0));
        R.activities.push({ t0, t1: t0 + d, kind: 'wait', label: `wait ${d}s` });
        return { d, limiting: true };
      }
      case 'named': {
        const name = data.name || 'command';
        R.named.add(name);
        const set = ctx.opts.namedDurations && ctx.opts.namedDurations[name];
        const d = Math.max(0, U.num(set, 0));
        R.activities.push({ t0, t1: t0 + d, kind: 'named', label: name });
        return { d, limiting: d > 0 };
      }
      default:
        R.warnings.push(`Unsupported command type “${cmd.type}” treated as instant`);
        return { d: 0, limiting: false };
    }
  }

  function finish(R) {
    R.segments.sort((a, b) => a.t0 - b.t0);
    R.activities.sort((a, b) => a.t0 - b.t0);
    R.events.sort((a, b) => a.t - b.t);
    const ends = [0, ...R.segments.map((s) => s.t1), ...R.activities.map((a) => a.t1)];
    R.duration = Math.max(...ends);
    if (!R.segments.length && !R.warnings.length) R.warnings.push('This routine has no driving paths');
    return R;
  }

  /**
   * @param {AC.Library} lib
   * @param {{type:string,name?:string,steps?:Array}} sel
   * @param {{namedDurations?:object}} opts
   */
  function build(lib, sel, opts) {
    const R = new Routine();
    opts = opts || {};
    if (!sel) return R;
    if (sel.type === 'auto') {
      const auto = lib.autos.get(sel.name);
      R.label = sel.name;
      if (!auto) {
        R.warnings.push(`Auto “${sel.name}” not found`);
        return R;
      }
      const ctx = makeCtx(lib, opts, R, !!auto.choreoAuto);
      // 2024 autos may specify a starting pose; use its heading for the first path.
      if (auto.startingPose && auto.startingPose.rotation != null) ctx.lastHeadingDeg = U.num(auto.startingPose.rotation, null);
      evalCmd(auto.command, 0, ctx);
      return finish(R);
    }
    if (sel.type === 'path' || sel.type === 'traj') {
      R.label = sel.name;
      const ctx = makeCtx(lib, opts, R, sel.type === 'traj');
      addPath(ctx, sel.name, 0);
      return finish(R);
    }
    if (sel.type === 'seq') {
      R.label = 'Custom chain';
      const ctx = makeCtx(lib, opts, R, false);
      let t = 0;
      for (const st of sel.steps || []) {
        if (st.kind === 'wait') {
          const d = Math.max(0, U.num(st.time, 0));
          R.activities.push({ t0: t, t1: t + d, kind: 'wait', label: st.label || `stop ${d}s` });
          t += d;
        } else {
          ctx.choreo = st.kind === 'traj';
          t += addPath(ctx, st.name, t).d;
        }
      }
      return finish(R);
    }
    return R;
  }

  AC.Routine = Routine;
  AC.buildRoutine = build;
})();
