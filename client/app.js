/* ============================================================================
 *  CargoTwin dashboard: connection handling, telemetry, incident log, map
 *  Data sources:
 *    - Demo : in-browser simulator (sim.js)
 *    - MQTT : local broker via MQTT over WebSocket (mqtt.js, default ws://localhost:9001)
 *             Subscribes to  shipment/+/+
 *             Expects payload JSON: {t:"d", time, tilt, g, roll, pitch, yaw,
 *                                    lat, lng, fix, sats, spd, crs, temp, alarm,
 *                                    ax, ay, az, id, thr}
 *             Also handles {t:"e"} incident events and {t:"cfg"} config msgs.
 * ==========================================================================*/
(function () {
  const $ = (id) => document.getElementById(id);
  const LS_EVENTS = "cargotwin.events", LS_OPTS = "cargotwin.opts", LS_WS = "cargotwin.ws", LS_MQTT = "cargotwin.mqtt";
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
  };

  /* ---------------- state ---------------- */
  let source = null;          // active connection
  let last = null;            // last telemetry packet
  let lastPacketAt = 0, packetCount = 0, rate = 0;
  let threshold = 30, shockThr = 2.0;
  let soundOn = true, follow = true;
  const events = new Map(store.get(LS_EVENTS, []).map((e) => [e.id, e]));
  const opts = Object.assign({ invRoll: false, invPitch: false, invYaw: false, swap: false, noYaw: false }, store.get(LS_OPTS, {}));
  const hist = { t: [], tilt: [], roll: [], pitch: [] };
  let shockBannerUntil = 0;

  /* ---------------- sources ---------------- */
  class DemoSource {
    async connect(onLine) { this.sim = new Simulator(); this.sim.start(onLine); }
    send(line) { this.sim && this.sim.send(line); }
    close() { this.sim && this.sim.stop(); }
    get label() { return "Demo (simulated)"; }
    get kind() { return "demo"; }
  }

  class MqttSource {
    constructor(url) { this.url = url; this.closed = false; this.client = null; }

    connect(onLine, onClose, onStatus) {
      return new Promise((resolve, reject) => {
        if (typeof mqtt === 'undefined') {
          reject(new Error('MQTT.js library not loaded. Check your internet connection (CDN) or bundle mqtt.min.js locally.'));
          return;
        }
        const clientId = 'cargotwin-' + Math.random().toString(16).slice(2, 8);
        const client = mqtt.connect(this.url, {
          clientId,
          reconnectPeriod: 2000,   // auto-reconnect every 2 s
          connectTimeout: 10000,
        });
        this.client = client;

        client.on('connect', () => {
          client.subscribe('shipment/#', { qos: 0 }, (err) => {
            if (err) { reject(new Error('Subscribe failed: ' + err.message)); return; }
            onStatus && onStatus('on');
            resolve();
          });
        });

        client.on('reconnect', () => {
          if (!this.closed) onStatus && onStatus('wait');
        });

        client.on('message', (_topic, payload) => {
          // Each MQTT message is a single JSON object — feed it straight to onLine
          onLine(payload.toString());
        });

        client.on('error', (err) => {
          // Only reject the initial connect promise; after that log silently
          if (!this._connected) { this._connected = true; reject(new Error('MQTT error: ' + err.message)); }
        });

        client.on('close', () => {
          if (!this.closed) {
            onStatus && onStatus('wait');
          } else {
            onClose && onClose('MQTT disconnected');
          }
        });

        // Mark connected so subsequent errors don't double-reject
        client.on('connect', () => { this._connected = true; });
      });
    }

    send(_line) { /* MQTT is receive-only in this setup */ }

    close() {
      this.closed = true;
      if (this.client) { this.client.end(true); this.client = null; }
    }

    get label() { return 'MQTT ' + this.url.replace(/^wss?:\/\//, ''); }
    get kind()  { return 'mqtt'; }
  }

  function sendCmd(obj) { if (source) source.send(JSON.stringify(obj)); }

  async function connect(src) {
    await disconnect();
    setStatus("wait", "Connecting…");
    try {
      await src.connect(onLine, (why) => { log(why); disconnect(); }, (s) => setStatus(s, s === "on" ? src.label : "Reconnecting…"));
    } catch (e) {
      if (e && e.name === "NotFoundError") { setStatus("off", "Disconnected"); return; } // user cancelled port picker
      setStatus("off", "Disconnected");
      log("Connection failed: " + (e.message || e));
      alert("Connection failed:\n" + (e.message || e));
      return;
    }
    source = src;
    setStatus(src.kind === "demo" ? "demo" : "on", src.label);
    $("btnDisconnect").hidden = false;
    $("btnDemo").classList.toggle("active", src.kind === "demo");
    // handshake: ask for config and give the device the laptop clock (USB/WiFi only)
    if (source && source.kind !== "mqtt") {
      const hello = () => { sendCmd({ cmd: "hello" }); sendCmd({ cmd: "time", epoch: Math.floor(Date.now() / 1000) }); };
      hello();
      setTimeout(hello, 2500); // ESP32 reboots when the USB port is opened
      clearInterval(connect.timeTimer);
      connect.timeTimer = setInterval(() => sendCmd({ cmd: "time", epoch: Math.floor(Date.now() / 1000) }), 300000);
    }
  }

  async function disconnect() {
    clearInterval(connect.timeTimer);
    if (source) { const s = source; source = null; await s.close(); }
    $("btnDisconnect").hidden = true;
    $("btnDemo").classList.remove("active");
    setStatus("off", "Disconnected");
    Twin.setAlarm(false);
    $("alarmBanner").hidden = true;
  }

  function setStatus(kind, text) {
    $("connDot").className = "dot " + kind;
    $("connText").textContent = text;
  }

  /* ---------------- incoming data ---------------- */
  function onLine(line) {
    if (!line || line[0] !== "{") { if (line) log(line); return; } // plain debug text / boot garbage
    let m; try { m = JSON.parse(line); } catch { return; }
    switch (m.t) {
      case "d": onTelemetry(m); break;
      case "e": onEvent(m); break;
      case "cfg": onConfig(m); break;
      case "log": log(m.msg); break;
    }
  }

  function onConfig(c) {
    if (c.id) { $("deviceId").textContent = c.id; Twin.setId(c.id); }
    if (typeof c.thr === "number") setThresholdUI(c.thr);
    if (typeof c.shock === "number") { shockThr = c.shock; $("shock").value = c.shock; $("shockVal").textContent = c.shock.toFixed(1) + " g"; }
    if (c.mpu === 0) log("⚠ Device reports MPU6050 not detected");
    if (c.fs === 0) log("⚠ Device flash storage unavailable");
    if (c.tsrc) log(`Device time source: ${c.tsrc}`);
  }

  function mapAxes(m) {
    let r = m.roll, p = m.pitch, y = opts.noYaw ? 0 : m.yaw;
    if (opts.swap) [r, p] = [p, r];
    if (opts.invRoll) r = -r;
    if (opts.invPitch) p = -p;
    if (opts.invYaw) y = -y;
    return [r, p, y];
  }

  function onTelemetry(m) {
    last = m;
    lastPacketAt = performance.now();
    packetCount++;
    $("noData").hidden = true;
    if (m.id && $("deviceId").textContent !== m.id) { $("deviceId").textContent = m.id; Twin.setId(m.id); }
    if (typeof m.thr === "number" && m.thr !== threshold && document.activeElement !== $("thr")) setThresholdUI(m.thr);

    const [r, p, y] = mapAxes(m);
    Twin.setOrientation(r, p, y);
    Twin.setAlarm(!!m.alarm || performance.now() < shockBannerUntil);

    const now = performance.now() / 1000;
    hist.t.push(now); hist.tilt.push(m.tilt); hist.roll.push(m.roll); hist.pitch.push(m.pitch);
    while (hist.t.length && hist.t[0] < now - 30) { hist.t.shift(); hist.tilt.shift(); hist.roll.shift(); hist.pitch.shift(); }
    chartDirty = true;
  }

  // DOM refresh at ~10 Hz (telemetry arrives at 20 Hz)
  setInterval(() => {
    const now = performance.now();
    if (source && lastPacketAt && now - lastPacketAt > 3000) setStatus("wait", "No data from device…");
    else if (source && lastPacketAt) setStatus(source.kind === "demo" ? "demo" : "on", source.label);
    if (!last) return;
    const m = last;
    const f = (v, d = 1) => (typeof v === "number" ? v.toFixed(d) : "-");
    $("vTilt").textContent = f(m.tilt);
    $("vRoll").textContent = f(m.roll);
    $("vPitch").textContent = f(m.pitch);
    $("vG").textContent = f(m.g, 2);
    $("vTemp").textContent = f(m.temp);
    $("vSats").textContent = m.sats ?? "-";
    $("vFix").textContent = m.fix ? `sats · ${f(m.spd)} kn` : "sats · no fix";
    $("hudRoll").textContent = f(m.roll) + "°";
    $("hudPitch").textContent = f(m.pitch) + "°";
    $("hudYaw").textContent = f(m.yaw) + "°";
    $("hudTilt").textContent = f(m.tilt) + "°";
    $("clock").textContent = m.time && !m.time.startsWith("T+") ? m.time.replace("T", " ").replace("Z", " UTC") : new Date().toLocaleTimeString() + " (local)";

    const scale = Math.max(90, threshold * 1.5);
    const pct = Math.min(100, (m.tilt / scale) * 100);
    $("barTilt").style.width = pct + "%";
    $("barThr").style.left = (threshold / scale) * 100 + "%";
    const over = m.tilt > threshold, near = m.tilt > threshold * 0.8;
    $("barTilt").style.background = over ? "var(--bad)" : near ? "var(--warn)" : "var(--ok)";
    $("tileTilt").className = "tile" + (over ? " alert" : near ? " warn" : "");
    $("tileG").className = "tile" + (m.g > shockThr ? " alert" : m.g > shockThr * 0.75 ? " warn" : "");

    // alarm banner
    const shock = now < shockBannerUntil;
    $("alarmBanner").hidden = !(m.alarm || shock);
    if (m.alarm) {
      $("alarmTitle").textContent = "⚠ TILT ALERT";
      $("alarmDetail").textContent = `Tilt ${f(m.tilt)}° > limit ${threshold}° · ${m.time || ""}`;
    } else if (shock) {
      $("alarmTitle").textContent = "⚠ SHOCK DETECTED";
    }

    // packet rate
    rateTick(now);
    updateMap(m);
  }, 100);

  let rateT0 = performance.now();
  function rateTick(now) {
    if (now - rateT0 >= 1000) { rate = packetCount * 1000 / (now - rateT0); packetCount = 0; rateT0 = now; $("rate").textContent = rate ? rate.toFixed(0) + " Hz" : ""; }
  }

  /* ---------------- events ---------------- */
  function onEvent(e) {
    const prev = events.get(e.id);
    const merged = Object.assign({}, prev || {}, e, { received: prev?.received || new Date().toISOString() });
    // keep the larger peak if start/end arrive in any order
    if (prev && prev.peak > merged.peak) merged.peak = prev.peak;
    if (prev?.phase === "end" && e.phase === "start") merged.phase = "end", merged.dur = prev.dur;
    delete merged.t; delete merged.hist;
    events.set(e.id, merged);
    persist();
    renderEvents(e.hist ? null : e.id);
    addEventMarker(merged);

    if (!e.hist && (e.phase === "start" || e.phase === "instant")) {
      beep(e.type === "SHOCK" ? 880 : 620);
      if (e.type === "SHOCK") {
        shockBannerUntil = performance.now() + 2500;
        $("alarmDetail").textContent = `${e.peak.toFixed(2)} g impact · ${e.time}`;
      }
    }
  }

  function persist() {
    const arr = [...events.values()].sort((a, b) => (a.epoch || 0) - (b.epoch || 0)).slice(-2000);
    store.set(LS_EVENTS, arr);
  }

  function fmtDur(e) {
    if (e.type === "SHOCK") return "-";
    if (e.phase === "start") return '<span class="live">● ongoing</span>';
    return (e.dur / 1000).toFixed(1) + " s";
  }
  function fmtTime(e) {
    if (e.time && !e.time.startsWith("T+")) return e.time.replace("T", " ").replace("Z", "");
    return `${e.time} <span class="muted">(rx ${new Date(e.received).toLocaleTimeString()})</span>`;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function renderEvents(newId) {
    const list = [...events.values()].sort((a, b) => (b.epoch || 0) - (a.epoch || 0) || (b.received > a.received ? 1 : -1));
    $("evCount").textContent = list.length;
    $("evCount").classList.toggle("hot", list.length > 0);
    $("evEmpty").hidden = list.length > 0;
    renderSummary(list);
    $("evBody").innerHTML = list.slice(0, 300).map((e) => `
      <tr data-id="${esc(e.id)}" title="Click to replay in 3D" class="${e.id === newId ? "new" : ""} ${e.id === selectedId ? "sel" : ""}">
        <td>${fmtTime(e)}</td>
        <td><span class="badge ${esc(e.type)}">${esc(e.type)}</span></td>
        <td>${e.type === "SHOCK" ? e.peak.toFixed(2) + " g" : e.peak.toFixed(1) + "°"}</td>
        <td>${fmtDur(e)}</td>
        <td>${(+e.roll).toFixed(1)}° / ${(+e.pitch).toFixed(1)}°</td>
        <td>${e.fix ? `${(+e.lat).toFixed(4)}, ${(+e.lng).toFixed(4)}` : '<span class="muted">no GPS fix</span>'}</td>
      </tr>`).join("");
  }

  function renderSummary(list) {
    const tilts = list.filter((e) => e.type === "TILT"), shocks = list.filter((e) => e.type === "SHOCK");
    const maxTilt = tilts.length ? Math.max(...tilts.map((e) => e.peak)) : null;
    const maxShock = shocks.length ? Math.max(...shocks.map((e) => e.peak)) : null;
    $("sumCount").textContent = `${tilts.length} tilt · ${shocks.length} shock`;
    $("sumTilt").textContent = maxTilt == null ? "-" : maxTilt.toFixed(1) + "°";
    $("sumShock").textContent = maxShock == null ? "-" : maxShock.toFixed(2) + " g";
    // rule of thumb: severe tilt (>= 60°, likely tipped over) or hard impact (>= 4 g) = likely damaged
    let st = ["Intact", "status-ok"];
    if (list.length) st = ["Inspect cargo", "status-warn"];
    if ((maxTilt ?? 0) >= 60 || (maxShock ?? 0) >= 4) st = ["Likely damaged", "status-bad"];
    $("sumStatus").textContent = st[0];
    $("sumStatus").className = st[1];
  }

  let selectedId = null;
  function replayIncident(e) {
    const [r, p] = mapAxes({ roll: e.roll, pitch: e.pitch, yaw: 0 });
    const y = last ? mapAxes(last)[2] : 0; // align with live heading so the two are comparable
    Twin.setIncident(r, p, y);
    const what = e.type === "SHOCK" ? `${e.peak.toFixed(2)} g shock` : `${e.peak.toFixed(1)}° tilt`;
    $("incidentDetail").textContent = `${what} at ${String(e.time).replace("T", " ").replace("Z", " UTC")} · roll ${(+e.roll).toFixed(1)}°, pitch ${(+e.pitch).toFixed(1)}°`;
    $("incidentBanner").hidden = false;
    document.querySelectorAll("#evBody tr.sel").forEach((t) => t.classList.remove("sel"));
  }
  $("btnIncidentClose").onclick = () => { Twin.clearIncident(); $("incidentBanner").hidden = true; selectedId = null; renderEvents(); };

  $("evBody").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr"); if (!tr) return;
    const e = events.get(tr.dataset.id); if (!e) return;
    selectedId = e.id;
    replayIncident(e);
    tr.classList.add("sel");
    if (!e.fix || !map) return;
    follow = false;
    map.flyTo([e.lat, e.lng], 11, { duration: 0.8 });
    const mk = eventMarkers.get(e.id); mk && setTimeout(() => mk.openPopup(), 850);
  });

  function exportCsv() {
    const cols = ["id", "type", "time_utc", "duration_s", "peak", "unit", "roll_deg", "pitch_deg", "threshold", "lat", "lng", "gps_fix", "time_source", "received_local"];
    const rows = [...events.values()].sort((a, b) => (a.epoch || 0) - (b.epoch || 0)).map((e) => [
      e.id, e.type, e.time, e.type === "SHOCK" ? "" : e.phase === "start" ? "ongoing" : (e.dur / 1000).toFixed(2),
      e.peak, e.type === "SHOCK" ? "g" : "deg", e.roll, e.pitch, e.thr, e.lat, e.lng, e.fix, e.tsrc, e.received,
    ]);
    const csv = [cols, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `incident-log-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------------- map ---------------- */
  let map = null, shipMarker = null, track = null, lastTrackPt = null, lastMapUpdate = 0;
  const eventMarkers = new Map();
  function initMap() {
    if (typeof L === "undefined") { $("map").innerHTML = '<div class="empty">Map library failed to load.</div>'; return; }
    map = L.map("map", { zoomControl: true, attributionControl: true }).setView([3.5, 100.5], 6);
    const esri = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
    const attr = "Tiles &copy; Esri";
    const dark = L.layerGroup([
      L.tileLayer(esri("Canvas/World_Dark_Gray_Base"), { maxZoom: 16, attribution: attr }),
      L.tileLayer(esri("Canvas/World_Dark_Gray_Reference"), { maxZoom: 16 }),
    ]).addTo(map);
    const sat = L.layerGroup([
      L.tileLayer(esri("World_Imagery"), { maxZoom: 18, attribution: attr }),
      L.tileLayer(esri("Reference/World_Boundaries_and_Places"), { maxZoom: 18 }),
    ]);
    L.control.layers({ "Dark": dark, "Satellite": sat }, null, { position: "bottomleft" }).addTo(map);
    track = L.polyline([], { color: "#3aa0ff", weight: 3, opacity: 0.8 }).addTo(map);
    shipMarker = L.marker([0, 0], { icon: L.divIcon({ className: "", html: '<div class="ship-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) });
    map.on("dragstart", () => (follow = false));
    const FollowCtl = L.Control.extend({
      onAdd() {
        const b = L.DomUtil.create("button", "chip"); b.textContent = "Follow"; b.style.margin = "0";
        b.onclick = (ev) => { ev.stopPropagation(); follow = true; last && last.fix && map.panTo([last.lat, last.lng]); };
        return b;
      },
    });
    new FollowCtl({ position: "topright" }).addTo(map);
    events.forEach(addEventMarker);
  }

  function updateMap(m) {
    if (!map) return;
    const now = performance.now();
    if (now - lastMapUpdate < 1000) return;
    lastMapUpdate = now;
    if (!m.fix) { $("pos").textContent = "Waiting for GPS fix…"; return; }
    const ll = [m.lat, m.lng];
    $("pos").textContent = `${m.lat.toFixed(5)}, ${m.lng.toFixed(5)} · ${(m.crs ?? 0).toFixed(0)}°`;
    if (!map.hasLayer(shipMarker)) { shipMarker.addTo(map); map.setView(ll, 9); }
    shipMarker.setLatLng(ll);
    if (!lastTrackPt || Math.hypot(ll[0] - lastTrackPt[0], ll[1] - lastTrackPt[1]) > 0.00005) {
      track.addLatLng(ll); lastTrackPt = ll;
      const pts = track.getLatLngs(); if (pts.length > 5000) track.setLatLngs(pts.slice(-4000));
    }
    if (follow) map.panTo(ll, { animate: true, duration: 0.8 });
  }

  function addEventMarker(e) {
    if (!map || !e.fix) return;
    const html = `<b>${esc(e.type)}</b> · ${e.type === "SHOCK" ? e.peak.toFixed(2) + " g" : e.peak.toFixed(1) + "°"}<br>${esc(e.time)}<br>` +
      (e.type === "TILT" ? `Duration: ${e.phase === "start" ? "ongoing" : (e.dur / 1000).toFixed(1) + " s"}<br>` : "") +
      `${(+e.lat).toFixed(5)}, ${(+e.lng).toFixed(5)}`;
    let mk = eventMarkers.get(e.id);
    if (!mk) {
      mk = L.marker([e.lat, e.lng], { icon: L.divIcon({ className: "", html: `<div class="ev-marker ${esc(e.type)}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }) }).addTo(map);
      eventMarkers.set(e.id, mk);
    }
    mk.bindPopup(html);
  }

  /* ---------------- chart ---------------- */
  let chartDirty = true;
  const cv = $("chart"), cx = cv.getContext("2d");
  function drawChart() {
    requestAnimationFrame(drawChart);
    if (!chartDirty) return;
    chartDirty = false;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, w, h);
    const pad = { l: 34, r: 6, t: 6, b: 16 };
    const maxAbs = Math.max(45, threshold + 10, ...hist.tilt.map(Math.abs), ...hist.roll.map(Math.abs), ...hist.pitch.map(Math.abs));
    const ymax = Math.ceil(maxAbs / 15) * 15;
    const now = performance.now() / 1000;
    const X = (t) => pad.l + ((t - (now - 30)) / 30) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v + ymax) / (2 * ymax)) * (h - pad.t - pad.b);
    // grid
    cx.font = "10px Consolas, monospace"; cx.fillStyle = "#7d8ea5"; cx.strokeStyle = "#1d2a3d"; cx.lineWidth = 1;
    for (let v = -ymax; v <= ymax; v += ymax / 3) {
      cx.beginPath(); cx.moveTo(pad.l, Y(v)); cx.lineTo(w - pad.r, Y(v)); cx.stroke();
      cx.fillText(`${Math.round(v)}°`, 2, Y(v) + 3);
    }
    for (let s = 0; s <= 30; s += 10) cx.fillText(`-${30 - s}s`, X(now - 30 + s) - 10, h - 3);
    // threshold lines
    cx.setLineDash([4, 3]); cx.strokeStyle = "#ff4d5e";
    [threshold, -threshold].forEach((v) => { cx.beginPath(); cx.moveTo(pad.l, Y(v)); cx.lineTo(w - pad.r, Y(v)); cx.stroke(); });
    cx.setLineDash([]);
    const css = getComputedStyle(document.documentElement);
    const series = [["roll", css.getPropertyValue("--c-roll")], ["pitch", css.getPropertyValue("--c-pitch")], ["tilt", css.getPropertyValue("--c-tilt")]];
    series.forEach(([k, col]) => {
      const arr = hist[k]; if (arr.length < 2) return;
      cx.strokeStyle = col.trim(); cx.lineWidth = k === "tilt" ? 2.2 : 1.4;
      cx.beginPath();
      arr.forEach((v, i) => { const x = X(hist.t[i]), y = Y(v); i ? cx.lineTo(x, y) : cx.moveTo(x, y); });
      cx.stroke();
    });
  }
  setInterval(() => (chartDirty = true), 100); // keep scrolling even if data stops

  /* ---------------- sound ---------------- */
  let actx = null;
  function beep(freq) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((d, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = "square"; o.frequency.value = i ? freq * 1.25 : freq;
        g.gain.setValueAtTime(0.0001, actx.currentTime + d);
        g.gain.exponentialRampToValueAtTime(0.12, actx.currentTime + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + d + 0.16);
        o.connect(g).connect(actx.destination); o.start(actx.currentTime + d); o.stop(actx.currentTime + d + 0.17);
      });
    } catch { }
  }

  /* ---------------- console ---------------- */
  const logLines = [];
  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logLines.push(line); if (logLines.length > 300) logLines.shift();
    $("consoleLog").textContent = logLines.join("\n");
    $("consoleLog").scrollTop = 1e9;
    $("consoleLast").textContent = String(msg).slice(0, 90);
  }

  /* ---------------- UI wiring ---------------- */
  function setThresholdUI(v) {
    threshold = v;
    $("thr").value = v;
    $("thrVal").textContent = v + "°";
    Twin.setThreshold(v);
    chartDirty = true;
  }

  $("thr").addEventListener("input", (e) => setThresholdUI(+e.target.value));
  $("thr").addEventListener("change", (e) => sendCmd({ cmd: "threshold", value: +e.target.value }));
  $("shock").addEventListener("input", (e) => { shockThr = +e.target.value; $("shockVal").textContent = shockThr.toFixed(1) + " g"; });
  $("shock").addEventListener("change", (e) => sendCmd({ cmd: "shock", value: +e.target.value }));
  $("btnLevel").onclick = () => { if (!source) return alert("Connect a device first."); sendCmd({ cmd: "level" }); };
  $("btnYaw").onclick = () => sendCmd({ cmd: "resetYaw" });
  $("btnSound").onclick = () => { soundOn = !soundOn; $("btnSound").textContent = soundOn ? "🔔 Sound on" : "🔕 Sound off"; if (soundOn) beep(700); };

  $("btnDemo").onclick = () => (source && source.kind === "demo" ? disconnect() : connect(new DemoSource()));
  $("mqttUrl").value = store.get(LS_MQTT, "ws://localhost:9001");
  $("btnMqtt").onclick = () => {
    let url = $("mqttUrl").value.trim();
    if (!/^wss?:\/\//.test(url)) url = "ws://" + url;
    $("mqttUrl").value = url; store.set(LS_MQTT, url);
    connect(new MqttSource(url));
  };
  $("btnDisconnect").onclick = () => disconnect();

  $("btnDump").onclick = () => { if (!source) return alert("Connect a device first."); sendCmd({ cmd: "dump" }); };
  $("btnCsv").onclick = exportCsv;
  $("btnClear").onclick = () => {
    if (!confirm("Clear the incident log in this dashboard?\n(Events stored on the device are kept and can be re-loaded with 'Load from device'.)")) return;
    events.clear(); persist(); selectedId = null; renderEvents();
    Twin.clearIncident(); $("incidentBanner").hidden = true;
    eventMarkers.forEach((m) => m.remove()); eventMarkers.clear();
  };

  document.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => Twin.setView(b.dataset.view)));
  $("btnFull").onclick = () => {
    const el = $("twin");
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => { });
  };
  $("btnFollow").onclick = () => $("btnFollow").classList.toggle("active", Twin.toggleOrbit());

  // settings
  const optMap = { optInvRoll: "invRoll", optInvPitch: "invPitch", optInvYaw: "invYaw", optSwap: "swap", optNoYaw: "noYaw" };
  Object.entries(optMap).forEach(([id, k]) => {
    $(id).checked = opts[k];
    $(id).onchange = () => { opts[k] = $(id).checked; store.set(LS_OPTS, opts); };
  });
  $("btnSettings").onclick = () => $("settings").showModal();


  /* ---------------- boot ---------------- */
  Twin.init($("twin"));
  setThresholdUI(threshold);
  initMap();
  renderEvents();
  drawChart();
  log("Dashboard ready. Click MQTT to connect to your local broker, or Demo to simulate.");
  if (new URLSearchParams(location.search).has("demo")) connect(new DemoSource());
})();
