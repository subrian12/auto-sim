/* Auto Simulator — PathPlanner .path -> time-parameterised trajectory.
 *
 * PathPlanner stores Bézier control points, not timed samples, so we generate a
 * profile: curvature-limited max speed, rotation-rate limit, constraint zones,
 * then forward/backward acceleration passes. This closely tracks the GUI's
 * preview but is an approximation of the robot-config-aware 2025+ generator.
 */
(function () {
  'use strict';
  const AC = (window.AC = window.AC || {});
  const U = AC.util;

  const DEFAULTS = { maxVelocity: 3.0, maxAcceleration: 3.0, maxAngularVelocity: 540, maxAngularAcceleration: 720 };

  function bez(p0, p1, p2, p3, u) {
    const m = 1 - u;
    const a = m * m * m;
    const b = 3 * m * m * u;
    const c = 3 * m * u * u;
    const d = u * u * u;
    return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
  }
  const pt = (o) => (o ? [U.num(o.x, 0), U.num(o.y, 0)] : null);

  function normWaypoints(path) {
    return (path.waypoints || []).map((w) => ({
      anchor: pt(w.anchor || w.anchorPoint),
      prev: pt(w.prevControl),
      next: pt(w.nextControl),
      holo: typeof w.holonomicAngle === 'number' ? w.holonomicAngle : null,
    }));
  }

  function normConstraints(c, fallback, robotMax) {
    c = c || {};
    if (c.unlimited) {
      return { vel: robotMax.vel, acc: robotMax.acc, angVel: U.rad(1440), unlimited: true };
    }
    return {
      vel: Math.max(0.05, U.num(c.maxVelocity, fallback.maxVelocity)),
      acc: Math.max(0.05, U.num(c.maxAcceleration, fallback.maxAcceleration)),
      angVel: U.rad(Math.max(1, U.num(c.maxAngularVelocity, fallback.maxAngularVelocity))),
    };
  }

  /**
   * @param {object} path parsed .path JSON
   * @param {object} opts {name, startRotDeg?, startVel?, settings?}
   */
  function generate(path, opts) {
    opts = opts || {};
    const wps = normWaypoints(path);
    if (wps.length < 2 || wps.some((w) => !w.anchor)) throw new Error('needs at least two waypoints');

    const settings = opts.settings || {};
    const defaults = {
      maxVelocity: U.num(settings.defaultMaxVel, DEFAULTS.maxVelocity),
      maxAcceleration: U.num(settings.defaultMaxAccel, DEFAULTS.maxAcceleration),
      maxAngularVelocity: U.num(settings.defaultMaxAngVel, DEFAULTS.maxAngularVelocity),
      maxAngularAcceleration: U.num(settings.defaultMaxAngAccel, DEFAULTS.maxAngularAcceleration),
    };
    const robotMax = { vel: U.num(settings.maxDriveSpeed, 5.0), acc: 12 };
    const globalRaw = path.useDefaultConstraints && opts.settings ? defaults : path.globalConstraints || defaults;
    const globalC = normConstraints(globalRaw, defaults, robotMax);
    if (path.globalConstraints && path.globalConstraints.unlimited) Object.assign(globalC, normConstraints({ unlimited: true }, defaults, robotMax));
    const zones = (path.constraintZones || []).map((z) => ({
      min: U.num(z.minWaypointRelativePos, 0),
      max: U.num(z.maxWaypointRelativePos, 0),
      c: normConstraints(z.constraints, globalRaw, robotMax),
    }));
    const constraintsAt = (pos) => {
      let c = globalC;
      for (const z of zones) if (pos >= z.min && pos <= z.max) c = z.c;
      return c;
    };

    // ---- 1. Sample the Bézier spline densely (~1 cm) -------------------------
    const nSeg = wps.length - 1;
    const P = []; // {x,y,pos}
    for (let s = 0; s < nSeg; s++) {
      const p0 = wps[s].anchor;
      const p3 = wps[s + 1].anchor;
      const p1 = wps[s].next || p0;
      const p2 = wps[s + 1].prev || p3;
      const approx = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
      const steps = Math.max(12, Math.ceil(approx / 0.01));
      for (let i = 0; i < steps; i++) {
        const u = i / steps;
        const q = bez(p0, p1, p2, p3, u);
        P.push({ x: q[0], y: q[1], pos: s + u });
      }
    }
    P.push({ x: wps[nSeg].anchor[0], y: wps[nSeg].anchor[1], pos: nSeg });
    // Drop coincident points (zero-length control handles cluster samples).
    const pts = [P[0]];
    for (let i = 1; i < P.length; i++) {
      const l = pts[pts.length - 1];
      if (Math.hypot(P[i].x - l.x, P[i].y - l.y) > 1e-5 || i === P.length - 1) pts.push(P[i]);
    }
    const n = pts.length;

    // ---- 2. Holonomic rotation along the path ---------------------------------
    const startRotDeg = U.num(
      opts.startRotDeg,
      U.num(
        path.idealStartingState && path.idealStartingState.rotation,
        U.num(path.previewStartingState && path.previewStartingState.rotation, wps[0].holo != null ? wps[0].holo : 0)
      )
    );
    const endRotDeg = U.num(path.goalEndState && path.goalEndState.rotation, wps[nSeg].holo != null ? wps[nSeg].holo : startRotDeg);
    const keys = [{ pos: 0, rot: U.rad(startRotDeg) }];
    const targets = [];
    for (const rt of path.rotationTargets || []) {
      const deg = U.num(rt.rotationDegrees, U.num(rt.rotation, null));
      const pos = U.num(rt.waypointRelativePos, null);
      if (deg != null && pos != null && pos > 0 && pos < nSeg) targets.push({ pos, rot: U.rad(deg) });
    }
    wps.forEach((w, i) => {
      if (w.holo != null && i > 0 && i < nSeg) targets.push({ pos: i, rot: U.rad(w.holo) });
    });
    targets.sort((a, b) => a.pos - b.pos);
    keys.push(...targets, { pos: nSeg, rot: U.rad(endRotDeg) });
    // Unwrap so interpolation always takes the shortest way between keys.
    for (let k = 1; k < keys.length; k++) keys[k].rot = keys[k - 1].rot + U.wrapAngle(keys[k].rot - keys[k - 1].rot);

    const pointZones = (path.pointTowardsZones || []).map((z) => ({
      min: U.num(z.minWaypointRelativePos, 0),
      max: U.num(z.maxWaypointRelativePos, 0),
      fx: U.num(z.fieldPosition && z.fieldPosition.x, 0),
      fy: U.num(z.fieldPosition && z.fieldPosition.y, 0),
      off: U.rad(U.num(z.rotationOffset, 0)),
    }));

    let k = 0;
    for (const p of pts) {
      while (k < keys.length - 2 && p.pos > keys[k + 1].pos) k++;
      const a = keys[k];
      const b = keys[k + 1];
      const f = b.pos > a.pos ? U.clamp((p.pos - a.pos) / (b.pos - a.pos), 0, 1) : 1;
      p.h = U.lerp(a.rot, b.rot, f);
      for (const z of pointZones) {
        if (p.pos >= z.min && p.pos <= z.max) p.h = Math.atan2(z.fy - p.y, z.fx - p.x) + z.off;
      }
    }
    for (let i = 1; i < n; i++) pts[i].h = pts[i - 1].h + U.wrapAngle(pts[i].h - pts[i - 1].h);

    // ---- 3. Velocity limits ---------------------------------------------------
    const ds = new Float64Array(n);
    for (let i = 1; i < n; i++) ds[i] = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const vmax = new Float64Array(n);
    const acc = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = constraintsAt(pts[i].pos);
      acc[i] = c.acc;
      let v = c.vel;
      // Curvature from points two either side (Menger curvature) — less noisy than adjacent.
      const ia = Math.max(0, i - 2);
      const ib = Math.min(n - 1, i + 2);
      if (ia < i && ib > i) {
        const A = pts[ia];
        const B = pts[i];
        const C = pts[ib];
        const a = Math.hypot(B.x - A.x, B.y - A.y);
        const b = Math.hypot(C.x - B.x, C.y - B.y);
        const cc = Math.hypot(C.x - A.x, C.y - A.y);
        const area2 = Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x));
        const denom = a * b * cc;
        if (denom > 1e-12) {
          const curv = (2 * area2) / denom;
          if (curv > 1e-6) v = Math.min(v, Math.sqrt(c.acc / curv));
        }
      }
      vmax[i] = v;
    }
    // Rotation-rate limit: the heading is tied to position, so turning fast forces slowing down.
    for (let i = 1; i < n; i++) {
      const dh = Math.abs(pts[i].h - pts[i - 1].h);
      if (dh > 1e-9) {
        const c = constraintsAt(pts[i].pos);
        const lim = (ds[i] * c.angVel) / dh;
        vmax[i] = Math.min(vmax[i], lim);
        vmax[i - 1] = Math.min(vmax[i - 1], lim);
      }
    }

    const startVel = U.num(opts.startVel, U.num(path.idealStartingState && path.idealStartingState.velocity, U.num(path.previewStartingState && path.previewStartingState.velocity, 0)));
    const endVel = U.num(path.goalEndState && path.goalEndState.velocity, 0);
    const v = new Float64Array(n);
    v[0] = Math.min(startVel, vmax[0]);
    for (let i = 1; i < n; i++) v[i] = Math.min(vmax[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * acc[i - 1] * ds[i]));
    v[n - 1] = Math.min(v[n - 1], endVel);
    for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * acc[i] * ds[i + 1]));

    // ---- 4. Integrate time ----------------------------------------------------
    const samples = new Array(n);
    let t = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const vs = v[i] + v[i - 1];
        t += vs > 1e-6 ? (2 * ds[i]) / vs : Math.sqrt((2 * ds[i]) / acc[i]);
      }
      samples[i] = { t, x: pts[i].x, y: pts[i].y, h: pts[i].h, pos: pts[i].pos, vx: 0, vy: 0, w: 0 };
    }
    for (let i = 0; i < n; i++) {
      const a = samples[Math.max(0, i - 1)];
      const b = samples[Math.min(n - 1, i + 1)];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 1e-9) {
        samples[i].vx = ((b.x - a.x) / len) * v[i];
        samples[i].vy = ((b.y - a.y) / len) * v[i];
      }
      const dt = b.t - a.t;
      samples[i].w = dt > 1e-9 ? (b.h - a.h) / dt : 0;
    }

    // ---- 5. Event markers -> times -------------------------------------------
    const posToTime = (pos) => {
      let lo = 0;
      let hi = n - 1;
      if (pos <= samples[0].pos) return 0;
      if (pos >= samples[hi].pos) return samples[hi].t;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].pos <= pos) lo = mid;
        else hi = mid;
      }
      const a = samples[lo];
      const b = samples[hi];
      return U.lerp(a.t, b.t, (pos - a.pos) / (b.pos - a.pos || 1));
    };
    const events = [];
    for (const m of path.eventMarkers || []) {
      const pos = U.num(m.waypointRelativePos, null);
      if (pos == null) continue;
      let name = m.name || '';
      const cmd = m.command;
      if (cmd && cmd.data && cmd.data.name) name = cmd.data.name;
      events.push({ t: posToTime(pos), name: name || 'marker' });
    }

    return new AC.Trajectory(opts.name || 'path', samples, { source: 'pathplanner', events, endVel, approximate: true });
  }

  AC.ppgen = { generate };
})();
