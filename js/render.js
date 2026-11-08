/* Auto Sim — field canvas */
(function () {
  'use strict';
  const AC = (window.AC = window.AC || {});
  const U = AC.util;

  AC.ROBOT_COLORS = ['#6aa3d4', '#d9b25f', '#c9c3bf'];
  const BUMPER = '#1d4ed8';
  const HIT = '#ff4538';

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  AC.hexA = hexA;
  AC.roundRect = roundRect;


  class FieldView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.markers = [];
      this.onPick = null;
      canvas.addEventListener('click', (e) => {
        const r = canvas.getBoundingClientRect();
        const hit = this.markerAt(e.clientX - r.left, e.clientY - r.top);
        if (hit && this.onPick) this.onPick(hit.event);
      });
      canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        canvas.style.cursor = this.markerAt(e.clientX - r.left, e.clientY - r.top) ? 'pointer' : 'default';
      });
      new ResizeObserver(() => this.requestDraw && this.requestDraw()).observe(canvas.parentElement);
    }

    markerAt(px, py) {
      return this.markers.find((m) => Math.hypot(px - m.x, py - m.y) <= m.r);
    }

    /**
     * Field image, loaded once per season. Images drawn from the red side are rotated
     * 180 degrees to match blue-origin path coordinates.
     */
    image(field) {
      this.images = this.images || {};
      const cached = this.images[field.id];
      if (cached) return cached.ready ? cached : null;
      const entry = (this.images[field.id] = { ready: false });
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext('2d');
        const p = field.px;
        let px = p;
        if (field.redSide) {
          g.translate(c.width, c.height);
          g.rotate(Math.PI);
          px = { left: c.width - p.right, right: c.width - p.left, top: c.height - p.bottom, bottom: c.height - p.top };
        }
        g.drawImage(img, 0, 0);
        Object.assign(entry, { ready: true, canvas: c, w: c.width, h: c.height, px });
        this.requestDraw && this.requestDraw();
      };
      img.src = field.image;
      return null;
    }

    setup(field) {
      const box = this.canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = Math.max(100, box.width);
      this.h = Math.max(100, box.height);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.field = field;
      // Fit the whole image (field plus the border around it) into the canvas.
      const img = this.image(field);
      const p = img ? img.px : field.px;
      const ppm = (p.right - p.left) / field.length; // image pixels per metre
      const pad = img ? { l: p.left / ppm, r: (img.w - p.right) / ppm, t: p.top / ppm, b: (img.h - p.bottom) / ppm } : { l: 0.4, r: 0.4, t: 0.4, b: 0.4 };
      const m = 12;
      this.scale = Math.min((this.w - 2 * m) / (field.length + pad.l + pad.r), (this.h - 2 * m) / (field.width + pad.t + pad.b));
      this.ox = (this.w - (field.length + pad.l + pad.r) * this.scale) / 2 + pad.l * this.scale;
      this.oy = (this.h - (field.width + pad.t + pad.b) * this.scale) / 2 + pad.t * this.scale;
      this.img = img;
      this.ppm = ppm;
    }

    sx(x) {
      return this.ox + x * this.scale;
    }
    sy(y) {
      return this.oy + (this.field.width - y) * this.scale;
    }

    /** S = {field, robots:[{index,color,team,routine,delay,footprint}], time, events} */
    draw(S) {
      this.bumper = S.alliance === 'red' ? '#c8102e' : BUMPER;
      const ctx = this.ctx;
      this.setup(S.field);
      ctx.clearRect(0, 0, this.w, this.h);
      this.drawField(S.field);

      // Routes: faint full route, bright travelled part, dashed start position
      for (const R of S.robots) {
        const tp = R.routine.timedPolyline();
        const tl = S.time - R.delay;
        ctx.lineJoin = ctx.lineCap = 'round';
        ctx.strokeStyle = hexA(R.color, 0.55);
        ctx.lineWidth = 2;
        this.polyline(tp);
        const done = tp.filter((p) => p.t <= tl);
        if (tl > 0) done.push(R.routine.poseAt(tl));
        ctx.strokeStyle = hexA(R.color, 0.95);
        ctx.lineWidth = 3;
        this.polyline(done);
        this.drawRobot(R, R.routine.poseAt(-1), { ghost: true });
      }

      // Collision markers stay on the field so every problem spot is visible at once
      this.markers = [];
      const hitting = new Set();
      for (const ev of S.events) {
        const active = S.time >= ev.t0 && S.time <= ev.t1 + 0.01;
        if (active) ev.robots.forEach((r) => hitting.add(r));
        const X = this.sx(ev.x);
        const Y = this.sy(ev.y);
        if (active) {
          ctx.strokeStyle = HIT;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(X, Y, 15, 0, U.TAU);
          ctx.stroke();
        }
        ctx.fillStyle = HIT;
        ctx.strokeStyle = '#0d0c0c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(X, Y, 9, 0, U.TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#0d0c0c';
        ctx.font = "600 10px 'JetBrains Mono', ui-monospace, monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(ev.num), X, Y + 0.5);
        this.markers.push({ x: X, y: Y, r: 13, event: ev });
      }

      this.tags = [];
      for (const R of S.robots) this.drawRobot(R, R.routine.poseAt(S.time - R.delay), { hit: hitting.has(R.index) });
      this.drawTags();
    }

    drawField(f) {
      const ctx = this.ctx;
      if (this.img) {
        const k = this.scale / this.ppm; // screen pixels per image pixel
        const im = this.img;
        ctx.drawImage(im.canvas, this.ox - im.px.left * k, this.oy - im.px.top * k, im.w * k, im.h * k);
      } else {
        ctx.fillStyle = '#2b2d30';
        ctx.fillRect(this.sx(0), this.sy(f.width), f.length * this.scale, f.width * this.scale);
      }
    }

    polyline(pts) {
      if (pts.length < 2) return;
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(this.sx(pts[0].x), this.sy(pts[0].y));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(this.sx(pts[i].x), this.sy(pts[i].y));
      ctx.stroke();
    }

    drawRobot(R, pose, o) {
      const ctx = this.ctx;
      const s = this.scale;
      const L = R.footprint.length * s;
      const W = R.footprint.width * s;
      const ox = (R.footprint.offsetX || 0) * s;
      ctx.save();
      ctx.translate(this.sx(pose.x), this.sy(pose.y));
      ctx.rotate(-pose.h);
      if (o.ghost) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = hexA(R.color, 0.55);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ox - L / 2, -W / 2, L, W);
        ctx.restore();
        return;
      }
      const bump = Math.max(2.5, Math.min(0.09 * s, L * 0.16));
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = this.bumper || BUMPER;
      roundRect(ctx, ox - L / 2, -W / 2, L, W, 4);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.fillStyle = '#211e1e';
      roundRect(ctx, ox - L / 2 + bump, -W / 2 + bump, L - 2 * bump, W - 2 * bump, 2);
      ctx.fill();
      ctx.strokeStyle = o.hit ? HIT : R.color;
      ctx.lineWidth = o.hit ? 3 : 2;
      roundRect(ctx, ox - L / 2, -W / 2, L, W, 4);
      ctx.stroke();
      // Heading arrow points the way the robot faces
      const tip = ox + L / 2 - bump - 2;
      const back = tip - Math.min(L, W) * 0.42;
      ctx.fillStyle = R.color;
      ctx.beginPath();
      ctx.moveTo(tip, 0);
      ctx.lineTo(back, -W * 0.22);
      ctx.lineTo(back + Math.min(L, W) * 0.1, 0);
      ctx.lineTo(back, W * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // Team label: an upright tag just above the robot, so it never covers the heading arrow
      ctx.save();
      const label = R.team || `R${R.index + 1}`;
      ctx.font = "600 11px Inter, system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      const c = Math.abs(Math.cos(pose.h));
      const sn = Math.abs(Math.sin(pose.h));
      const halfH = (L * sn + W * c) / 2; // half height of the rotated robot on screen
      const cx = this.sx(pose.x);
      const bh = 17;
      const bw = tw + 14;
      let by = this.sy(pose.y) - halfH - 5 - bh;
      if (by < 2) by = this.sy(pose.y) + halfH + 5; // flip below near the top edge
      this.tags.push({ R, label, x: cx - bw / 2, y: by, w: bw, h: bh, hit: o.hit, up: by < this.sy(pose.y) });
      ctx.restore();
    }
  }

  /** Team tags are drawn last, nudged apart so they never sit on top of each other. */
  FieldView.prototype.drawTags = function () {
    const ctx = this.ctx;
    const placed = [];
    for (const t of this.tags) {
      for (let k = 0; k < 6; k++) {
        const hitBox = placed.find((q) => t.x < q.x + q.w + 2 && q.x < t.x + t.w + 2 && t.y < q.y + q.h + 2 && q.y < t.y + t.h + 2);
        if (!hitBox) break;
        t.y = t.up ? hitBox.y - t.h - 3 : hitBox.y + hitBox.h + 3;
      }
      placed.push(t);
      ctx.save();
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(14,15,17,0.92)';
      roundRect(ctx, t.x, t.y, t.w, t.h, 3);
      ctx.fill();
      ctx.strokeStyle = t.hit ? HIT : hexA(t.R.color, 0.9);
      ctx.lineWidth = 1;
      roundRect(ctx, t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1, 3);
      ctx.stroke();
      ctx.fillStyle = t.R.color;
      ctx.fillRect(t.x + 1, t.y + 1, 3, t.h - 2);
      ctx.fillStyle = '#eef0f2';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.label, t.x + t.w / 2 + 1.5, t.y + t.h / 2 + 0.5);
      ctx.restore();
    }
  };

  AC.FieldView = FieldView;
})();
