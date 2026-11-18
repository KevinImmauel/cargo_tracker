/* ============================================================================
 *  Demo simulator: produces EXACTLY the same JSON lines as the ESP32 firmware
 *  Scenario: Road truck from MS Palya, Bengaluru → Presidency University
 *  Simulates road bumps, potholes, speed bumps, and truck turns.
 * ==========================================================================*/
(function () {
  const ROUTE = [
    [12.9516, 77.6412],  // MS Palya, Bengaluru (origin)
    [12.9700, 77.6300],  // Near Manyata Tech Park area
    [12.9950, 77.6150],  // Toward Hebbal
    [13.0350, 77.5950],  // Near Kogilu Cross
    [13.0750, 77.5880],  // Yelahanka direction
    [13.1000, 77.5890],  // Near Jakkur
    [13.1206, 77.5940],  // Presidency University (destination)
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
      this.lastPothole = 0;
      this.lastSpeedBump = 0;
      this.seg = 0; this.segT = 0;
    }

    start(onLine) {
      this.onLine = onLine;
      this.t0 = performance.now();
      this.emit({ t: "log", msg: "DEMO MODE: simulated ESP32 truck (no hardware) — MS Palya → Presidency University" });
      this.sendCfg();
      this.timer = setInterval(() => this.tick(), 50);
    }

    stop() { clearInterval(this.timer); this.timer = null; }

    emit(obj) { if (this.onLine) this.onLine(JSON.stringify(obj)); }

    sendCfg() {
      this.emit({ t: "cfg", id: "SHIP-IND-07", thr: this.thr, shock: this.shockThr, mpu: 1, fs: 1, tsrc: "gps" });
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
      this.segT += 0.00028 / d;
      if (this.segT >= 1) { this.segT = 0; this.seg++; if (this.seg >= ROUTE.length - 1) this.seg = 0; }
    }

    bump(t, c, w) { return Math.exp(-Math.pow((t - c) / w, 2)); }

    tick() {
      const t = (performance.now() - this.t0) / 1000, now = performance.now();
      const n = () => (Math.random() - 0.5);

      // Normal road vibration: gentle roll/pitch from road surface
      let roll  = 1.5 * Math.sin(2 * Math.PI * t / 4.1) + 0.8 * Math.sin(2 * Math.PI * t / 1.7 + 0.9) + n() * 0.3;
      let pitch = 1.2 * Math.sin(2 * Math.PI * t / 5.8 + 0.4) + 0.5 * Math.sin(2 * Math.PI * t / 2.1) + n() * 0.25;
      // Slow yaw as truck turns at intersections
      let yaw   = 3.5 * Math.sin(2 * Math.PI * t / 55) + 1.2 * Math.sin(2 * Math.PI * t / 23 + 1.1);

      // Truck speed: ~40 km/h = ~21.6 knots (simulated as ~12 knots raw)
      const speedKmh = 40 + 8 * Math.sin(t / 20) + n() * 3;
      const speedKnots = speedKmh / 1.852;

      // G-force baseline from road vibration
      let g = 1.0 + n() * 0.04 + 0.02 * Math.abs(Math.sin(2 * Math.PI * t / 1.3));

      // --- Pothole: sharp spike every ~8 seconds ---
      const potholeInterval = 8;
      const pk = Math.round((t - 3) / potholeInterval);
      if (pk >= 0) {
        const centre = 3 + pk * potholeInterval;
        const b = this.bump(t, centre, 0.09);
        if (b > 0.01) {
          const side = (pk % 2 ? -1 : 1);
          roll  += side * (8 + Math.random() * 4) * b;
          pitch += (4 + Math.random() * 3) * b;
          g     += (0.5 + Math.random() * 1.0) * b;
        }
      }

      // --- Speed bump: moderate shock every ~20 seconds ---
      const sbInterval = 20;
      const sbk = Math.round((t - 11) / sbInterval);
      if (sbk >= 0) {
        const sbCentre = 11 + sbk * sbInterval;
        const sb = this.bump(t, sbCentre, 0.14);
        if (sb > 0.01) {
          pitch += 6 * sb;
          g     += (0.3 + Math.random() * 0.5) * sb;
        }
      }

      this.roll  = roll  - this.rollZero;
      this.pitch = pitch - this.pitchZero;
      this.yaw   = yaw   - this.yawZero;
      const R = this.roll * Math.PI / 180, P = this.pitch * Math.PI / 180;
      const ax = Math.sin(P) * g, ay = Math.cos(P) * Math.sin(R) * g, az = Math.cos(P) * Math.cos(R) * g;
      const tiltDeg = Math.acos(Math.min(1, Math.cos(R) * Math.cos(P))) * 180 / Math.PI;

      this.advance();
      const pos = this.position();
      const epoch = Math.floor(Date.now() / 1000);

      this.detect(tiltDeg, g, epoch, now, pos);

      this.emit({
        t: "d", id: "SHIP-IND-07", ms: Math.round(t * 1000), time: iso(epoch),
        roll: +this.roll.toFixed(2), pitch: +this.pitch.toFixed(2), yaw: +this.yaw.toFixed(2), tilt: +tiltDeg.toFixed(2),
        ax: +ax.toFixed(3), ay: +ay.toFixed(3), az: +az.toFixed(3), g: +g.toFixed(3),
        gx: 0, gy: 0, gz: 0, temp: +(28.5 + Math.sin(t / 90) * 1.5).toFixed(1),
        lat: +pos.lat.toFixed(6), lng: +pos.lng.toFixed(6), fix: 1, sats: 9 + Math.round(Math.random() * 2),
        spd: +speedKnots.toFixed(2), crs: +pos.crs.toFixed(1),
        alarm: this.tilt.active ? 1 : 0, thr: this.thr, mpu: 1,
      });
    }

    detect(tiltDeg, g, epoch, now, pos) {
      const T = this.tilt;
      const mk = (type, phase, startEpoch, dur, peak, r, p, id) => {
        const e = {
          id: `SHIP-IND-07-${startEpoch}-${id}`, type, phase, time: iso(startEpoch), epoch: startEpoch, dur,
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
