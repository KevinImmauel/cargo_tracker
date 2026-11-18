/* ============================================================================
 *  CargoTwin dashboard — enhanced with force analytics, route progress,
 *  cargo weight slider, cargo integrity score, and Bengaluru route.
 *  Data sources:
 *    - Demo : in-browser simulator (sim.js) — MS Palya → Presidency University
 *    - MQTT : local broker via MQTT over WebSocket
 *             Subscribes to  shipment/#
 *             Payload JSON: {t:"d", id, time, tilt, g, roll, pitch, yaw,
 *                            ax, ay, az, lat, lng, fix, sats, spd, crs,
 *                            temp, alarm, thr, mpu}
 *             Also handles {t:"e"} incidents and {t:"cfg"} config msgs.
 * ==========================================================================*/
(function () {
  const $ = (id) => document.getElementById(id);
  const LS_EVENTS = "cargotwin.events", LS_OPTS = "cargotwin.opts", LS_MQTT = "cargotwin.mqtt";
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
  };

  /* ── route endpoints (Bengaluru) ── */
  const ORIGIN = { lat: 12.9516, lng: 77.6412, name: "MS Palya" };
  const DEST   = { lat: 13.1206, lng: 77.5940, name: "Presidency University" };

  /* ── state ── */
  let source = null;
  let last = null;
  let lastPacketAt = 0, packetCount = 0, rate = 0;
  let threshold = 30, shockThr = 2.0;
  let cargoWeight = 5000;   // kg
  let peakForceN  = 0;
  let soundOn = true, follow = true;
  const events = new Map(store.get(LS_EVENTS, []).map((e) => [e.id, e]));
  const opts = Object.assign({ invRoll: false, invPitch: false, invYaw: false, swap: false, noYaw: false }, store.get(LS_OPTS, {}));
  const hist = { t: [], tilt: [], roll: [], pitch: [] };
  let shockBannerUntil = 0;
  let integrityScore = 100;

  /* ── sources ── */
  class DemoSource {
    async connect(onLine) { this.sim = new Simulator(); this.sim.start(onLine); }
    send(line) { this.sim && this.sim.send(line); }
    close() { this.sim && this.sim.stop(); }
    get label() { return "Demo (simulated)"; }
    get kind()  { return "demo"; }
  }

  class MqttSource {
    constructor(url) { this.url = url; this.closed = false; this.client = null; }

    connect(onLine, onClose, onStatus) {
      return new Promise((resolve, reject) => {
        if (typeof mqtt === "undefined") {
          reject(new Error("MQTT.js library not loaded. Check your internet connection (CDN) or bundle mqtt.min.js locally.")); return;
        }
        const clientId = "cargotwin-" + Math.random().toString(16).slice(2, 8);
        const client = mqtt.connect(this.url, { clientId, reconnectPeriod: 2000, connectTimeout: 10000 });
        this.client = client;
        client.on("connect", () => {
          client.subscribe("shipment/#", { qos: 0 }, (err) => {
            if (err) { reject(new Error("Subscribe failed: " + err.message)); return; }
            onStatus && onStatus("on"); resolve();
          });
        });
        client.on("reconnect", () => { if (!this.closed) onStatus && onStatus("wait"); });
        client.on("message", (_topic, payload) => { onLine(payload.toString()); });
        client.on("error", (err) => { if (!this._connected) { this._connected = true; reject(new Error("MQTT error: " + err.message)); } });
        client.on("close", () => {
          if (!this.closed) onStatus && onStatus("wait");
          else onClose && onClose("MQTT disconnected");
        });
        client.on("connect", () => { this._connected = true; });
      });
    }

    send(_line) { }
    close() { this.closed = true; if (this.client) { this.client.end(true); this.client = null; } }
    get label() { return "MQTT " + this.url.replace(/^wss?:\/\//, ""); }
    get kind()  { return "mqtt"; }
  }

  function sendCmd(obj) { if (source) source.send(JSON.stringify(obj)); }

  async function connect(src) {
    await disconnect();
    setStatus("wait", "Connecting…");
    try {
      await src.connect(onLine, (why) => { log(why); disconnect(); }, (s) => setStatus(s, s === "on" ? src.label : "Reconnecting…"));
    } catch (e) {
      if (e && e.name === "NotFoundError") { setStatus("off", "Disconnected"); return; }
      setStatus("off", "Disconnected");
      log("Connection failed: " + (e.message || e));
      alert("Connection failed:\n" + (e.message || e)); return;
    }
    source = src;
    setStatus(src.kind === "demo" ? "demo" : "on", src.label);
    $("btnDisconnect").hidden = false;
    $("btnDemo").classList.toggle("active", src.kind === "demo");
    if (source && source.kind !== "mqtt") {
      const hello = () => { sendCmd({ cmd: "hello" }); sendCmd({ cmd: "time", epoch: Math.floor(Date.now() / 1000) }); };
      hello(); setTimeout(hello, 2500);
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

  /* ── incoming data ── */
  function onLine(line) {
    if (!line || line[0] !== "{") { if (line) log(line); return; }
    let m; try { m = JSON.parse(line); } catch { return; }
    switch (m.t) {
      case "d":   onTelemetry(m); break;
      case "e":   onEvent(m);     break;
      case "cfg": onConfig(m);    break;
      case "log": log(m.msg);     break;
    }
  }

  function onConfig(c) {
    if (c.id) { $("deviceId").textContent = c.id; Twin.setId(c.id); }
    if (typeof c.thr === "number") setThresholdUI(c.thr);
    if (typeof c.shock === "number") { shockThr = c.shock; $("shock").value = c.shock; $("shockVal").textContent = c.shock.toFixed(1) + " g"; }
    if (c.mpu === 0) log("⚠ Device reports MPU6050 not detected");
    if (c.fs  === 0) log("⚠ Device flash storage unavailable");
    if (c.tsrc) log(`Device time source: ${c.tsrc}`);
  }

  function mapAxes(m) {
    let r = m.roll, p = m.pitch, y = opts.noYaw ? 0 : m.yaw;
    if (opts.swap)     [r, p] = [p, r];
    if (opts.invRoll)  r = -r;
    if (opts.invPitch) p = -p;
    if (opts.invYaw)   y = -y;
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

    // update peak force
    const forceN = cargoWeight * 9.81 * m.g;
    if (forceN > peakForceN) peakForceN = forceN;
    chartDirty = true;
  }

  /* ── DOM refresh at ~10 Hz ── */
  setInterval(() => {
    const now = performance.now();
    if (source && lastPacketAt && now - lastPacketAt > 3000) setStatus("wait", "No data from device…");
    else if (source && lastPacketAt) setStatus(source.kind === "demo" ? "demo" : "on", source.label);
    if (!last) return;
    const m = last;
    const f = (v, d = 1) => (typeof v === "number" ? v.toFixed(d) : "-");

    $("vTilt").textContent  = f(m.tilt);
    $("vRoll").textContent  = f(m.roll);
    $("vPitch").textContent = f(m.pitch);
    $("vG").textContent     = f(m.g, 2);
    $("vTemp").textContent  = f(m.temp);
    $("vSats").textContent  = m.sats ?? "-";
    // GPS: show satellite count + fix, speed in km/h
    const speedKmh = typeof m.spd === "number" ? m.spd * 1.852 : null;
    $("vFix").textContent   = m.fix ? `sats · ${f(speedKmh, 1)} km/h` : "sats · no fix";
    $("vSpeed").textContent = speedKmh != null ? `${f(speedKmh, 1)} km/h` : "-";

    $("hudRoll").textContent  = f(m.roll) + "°";
    $("hudPitch").textContent = f(m.pitch) + "°";
    $("hudYaw").textContent   = f(m.yaw)   + "°";
    $("hudTilt").textContent  = f(m.tilt)  + "°";
    $("clock").textContent = m.time && !m.time.startsWith("T+")
      ? m.time.replace("T", " ").replace("Z", " UTC")
      : new Date().toLocaleTimeString() + " (local)";

    const scale = Math.max(90, threshold * 1.5);
    const pct = Math.min(100, (m.tilt / scale) * 100);
    $("barTilt").style.width = pct + "%";
    $("barThr").style.left   = (threshold / scale) * 100 + "%";
    const over = m.tilt > threshold, near = m.tilt > threshold * 0.8;
    $("barTilt").style.background = over ? "var(--bad)" : near ? "var(--warn)" : "var(--ok)";
    $("tileTilt").className = "tile" + (over ? " alert" : near ? " warn" : "");
    $("tileG").className    = "tile" + (m.g > shockThr ? " alert" : m.g > shockThr * 0.75 ? " warn" : "");

    // ── force display ──
    updateForceDisplay(m.g, speedKmh);

    // ── alarm banner ──
    const shock = now < shockBannerUntil;
    $("alarmBanner").hidden = !(m.alarm || shock);
    if (m.alarm) {
      const curForce = cargoWeight * 9.81 * m.g;
      $("alarmTitle").textContent  = "⚠ TILT ALERT";
      $("alarmDetail").textContent = `Tilt ${f(m.tilt)}° > limit ${threshold}° · ${m.time || ""}`;
      $("alarmForce").textContent  = `Force: ${curForce.toFixed(0)} N (${(curForce/1000).toFixed(2)} kN)`;
    } else if (shock) {
      const curForce = cargoWeight * 9.81 * m.g;
      $("alarmTitle").textContent  = "⚠ SHOCK DETECTED";
      $("alarmDetail").textContent = `${f(m.g, 2)} g impact`;
      $("alarmForce").textContent  = `Force: ${curForce.toFixed(0)} N (${(curForce/1000).toFixed(2)} kN)`;
    }

    rateTick(now);
    updateMap(m);
    updateRouteProgress(m);
  }, 100);

  /* ── force analytics ── */
  function updateForceDisplay(g, speedKmh) {
    const forceN = cargoWeight * 9.81 * g;
    $("vForceN").textContent  = forceN.toFixed(0);
    $("vForceSub").textContent = `Peak: ${peakForceN.toFixed(0)} N  |  ${(forceN / 1000).toFixed(2)} kN`;

    // zone class
    let zoneClass = "";
    if (g < 1.2)       zoneClass = "force-safe";
    else if (g < 2.0)  zoneClass = "force-caution";
    else if (g < 4.0)  zoneClass = "force-warning";
    else               zoneClass = "force-critical";
    $("tileForce").className = "tile " + zoneClass;

    // highlight active zone
    ["fz-safe","fz-caution","fz-warning","fz-critical"].forEach((id) => {
      const el = $(id);
      const matches = (id === "fz-safe"     && g < 1.2)   ||
                      (id === "fz-caution"  && g >= 1.2 && g < 2.0) ||
                      (id === "fz-warning"  && g >= 2.0 && g < 4.0) ||
                      (id === "fz-critical" && g >= 4.0);
      el.classList.toggle("active", matches);
    });
  }

  /* ── route progress ── */
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function updateRouteProgress(m) {
    if (!m.fix) return;
    const total   = haversineKm(ORIGIN.lat, ORIGIN.lng, DEST.lat, DEST.lng);
    const covered = haversineKm(ORIGIN.lat, ORIGIN.lng, m.lat, m.lng);
    const pctRaw  = Math.min(100, Math.max(0, (covered / total) * 100));
    const remain  = Math.max(0, total - covered);

    $("rpPct").textContent        = pctRaw.toFixed(1) + "%";
    $("rpBarFill").style.width    = pctRaw + "%";
    $("rpTruck").style.left       = pctRaw + "%";
    $("rpRemain").textContent     = remain.toFixed(2) + " km";

    const speedKmh = typeof m.spd === "number" ? m.spd * 1.852 : 0;
    $("rpSpeed").textContent = speedKmh > 0.5 ? speedKmh.toFixed(1) + " km/h" : "—";
    if (speedKmh > 0.5) {
      const etaHrs = remain / speedKmh;
      const etaMins = Math.round(etaHrs * 60);
      $("rpEta").textContent = etaMins <= 1 ? "ETA: < 1 min" : `ETA: ~${etaMins} min`;
    } else {
      $("rpEta").textContent = "ETA: —";
    }
  }

  let rateT0 = performance.now();
  function rateTick(now) {
    if (now - rateT0 >= 1000) {
      rate = packetCount * 1000 / (now - rateT0);
      packetCount = 0; rateT0 = now;
      $("rate").textContent = rate ? rate.toFixed(0) + " Hz" : "";
    }
  }

  /* ── events ── */
  function onEvent(e) {
    const prev = events.get(e.id);
    const merged = Object.assign({}, prev || {}, e, { received: prev?.received || new Date().toISOString() });
    if (prev && prev.peak > merged.peak) merged.peak = prev.peak;
    if (prev?.phase === "end" && e.phase === "start") { merged.phase = "end"; merged.dur = prev.dur; }
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
      // decrease integrity score by 5% per new incident
      integrityScore = Math.max(0, integrityScore - 5);
    }
  }

  function persist() {
    const arr = [...events.values()].sort((a, b) => (a.epoch||0)-(b.epoch||0)).slice(-2000);
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
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

  function renderEvents(newId) {
    const list = [...events.values()].sort((a,b) => (b.epoch||0)-(a.epoch||0)||(b.received>a.received?1:-1));
    $("evCount").textContent = list.length;
    $("evCount").classList.toggle("hot", list.length > 0);
    $("evEmpty").hidden = list.length > 0;
    renderSummary(list);
    $("evBody").innerHTML = list.slice(0, 300).map((e) => {
      // force in table: use peak g × cargo weight × 9.81
      const fN = e.type === "SHOCK"
        ? (cargoWeight * 9.81 * e.peak).toFixed(0)
        : (cargoWeight * 9.81 * 1.0).toFixed(0);  // tilt events use 1g baseline
      return `
        <tr data-id="${esc(e.id)}" title="Click to replay in 3D" class="${e.id===newId?"new":""} ${e.id===selectedId?"sel":""}">
          <td>${fmtTime(e)}</td>
          <td><span class="badge ${esc(e.type)}">${esc(e.type)}</span></td>
          <td>${e.type==="SHOCK"?e.peak.toFixed(2)+" g":e.peak.toFixed(1)+"°"}</td>
          <td>${fN} N</td>
          <td>${fmtDur(e)}</td>
          <td>${(+e.roll).toFixed(1)}° / ${(+e.pitch).toFixed(1)}°</td>
          <td>${e.fix?`${(+e.lat).toFixed(4)}, ${(+e.lng).toFixed(4)}`:'<span class="muted">no GPS fix</span>'}</td>
        </tr>`;
    }).join("");
  }

  function renderSummary(list) {
    const tilts  = list.filter((e) => e.type === "TILT");
    const shocks = list.filter((e) => e.type === "SHOCK");
    const maxTilt  = tilts.length  ? Math.max(...tilts.map((e)  => e.peak)) : null;
    const maxShock = shocks.length ? Math.max(...shocks.map((e) => e.peak)) : null;

    $("sumCount").textContent  = `${tilts.length} tilt · ${shocks.length} shock`;
    $("sumTilt").textContent   = maxTilt  == null ? "-" : maxTilt.toFixed(1) + "°";
    $("sumShock").textContent  = maxShock == null ? "-" : maxShock.toFixed(2) + " g";

    // integrity text
    let st = ["Intact ✓", "status-ok"];
    if (list.length) st = ["Inspect ⚠", "status-warn"];
    if ((maxTilt ?? 0) >= 60 || (maxShock ?? 0) >= 4) st = ["Damaged ✗", "status-bad"];
    $("sumStatus").textContent = st[0];
    $("sumStatus").className   = st[1];

    // integrity score
    const scoreColor = integrityScore >= 80 ? "status-ok" : integrityScore >= 50 ? "status-warn" : "status-bad";
    $("sumScore").textContent = integrityScore + "%";
    $("sumScore").className   = scoreColor;
  }

  let selectedId = null;
  function replayIncident(e) {
    const [r, p] = mapAxes({ roll: e.roll, pitch: e.pitch, yaw: 0 });
    const y = last ? mapAxes(last)[2] : 0;
    Twin.setIncident(r, p, y);
    const what = e.type === "SHOCK" ? `${e.peak.toFixed(2)} g shock` : `${e.peak.toFixed(1)}° tilt`;
    $("incidentDetail").textContent = `${what} at ${String(e.time).replace("T"," ").replace("Z"," UTC")} · roll ${(+e.roll).toFixed(1)}°, pitch ${(+e.pitch).toFixed(1)}°`;
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
    map.flyTo([e.lat, e.lng], 14, { duration: 0.8 });
    const mk = eventMarkers.get(e.id); mk && setTimeout(() => mk.openPopup(), 850);
  });

  function exportCsv() {
    const cols = ["id","type","time_utc","duration_s","peak","unit","force_N","roll_deg","pitch_deg","threshold","lat","lng","gps_fix","time_source","received_local"];
    const rows = [...events.values()].sort((a,b) => (a.epoch||0)-(b.epoch||0)).map((e) => [
      e.id, e.type, e.time,
      e.type==="SHOCK"?"":e.phase==="start"?"ongoing":(e.dur/1000).toFixed(2),
      e.peak, e.type==="SHOCK"?"g":"deg",
      e.type==="SHOCK"?(cargoWeight*9.81*e.peak).toFixed(0):"",
      e.roll, e.pitch, e.thr, e.lat, e.lng, e.fix, e.tsrc, e.received,
    ]);
    const csv = [cols,...rows].map((r) => r.map((v) => `"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `incident-log-${new Date().toISOString().slice(0,19).replace(/:/g,"")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ── map ── */
  let map = null, shipMarker = null, track = null, lastTrackPt = null, lastMapUpdate = 0;
  let originMarker = null, destMarker = null, routeLine = null;
  const eventMarkers = new Map();

  function initMap() {
    if (typeof L === "undefined") { $("map").innerHTML = '<div class="empty">Map library failed to load.</div>'; return; }
    map = L.map("map", { zoomControl: true, attributionControl: true }).setView([13.04, 77.62], 11);
    const esri = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
    const attr = "Tiles &copy; Esri";
    const dark = L.layerGroup([
      L.tileLayer(esri("Canvas/World_Dark_Gray_Base"),      { maxZoom: 16, attribution: attr }),
      L.tileLayer(esri("Canvas/World_Dark_Gray_Reference"), { maxZoom: 16 }),
    ]).addTo(map);
    const sat = L.layerGroup([
      L.tileLayer(esri("World_Imagery"),                               { maxZoom: 18, attribution: attr }),
      L.tileLayer(esri("Reference/World_Boundaries_and_Places"),       { maxZoom: 18 }),
    ]);
    L.control.layers({ "Dark": dark, "Satellite": sat }, null, { position: "bottomleft" }).addTo(map);

    // route dashed line
    routeLine = L.polyline(
      [[ORIGIN.lat, ORIGIN.lng], [DEST.lat, DEST.lng]],
      { color: "#3aa0ff", weight: 2, opacity: 0.5, dashArray: "8 6" }
    ).addTo(map);

    // origin / destination markers
    originMarker = L.marker([ORIGIN.lat, ORIGIN.lng], {
      icon: L.divIcon({ className: "", html: '<div class="origin-marker"></div>', iconSize: [14,14], iconAnchor: [7,7] })
    }).bindPopup(`<b>DISPATCH</b><br>${ORIGIN.name}`).addTo(map);

    destMarker = L.marker([DEST.lat, DEST.lng], {
      icon: L.divIcon({ className: "", html: '<div class="dest-marker"></div>', iconSize: [14,14], iconAnchor: [7,7] })
    }).bindPopup(`<b>DELIVERY</b><br>${DEST.name}`).addTo(map);

    // live track
    track = L.polyline([], { color: "#3aa0ff", weight: 3, opacity: 0.85 }).addTo(map);

    // ship marker
    shipMarker = L.marker([0, 0], { icon: L.divIcon({ className: "", html: '<div class="ship-marker"></div>', iconSize: [18,18], iconAnchor: [9,9] }) });

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
    const speedKmh = typeof m.spd === "number" ? (m.spd * 1.852).toFixed(1) : "?";
    $("pos").textContent = `${m.lat.toFixed(5)}, ${m.lng.toFixed(5)} · ${(m.crs ?? 0).toFixed(0)}° · ${speedKmh} km/h`;
    if (!map.hasLayer(shipMarker)) { shipMarker.addTo(map); map.setView(ll, 12); }
    shipMarker.setLatLng(ll);
    if (!lastTrackPt || Math.hypot(ll[0]-lastTrackPt[0], ll[1]-lastTrackPt[1]) > 0.00005) {
      track.addLatLng(ll); lastTrackPt = ll;
      const pts = track.getLatLngs(); if (pts.length > 5000) track.setLatLngs(pts.slice(-4000));
    }
    if (follow) map.panTo(ll, { animate: true, duration: 0.8 });
  }

  function addEventMarker(e) {
    if (!map || !e.fix) return;
    const html = `<b>${esc(e.type)}</b> · ${e.type==="SHOCK"?e.peak.toFixed(2)+" g":e.peak.toFixed(1)+"°"}<br>${esc(e.time)}<br>` +
      (e.type==="TILT"?`Duration: ${e.phase==="start"?"ongoing":(e.dur/1000).toFixed(1)+" s"}<br>`:"") +
      `${(+e.lat).toFixed(5)}, ${(+e.lng).toFixed(5)}`;
    let mk = eventMarkers.get(e.id);
    if (!mk) {
      mk = L.marker([e.lat, e.lng], { icon: L.divIcon({ className: "", html: `<div class="ev-marker ${esc(e.type)}"></div>`, iconSize: [12,12], iconAnchor: [6,6] }) }).addTo(map);
      eventMarkers.set(e.id, mk);
    }
    mk.bindPopup(html);
  }

  /* ── chart ── */
  let chartDirty = true;
  const cv = $("chart"), cx = cv.getContext("2d");
  function drawChart() {
    requestAnimationFrame(drawChart);
    if (!chartDirty) return;
    chartDirty = false;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w*dpr || cv.height !== h*dpr) { cv.width = w*dpr; cv.height = h*dpr; }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, w, h);
    const pad = { l:34, r:6, t:6, b:16 };
    const maxAbs = Math.max(45, threshold+10, ...hist.tilt.map(Math.abs), ...hist.roll.map(Math.abs), ...hist.pitch.map(Math.abs));
    const ymax = Math.ceil(maxAbs / 15) * 15;
    const now = performance.now() / 1000;
    const X = (t) => pad.l + ((t-(now-30))/30)*(w-pad.l-pad.r);
    const Y = (v) => pad.t + (1-(v+ymax)/(2*ymax))*(h-pad.t-pad.b);
    cx.font = "10px Consolas, monospace"; cx.fillStyle = "#7d8ea5"; cx.strokeStyle = "#1d2a3d"; cx.lineWidth = 1;
    for (let v = -ymax; v <= ymax; v += ymax/3) {
      cx.beginPath(); cx.moveTo(pad.l, Y(v)); cx.lineTo(w-pad.r, Y(v)); cx.stroke();
      cx.fillText(`${Math.round(v)}°`, 2, Y(v)+3);
    }
    for (let s = 0; s <= 30; s += 10) cx.fillText(`-${30-s}s`, X(now-30+s)-10, h-3);
    cx.setLineDash([4,3]); cx.strokeStyle = "#ff4d5e";
    [threshold,-threshold].forEach((v) => { cx.beginPath(); cx.moveTo(pad.l, Y(v)); cx.lineTo(w-pad.r, Y(v)); cx.stroke(); });
    cx.setLineDash([]);
    const css = getComputedStyle(document.documentElement);
    const series = [["roll",css.getPropertyValue("--c-roll")],["pitch",css.getPropertyValue("--c-pitch")],["tilt",css.getPropertyValue("--c-tilt")]];
    series.forEach(([k, col]) => {
      const arr = hist[k]; if (arr.length < 2) return;
      cx.strokeStyle = col.trim(); cx.lineWidth = k === "tilt" ? 2.2 : 1.4;
      cx.beginPath();
      arr.forEach((v, i) => { const x=X(hist.t[i]), y=Y(v); i ? cx.lineTo(x,y) : cx.moveTo(x,y); });
      cx.stroke();
    });
  }
  setInterval(() => (chartDirty = true), 100);

  /* ── sound ── */
  let actx = null;
  function beep(freq) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((d, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = "square"; o.frequency.value = i ? freq*1.25 : freq;
        g.gain.setValueAtTime(0.0001, actx.currentTime+d);
        g.gain.exponentialRampToValueAtTime(0.12, actx.currentTime+d+0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime+d+0.16);
        o.connect(g).connect(actx.destination); o.start(actx.currentTime+d); o.stop(actx.currentTime+d+0.17);
      });
    } catch { }
  }

  /* ── console ── */
  const logLines = [];
  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logLines.push(line); if (logLines.length > 300) logLines.shift();
    $("consoleLog").textContent = logLines.join("\n");
    $("consoleLog").scrollTop = 1e9;
    $("consoleLast").textContent = String(msg).slice(0, 90);
  }

  /* ── UI wiring ── */
  function setThresholdUI(v) {
    threshold = v;
    $("thr").value = v;
    $("thrVal").textContent = v + "°";
    Twin.setThreshold(v);
    chartDirty = true;
  }

  $("thr").addEventListener("input",  (e) => setThresholdUI(+e.target.value));
  $("thr").addEventListener("change", (e) => sendCmd({ cmd: "threshold", value: +e.target.value }));
  $("shock").addEventListener("input",  (e) => { shockThr = +e.target.value; $("shockVal").textContent = shockThr.toFixed(1) + " g"; });
  $("shock").addEventListener("change", (e) => sendCmd({ cmd: "shock", value: +e.target.value }));

  $("cargoWeight").addEventListener("input", (e) => {
    cargoWeight = +e.target.value;
    $("weightVal").textContent = cargoWeight.toLocaleString() + " kg";
    peakForceN = 0; // reset peak when weight changes
    chartDirty = true;
    // re-render table to update force column
    renderEvents();
  });

  $("btnLevel").onclick   = () => { if (!source) return alert("Connect a device first."); sendCmd({ cmd: "level" }); };
  $("btnYaw").onclick     = () => sendCmd({ cmd: "resetYaw" });
  $("btnSound").onclick   = () => { soundOn = !soundOn; $("btnSound").textContent = soundOn ? "🔔 Sound on" : "🔕 Sound off"; if (soundOn) beep(700); };
  $("btnDemo").onclick    = () => (source && source.kind === "demo" ? disconnect() : connect(new DemoSource()));

  $("mqttUrl").value = store.get(LS_MQTT, "ws://localhost:9001");
  $("btnMqtt").onclick = () => {
    let url = $("mqttUrl").value.trim();
    if (!/^wss?:\/\//.test(url)) url = "ws://" + url;
    $("mqttUrl").value = url; store.set(LS_MQTT, url);
    connect(new MqttSource(url));
  };
  $("btnDisconnect").onclick = () => disconnect();

  $("btnDump").onclick = () => { if (!source) return alert("Connect a device first."); sendCmd({ cmd: "dump" }); };
  $("btnCsv").onclick  = exportCsv;
  $("btnClear").onclick = () => {
    if (!confirm("Clear the incident log in this dashboard?\n(Events stored on the device are kept and can be re-loaded with 'Load from device'.)")) return;
    events.clear(); persist(); selectedId = null; integrityScore = 100; renderEvents();
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

  const optMap = { optInvRoll:"invRoll", optInvPitch:"invPitch", optInvYaw:"invYaw", optSwap:"swap", optNoYaw:"noYaw" };
  Object.entries(optMap).forEach(([id, k]) => {
    $(id).checked = opts[k];
    $(id).onchange = () => { opts[k] = $(id).checked; store.set(LS_OPTS, opts); };
  });
  $("btnSettings").onclick = () => $("settings").showModal();

  /* ── boot ── */
  Twin.init($("twin"));
  setThresholdUI(threshold);
  initMap();
  renderEvents();
  drawChart();
  log("Dashboard ready. Click MQTT to connect to your local broker, or Demo to simulate.");
  if (new URLSearchParams(location.search).has("demo")) connect(new DemoSource());
})();
