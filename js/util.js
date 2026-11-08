/* Auto Simulator — shared math + formatting helpers */
(function () {
  'use strict';
  const AC = (window.AC = window.AC || {});
  const U = (AC.util = {});

  U.M_PER_IN = 0.0254;
  U.TAU = Math.PI * 2;

  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.deg = (r) => (r * 180) / Math.PI;
  U.rad = (d) => (d * Math.PI) / 180;

  /** Wrap an angle into (-PI, PI]. */
  U.wrapAngle = (a) => {
    a = (a + Math.PI) % U.TAU;
    if (a < 0) a += U.TAU;
    return a - Math.PI;
  };
  U.lerpAngle = (a, b, t) => a + U.wrapAngle(b - a) * t;

  U.num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);

  /** Choreo stores some values as {exp, val}; PathPlanner as plain numbers. */
  U.val = (v, fallback) => {
    if (v && typeof v === 'object' && 'val' in v) return U.num(v.val, fallback);
    return U.num(v, fallback);
  };

  U.baseName = (path) => {
    const file = String(path).split(/[\\/]/).pop();
    const dot = file.lastIndexOf('.');
    return dot > 0 ? file.slice(0, dot) : file;
  };
  U.fileName = (path) => String(path).split(/[\\/]/).pop();
  U.ext = (path) => {
    const file = U.fileName(path).toLowerCase();
    const dot = file.lastIndexOf('.');
    return dot >= 0 ? file.slice(dot) : '';
  };

  U.escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  U.debounce = (fn, ms) => {
    let h = 0;
    return (...args) => {
      clearTimeout(h);
      h = setTimeout(() => fn(...args), ms);
    };
  };

  /** Display units: 'in' or 'm'. Set by the app. */
  U.units = 'in';

  U.fmtLen = (m, digits) => {
    if (U.units === 'in') return (m / U.M_PER_IN).toFixed(digits == null ? 1 : digits) + ' in';
    return m.toFixed(digits == null ? 2 : digits) + ' m';
  };
  U.toDisplayLen = (m) => (U.units === 'in' ? m / U.M_PER_IN : m);
  U.fromDisplayLen = (v) => (U.units === 'in' ? v * U.M_PER_IN : v);
  U.lenUnit = () => (U.units === 'in' ? 'in' : 'm');

  U.fmtTime = (t) => (Math.round(t * 100) / 100).toFixed(2) + ' s';

  /** Binary search: largest index i with arr[i].t <= t (arr sorted by t). */
  U.searchT = (arr, t) => {
    let lo = 0;
    let hi = arr.length - 1;
    if (t <= arr[0].t) return 0;
    if (t >= arr[hi].t) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  /**
   * A time-parameterised pose trajectory. Samples: {t,x,y,h,vx,vy,w,pos?}
   * Times are normalised so the first sample is t = 0.
   */
  class Trajectory {
    constructor(name, samples, meta) {
      this.name = name;
      const t0 = samples.length ? samples[0].t : 0;
      this.samples = samples.map((s) => ({
        t: s.t - t0,
        x: s.x,
        y: s.y,
        h: s.h,
        vx: s.vx || 0,
        vy: s.vy || 0,
        w: s.w || 0,
        pos: s.pos,
      }));
      this.duration = this.samples.length ? this.samples[this.samples.length - 1].t : 0;
      this.meta = meta || {};
      this.events = (this.meta.events || []).map((e) => ({ t: e.t - t0, name: e.name }));
    }

    sample(t) {
      const S = this.samples;
      if (S.length === 1) return { ...S[0] };
      const i = U.searchT(S, t);
      const a = S[i];
      const b = S[Math.min(i + 1, S.length - 1)];
      if (a === b || b.t <= a.t) return { ...a };
      const f = U.clamp((t - a.t) / (b.t - a.t), 0, 1);
      return {
        t,
        x: U.lerp(a.x, b.x, f),
        y: U.lerp(a.y, b.y, f),
        h: U.lerpAngle(a.h, b.h, f),
        vx: U.lerp(a.vx, b.vx, f),
        vy: U.lerp(a.vy, b.vy, f),
        w: U.lerp(a.w, b.w, f),
      };
    }

    /** New trajectory covering sample indices [i0, i1] inclusive. */
    sliceIndices(name, i0, i1) {
      const S = this.samples.slice(i0, i1 + 1);
      const tStart = S.length ? S[0].t : 0;
      const tEnd = S.length ? S[S.length - 1].t : 0;
      const events = this.events.filter((e) => e.t >= tStart - 1e-9 && e.t <= tEnd + 1e-9);
      return new Trajectory(name, S, { ...this.meta, events });
    }

    get start() {
      return this.samples[0];
    }
    get end() {
      return this.samples[this.samples.length - 1];
    }
  }
  AC.Trajectory = Trajectory;
})();
