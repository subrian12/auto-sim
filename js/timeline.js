/* Auto Sim — timeline: one lane per robot plus a collision lane. Click or drag to scrub. */
(function () {
  'use strict';
  const AC = (window.AC = window.AC || {});
  const U = AC.util;
  const FONT = 'Inter, system-ui, sans-serif';

  class Timeline {
    constructor(canvas, onSeek) {
      this.canvas = canvas;
      this.padL = 60;
      this.padR = 14;
      this.T = 15;
      let down = false;
      const seek = (e) => {
        const r = canvas.getBoundingClientRect();
        onSeek(U.clamp(((e.clientX - r.left - this.padL) / (this.w - this.padL - this.padR)) * this.T, 0, this.T));
      };
      canvas.addEventListener('pointerdown', (e) => {
        down = true;
        canvas.setPointerCapture(e.pointerId);
        seek(e);
      });
      canvas.addEventListener('pointermove', (e) => down && seek(e));
      canvas.addEventListener('pointerup', () => (down = false));
      new ResizeObserver(() => this.requestDraw && this.requestDraw()).observe(canvas.parentElement);
    }

    tx(t) {
      return this.padL + (t / this.T) * (this.w - this.padL - this.padR);
    }

    /** S = {field, robots, time, events, T} */
    draw(S) {
      const c = this.canvas;
      const box = c.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = (this.w = Math.max(50, box.width));
      const h = Math.max(30, box.height);
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      this.T = Math.max(1, S.T);

      const rulerH = 18;
      const laneH = 20;
      // Ruler, one tick per second
      ctx.font = `10px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      for (let t = 0; t <= this.T + 1e-6; t++) {
        const x = this.tx(t);
        ctx.strokeStyle = 'rgba(168,161,158,0.12)';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, rulerH);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
        if (this.T <= 25 || t % 2 === 0) {
          ctx.fillStyle = '#77706d';
          ctx.fillText(t + 's', x, 9);
        }
      }
      // End of the autonomous period
      const xa = this.tx(S.field.autoTime);
      ctx.strokeStyle = 'rgba(255,138,128,0.6)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xa + 0.5, rulerH - 4);
      ctx.lineTo(xa + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Lanes
      ctx.textAlign = 'left';
      ctx.font = `600 10px ${FONT}`;
      ctx.fillStyle = '#a8a19e';
      ctx.fillText('Hits', 8, rulerH + laneH / 2);
      for (const ev of S.events) {
        const x0 = this.tx(ev.t0);
        ctx.fillStyle = '#ff4538';
        AC.roundRect(ctx, x0, rulerH + 4, Math.max(3, this.tx(ev.t1) - x0), laneH - 8, 2);
        ctx.fill();
      }
      S.robots.forEach((R, li) => {
        const y = rulerH + laneH * (li + 1) + 4;
        ctx.font = `600 11px ${FONT}`;
        ctx.fillStyle = R.color;
        ctx.fillText(R.team || `R${R.index + 1}`, 8, y + laneH / 2);
        ctx.fillStyle = 'rgba(168,161,158,0.06)';
        ctx.fillRect(this.padL, y + 2, w - this.padL - this.padR, laneH - 4);
        for (const a of R.routine.activities) {
          const x0 = this.tx(R.delay + a.t0);
          const x1 = Math.max(x0 + 2, this.tx(R.delay + a.t1));
          if (a.kind !== 'path') {
            // Stopped (shooting, intaking, waiting): outlined block
            if (a.t1 - a.t0 > 0) {
              ctx.strokeStyle = AC.hexA(R.color, 0.7);
              ctx.lineWidth = 1;
              AC.roundRect(ctx, x0 + 0.5, y + 4.5, x1 - x0 - 1, laneH - 9, 3);
              ctx.stroke();
            }
            continue;
          }
          ctx.fillStyle = AC.hexA(R.color, 0.75);
          AC.roundRect(ctx, x0, y + 3, x1 - x0, laneH - 6, 3);
          ctx.fill();
          if (x1 - x0 > 40) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x0, y, x1 - x0 - 3, laneH);
            ctx.clip();
            ctx.fillStyle = '#0d0c0c';
            ctx.font = `600 10px ${FONT}`;
            ctx.fillText(a.label, x0 + 5, y + laneH / 2 + 0.5);
            ctx.restore();
          }
        }
      });

      // Playhead
      const xp = this.tx(S.time);
      ctx.strokeStyle = '#f5f2f0';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xp, 4);
      ctx.lineTo(xp, h);
      ctx.stroke();
    }
  }

  AC.Timeline = Timeline;
})();
