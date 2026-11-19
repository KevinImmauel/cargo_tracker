/* ============================================================================
 *  Demo simulator: produces EXACTLY the same JSON lines as the ESP32 firmware
 *  Scenario: Container vessel from Port of Shanghai → Port of Los Angeles
 *  Simulates ocean swells, wave roll/pitch, wave slams, and transpacific navigation.
 * ==========================================================================*/
(function () {
  // Transpacific maritime shipping lane: Port of Shanghai → Port of Los Angeles
  const ROUTE = [
    [31.2304, 121.4737],  // Port of Shanghai (dispatch)
    [31.1000, 123.5000],  // Yangtze Estuary / East China Sea
    [30.4000, 129.8000],  // Tokara Strait (south of Kyushu)
    [33.2000, 138.5000],  // South of Honshu (entering North Pacific)
    [36.5000, 152.0000],  // Northwest Pacific shipping corridor
    [39.5000, 168.0000],  // Approaching International Date Line
    [40.2000, 180.0000],  // International Date Line (North Pacific)
    [39.0000, -165.0000], // Northeast Pacific
    [37.0000, -145.0000], // Eastern Pacific shipping lane
    [35.2000, -130.0000], // Approaching US West Coast EEZ
    [34.1000, -121.5000], // Offshore Southern California
    [33.7402, -118.2650], // Port of Los Angeles (delivery)
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
      this.emit({ t: "log", msg: "DEMO MODE: simulated container ship (no hardware) — Port of Shanghai → Port of Los Angeles" });
      this.sendCfg();
      this.timer = setInterval(() => this.tick(), 50);
    }

    stop() { clearInterval(this.timer); this.timer = null; }

    emit(obj) { if (this.onLine) this.onLine(JSON.stringify(obj)); }

    sendCfg() {
      this.emit({ t: "cfg", id: "SHIP-SHA-LAX", thr: this.thr, shock: this.shockThr, mpu: 1, fs: 1, tsrc: "gps" });
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
      const dLat = b[0] - a[0];
      let dLng = b[1] - a[1];
      if (dLng > 180)  dLng -= 360;
      if (dLng < -180) dLng += 360;

      let lat = a[0] + dLat * this.segT;
      let lng = a[1] + dLng * this.segT;
      if (lng > 180)  lng -= 360;
      if (lng < -180) lng += 360;

      const crs = (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;
      return { lat, lng, crs };
    }

    advance() {
      const a = ROUTE[this.seg], b = ROUTE[this.seg + 1];
      const dLat = b[0] - a[0];
      let dLng = b[1] - a[1];
      if (dLng > 180)  dLng -= 360;
      if (dLng < -180) dLng += 360;
      const d = Math.hypot(dLat, dLng);
      // Advance step: full transpacific route completes smoothly in ~55s (20 Hz)
      this.segT += 0.11 / d;
      if (this.segT >= 1) { this.segT = 0; this.seg++; if (this.seg >= ROUTE.length - 1) this.seg = 0; }
    }

    bump(t, c, w) { return Math.exp(-Math.pow((t - c) / w, 2)); }

    tick() {
      const t = (performance.now() - this.t0) / 1000, now = performance.now();
      const n = () => (Math.random() - 0.5);

      // Ocean swells: rhythmic roll and pitch of container ship in Pacific waters
      let roll  = 3.2 * Math.sin(2 * Math.PI * t / 7.8) + 1.5 * Math.sin(2 * Math.PI * t / 4.1 + 0.6) + n() * 0.35;
      let pitch = 2.0 * Math.sin(2 * Math.PI * t / 9.2 + 0.3) + 0.8 * Math.sin(2 * Math.PI * t / 3.4) + n() * 0.25;
      // Long-period gentle navigation yaw
      let yaw   = 2.5 * Math.sin(2 * Math.PI * t / 42) + 0.8 * Math.sin(2 * Math.PI * t / 18 + 0.8);

      // Ship cruising speed: ~21.5 knots (~40 km/h)
      const speedKnots = 21.5 + 2.0 * Math.sin(t / 25) + n() * 0.6;

      // Base vertical acceleration with wave lift and plunge
      let g = 1.0 + n() * 0.03 + 0.035 * Math.abs(Math.sin(2 * Math.PI * t / 3.9));

      // --- Wave slam / wave slap impact: sharp shock every ~12 seconds ---
      const shockInterval = 12;
      const sk = Math.round((t - 4) / shockInterval);
      if (sk >= 0) {
        const centre = 4 + sk * shockInterval;
        const b = this.bump(t, centre, 0.11);
        if (b > 0.01) {
          const side = (sk % 2 ? -1 : 1);
          roll  += side * (10 + Math.random() * 5) * b;
          pitch += (5 + Math.random() * 3) * b;
          g     += (0.6 + Math.random() * 1.1) * b;
        }
      }

      // --- Heavy sea swell event every ~28 seconds to test tilt warning threshold ---
      const swellInterval = 28;
      const rk = Math.round((t - 14) / swellInterval);
      if (rk >= 0) {
        const rCentre = 14 + rk * swellInterval;
        const rb = this.bump(t, rCentre, 0.55);
        if (rb > 0.01) {
          roll  += 32 * rb;
          pitch += 9 * rb;
          g     += 0.45 * rb;
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
        t: "d", id: "SHIP-SHA-LAX", ms: Math.round(t * 1000), time: iso(epoch),
        roll: +this.roll.toFixed(2), pitch: +this.pitch.toFixed(2), yaw: +this.yaw.toFixed(2), tilt: +tiltDeg.toFixed(2),
        ax: +ax.toFixed(3), ay: +ay.toFixed(3), az: +az.toFixed(3), g: +g.toFixed(3),
        gx: 0, gy: 0, gz: 0, temp: +(21.0 + Math.sin(t / 120) * 2.5).toFixed(1),
        lat: +pos.lat.toFixed(6), lng: +pos.lng.toFixed(6), fix: 1, sats: 10 + Math.round(Math.random() * 2),
        spd: +speedKnots.toFixed(2), crs: +pos.crs.toFixed(1),
        alarm: this.tilt.active ? 1 : 0, thr: this.thr, mpu: 1,
      });
    }

    detect(tiltDeg, g, epoch, now, pos) {
      const T = this.tilt;
      const mk = (type, phase, startEpoch, dur, peak, r, p, id) => {
        const e = {
          id: `SHIP-SHA-LAX-${startEpoch}-${id}`, type, phase, time: iso(startEpoch), epoch: startEpoch, dur,
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
