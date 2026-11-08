/* Auto Sim — robot footprints and collision detection */
(function () {
  'use strict';
  const AC = (window.AC = window.AC || {});

  /** Bumper rectangle corners in field coordinates. fp = {length, width, offsetX}. */
  function footprintPoly(pose, fp) {
    const hl = fp.length / 2;
    const hw = fp.width / 2;
    const ox = fp.offsetX || 0;
    const c = Math.cos(pose.h);
    const s = Math.sin(pose.h);
    return [
      [ox + hl, hw],
      [ox - hl, hw],
      [ox - hl, -hw],
      [ox + hl, -hw],
    ].map(([lx, ly]) => [pose.x + lx * c - ly * s, pose.y + lx * s + ly * c]);
  }

  function project(poly, ax, ay) {
    let min = Infinity;
    let max = -Infinity;
    for (const p of poly) {
      const d = p[0] * ax + p[1] * ay;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return [min, max];
  }

  /** Separating-axis test for convex polygons: penetration depth (> 0), or 0 if they don't touch. */
  function overlapDepth(A, B) {
    let depth = Infinity;
    for (const poly of [A, B]) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const ax = -(q[1] - p[1]) / len;
        const ay = (q[0] - p[0]) / len;
        const a = project(A, ax, ay);
        const b = project(B, ax, ay);
        const o = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
        if (o <= 0) return 0;
        if (o < depth) depth = o;
      }
    }
    return depth;
  }

  /**
   * Step through the match every `dt` seconds and record every period where two robots overlap.
   * @param {Array} robots [{index, routine, delay, footprint}]
   * @param {object} field AC.fields entry
   */
  function analyze(robots, field, dt) {
    dt = dt || 0.01;
    const T = Math.max(field.autoTime, ...robots.map((r) => r.delay + r.routine.duration));
    const N = Math.floor(T / dt) + 1;
    const pairs = [];
    for (let a = 0; a < robots.length; a++) for (let b = a + 1; b < robots.length; b++) pairs.push({ a, b, run: null });

    const events = [];
    const close = (p, k) => {
      const r = p.run;
      const ra = robots[p.a];
      const rb = robots[p.b];
      const pa = ra.routine.poseAt(r.t0 - ra.delay);
      const pb = rb.routine.poseAt(r.t0 - rb.delay);
      events.push({
        robots: [ra.index, rb.index],
        t0: r.t0,
        t1: (k - 1) * dt,
        depth: r.depth,
        x: r.x,
        y: r.y,
        relSpeed: Math.hypot(pa.vx - pb.vx, pa.vy - pb.vy),
        moving: [pa.moving, pb.moving],
      });
      p.run = null;
    };

    for (let k = 0; k < N; k++) {
      const t = k * dt;
      const poses = robots.map((R) => R.routine.poseAt(t - R.delay));
      const polys = robots.map((R, r) => footprintPoly(poses[r], R.footprint));
      for (const p of pairs) {
        const d = overlapDepth(polys[p.a], polys[p.b]);
        if (d > 0) {
          if (!p.run) p.run = { t0: t, depth: 0 };
          if (d > p.run.depth) {
            p.run.depth = d;
            p.run.x = (poses[p.a].x + poses[p.b].x) / 2;
            p.run.y = (poses[p.a].y + poses[p.b].y) / 2;
          }
        } else if (p.run) close(p, k);
      }
    }
    for (const p of pairs) if (p.run) close(p, N);

    events.sort((x, y) => x.t0 - y.t0);
    events.forEach((e, i) => (e.num = i + 1));
    return { T, events };
  }

  AC.geom = { footprintPoly };
  AC.collide = { analyze };
})();
