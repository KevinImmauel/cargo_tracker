/* ============================================================================
 *  Demo simulator: produces EXACTLY the same JSON lines as the ESP32 firmware
 *  so the dashboard pipeline is identical with or without hardware.
 *  Scenario: container on a vessel leaving Singapore through the Strait of
 *  Malacca, normal sea-state rolling, plus periodic heavy-roll and shock events.
 * ==========================================================================*/
(function () {
  const ROUTE = [
    [1.2640, 103.8400], [1.2050, 103.5500], [1.6000, 102.9000], [2.3500, 101.6500],
    [3.1000, 100.7000], [4.1000, 99.7500], [5.3000, 98.6000], [5.9500, 97.3000], [6.2000, 95.2000],
  ];

  class Simulator {
    constructor() {
      this.timer = null;
      this.onLine = null;
      this.thr = 30; this.shockThr = 2.0;
      this.rollZero = 0; this.pitchZero = 0; this.yawZero = 0;
      this.events = [];
      this.counter = 0;
      this.tilt = { active: false, aboveSince: 0, start: 0, startEpoch: 0, peak: 0, pr: 0, pp: 0 };
      this.lastShock = 0;
      this.seg = 0; this.segT = 0;
    }

    start(onLine) {
      this.onLine = onLine;
      this.t0 = performance.now();
      this.emit({ t: "log", msg: "DEMO MODE: simulated ESP32 (no hardware)" });
      this.sendCfg();
      this.timer = setInterval(() => this.tick(), 50);
    }

    stop() { clearInterval(this.timer); this.timer = null; }

    emit(obj) { if (this.onLine) this.onLine(JSON.stringify(obj)); }

    sendCfg() {
      this.emit({ t: "cfg", id: "CONT-001", thr: this.thr, shock: this.shockThr, mpu: 1, fs: 1, tsrc: "gps" });
    }

    send(line) {
      let c; try { c = JSON.parse(line); } catch { return; }
      switch (c.cmd) {
        case "threshold": if (c.value >= 1 && c.value <= 90) this.thr = c.value; this.sendCfg(); break;
        case "shock": if (c.value >= 1.1 && c.value <= 8) this.shockThr = c.value; this.sendCfg(); break;
        case "level": this.rollZero += this.roll; this.pitchZero += this.pitch; this.emit({ t: "log", msg: "Level reference set" }); break;
        case "resetYaw": this.yawZero += this.yaw; break;
        case "dump":
          this.events.forEach((e) => this.emit(Object.assign({ t: "e", hist: 1 }, e)));
          this.emit({ t: "log", msg: `Sent ${this.events.length} stored events` });
          break;
        case "clear": this.events = []; this.emit({ t: "log", msg: "Event log cleared" }); break;
        case "hello": this.sendCfg(); break;
      }
    }

    position() {
      const a = ROUTE[this.seg], b = ROUTE[Math.min(this.seg + 1, ROUTE.length - 1)];
      const lat = a[0] + (b[0] - a[0]) * this.segT, lng = a[1] + (b[1] - a[1]) * this.segT;
      const crs = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI + 360) % 360;
      return { lat, lng, crs };
    }

    advance() {
      const a = ROUTE[this.seg], b = ROUTE[this.seg + 1];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      this.segT += 0.00035 / d; // time-lapse speed so the track visibly moves
      if (this.segT >= 1) { this.segT = 0; this.seg++; if (this.seg >= ROUTE.length - 1) this.seg = 0; }
    }

    // bell-shaped bump centred at c, width w
    bump(t, c, w) { return Math.exp(-Math.pow((t - c) / w, 2)); }

    tick() {
      const t = (performance.now() - this.t0) / 1000, now = performance.now();
      const n = () => (Math.random() - 0.5);

      // normal sea state
      let roll = 7 * Math.sin(2 * Math.PI * t / 8.5) + 2.5 * Math.sin(2 * Math.PI * t / 3.1 + 1) + n() * 0.4;
      let pitch = 3 * Math.sin(2 * Math.PI * t / 6.2 + 0.5) + 1 * Math.sin(2 * Math.PI * t / 2.3) + n() * 0.3;
      let yaw = 4 * Math.sin(2 * Math.PI * t / 40);

      // heavy-roll episode every 22 s (first at 8 s), alternates side & adds pitch
      const cyc = 22, k = Math.floor((t - 8 + cyc / 2) / cyc), centre = 8 + k * cyc;
      if (k >= 0) {
        const s = k % 2 ? -1 : 1, b = this.bump(t, centre, 1.4);
        roll += s * 36 * b;
        pitch += (k % 3 === 2 ? 22 : 6) * b;
      }

      // shock every 31 s (first at 15 s)
      let g = 1 + n() * 0.03;
      const sk = Math.round((t - 15) / 31);
      if (sk >= 0 && Math.abs(t - (15 + sk * 31)) < 0.03) { g = 2.6 + Math.random() * 0.8; roll += n() * 6; }

      this.roll = roll - this.rollZero;
      this.pitch = pitch - this.pitchZero;
      this.yaw = yaw - this.yawZero;
      const R = this.roll * Math.PI / 180, P = this.pitch * Math.PI / 180;
      const ax = Math.sin(P) * g, ay = Math.cos(P) * Math.sin(R) * g, az = Math.cos(P) * Math.cos(R) * g;
      const tiltDeg = Math.acos(Math.min(1, Math.cos(R) * Math.cos(P))) * 180 / Math.PI;

      this.advance();
      const pos = this.position();
      const epoch = Math.floor(Date.now() / 1000);

      this.detect(tiltDeg, g, epoch, now, pos);

      this.emit({
        t: "d", id: "CONT-001", ms: Math.round(t * 1000), time: iso(epoch),
        roll: +this.roll.toFixed(2), pitch: +this.pitch.toFixed(2), yaw: +this.yaw.toFixed(2), tilt: +tiltDeg.toFixed(2),
        ax: +ax.toFixed(3), ay: +ay.toFixed(3), az: +az.toFixed(3), g: +g.toFixed(3),
        gx: 0, gy: 0, gz: 0, temp: +(27.4 + Math.sin(t / 60)).toFixed(1),
        lat: +pos.lat.toFixed(6), lng: +pos.lng.toFixed(6), fix: 1, sats: 9, spd: 17.8, crs: +pos.crs.toFixed(1),
        alarm: this.tilt.active ? 1 : 0, thr: this.thr, mpu: 1,
      });
    }

    detect(tiltDeg, g, epoch, now, pos) {
      const T = this.tilt;
      const mk = (type, phase, startEpoch, dur, peak, r, p, id) => {
        const e = {
          id: `CONT-001-${startEpoch}-${id}`, type, phase, time: iso(startEpoch), epoch: startEpoch, dur,
          peak: +peak.toFixed(1), roll: +r.toFixed(1), pitch: +p.toFixed(1),
          thr: type === "SHOCK" ? this.shockThr : this.thr,
          lat: +pos.lat.toFixed(6), lng: +pos.lng.toFixed(6), fix: 1, tsrc: "gps",
        };
        this.events.push(e);
        this.emit(Object.assign({ t: "e" }, e));
      };
      if (!T.active) {
        if (tiltDeg > this.thr) {
          if (!T.aboveSince) T.aboveSince = now;
          if (now - T.aboveSince >= 250) {
            Object.assign(T, { active: true, start: T.aboveSince, startEpoch: epoch, peak: tiltDeg, pr: this.roll, pp: this.pitch });
            this.counter++;
            mk("TILT", "start", epoch, 0, tiltDeg, this.roll, this.pitch, this.counter);
          }
        } else T.aboveSince = 0;
      } else {
        if (tiltDeg > T.peak) Object.assign(T, { peak: tiltDeg, pr: this.roll, pp: this.pitch });
        if (tiltDeg < this.thr - 3) {
          T.active = false; T.aboveSince = 0;
          mk("TILT", "end", T.startEpoch, Math.round(now - T.start), T.peak, T.pr, T.pp, this.counter);
        }
      }
      if (g > this.shockThr && now - this.lastShock > 1000) {
        this.lastShock = now; this.counter++;
        mk("SHOCK", "instant", epoch, 0, g, this.roll, this.pitch, this.counter);
      }
    }
  }

  function iso(epoch) { return new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, "Z"); }

  window.Simulator = Simulator;
})();
