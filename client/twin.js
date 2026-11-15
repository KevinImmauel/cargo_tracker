/* ============================================================================
 *  Digital Twin — 3D ISO 20ft shipping container driven by MPU6050 orientation
 *  Axis convention (matches firmware):
 *    sensor X = container length (door end = +X)
 *    sensor Z = up
 *    roll  = rotation about the long axis   (right-hand about +X)
 *    pitch = door end up is positive
 *    yaw   = rotation about vertical axis
 *  three.js: Y is up, so sensor Z -> three Y, sensor Y -> three -Z.
 * ==========================================================================*/
(function () {
  const L = 6.06, H = 2.59, W = 2.44;          // real 20ft container dimensions (m)
  const BODY = "#b8482c", FRAME = "#7a2e1c";
  const ARROW_LEN = 3.4;

  let renderer, scene, camera, controls, el;
  let pivot, container, bodyMats = [], ring, cone, coneMat, ringMat, ocean, oceanBase;
  let targetQ = new THREE.Quaternion();
  let incident = null;
  let thresholdDeg = 30, alarm = false, deviceId = "CONT-001";
  let clock = new THREE.Clock();

  /* ---------------- textures (procedural canvas) ---------------- */
  function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

  function drawRibs(ctx, w, h, ribs, base, hl, sh) {
    ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
    const rw = w / ribs;
    for (let i = 0; i < ribs; i++) {
      const g = ctx.createLinearGradient(i * rw, 0, (i + 1) * rw, 0);
      g.addColorStop(0, sh); g.addColorStop(0.25, base); g.addColorStop(0.5, hl);
      g.addColorStop(0.75, base); g.addColorStop(1, sh);
      ctx.fillStyle = g; ctx.fillRect(i * rw, 0, rw + 1, h);
    }
  }

  function sideTexture(withText, ribs) {
    const c = canvas(1024, 440), x = c.getContext("2d");
    drawRibs(x, c.width, c.height, ribs, BODY, "#d0644a", "#7d2c18");
    // weathering
    for (let i = 0; i < 260; i++) {
      x.fillStyle = `rgba(40,15,8,${Math.random() * 0.08})`;
      x.fillRect(Math.random() * c.width, Math.random() * c.height, 2 + Math.random() * 20, 1 + Math.random() * 5);
    }
    if (withText) {
      x.fillStyle = "rgba(255,255,255,.92)";
      x.font = "bold 64px Segoe UI, Arial"; x.fillText("CARGOTWIN", 60, 110);
      x.font = "bold 44px Consolas, monospace"; x.fillText(deviceId, 62, 170);
      x.font = "22px Consolas, monospace";
      x.fillText("22G1  ·  IoT MONITORED", 64, 210);
    }
    const t = new THREE.CanvasTexture(c); t.anisotropy = 8; t.encoding = THREE.sRGBEncoding; return t;
  }

  function bumpTexture(ribs) {
    const c = canvas(1024, 64), x = c.getContext("2d");
    drawRibs(x, c.width, c.height, ribs, "#808080", "#ffffff", "#000000");
    return new THREE.CanvasTexture(c);
  }

  function doorTexture() {
    const c = canvas(512, 544), x = c.getContext("2d");
    drawRibs(x, c.width, c.height, 14, BODY, "#cf6248", "#7d2c18");
    x.strokeStyle = "#5c2213"; x.lineWidth = 6;
    x.strokeRect(10, 10, c.width - 20, c.height - 20);
    x.beginPath(); x.moveTo(c.width / 2, 10); x.lineTo(c.width / 2, c.height - 10); x.stroke();
    x.fillStyle = "rgba(255,255,255,.9)";
    x.font = "bold 34px Consolas, monospace"; x.fillText(deviceId, 290, 70);
    x.font = "18px Consolas, monospace";
    ["MAX GROSS 30,480 KG", "TARE       2,200 KG", "NET       28,280 KG", "CU.CAP     33.2 M3"].forEach((s, i) =>
      x.fillText(s, 290, 110 + i * 26));
    // warning sticker
    x.fillStyle = "#f5c518"; x.fillRect(40, 60, 90, 90);
    x.fillStyle = "#111"; x.font = "bold 16px Segoe UI"; x.fillText("TILT", 62, 100); x.fillText("SENSOR", 52, 122);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 8; t.encoding = THREE.sRGBEncoding; return t;
  }

  function roofTexture() {
    const c = canvas(1024, 256), x = c.getContext("2d");
    drawRibs(x, c.width, c.height, 30, "#a3412a", "#bb5640", "#8a3420");
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }

  /* ---------------- container model ---------------- */
  function buildContainer() {
    const g = new THREE.Group();
    const std = (o) => new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.6, metalness: 0.35 }, o));

    const sideBump = bumpTexture(36), endBump = bumpTexture(10);
    bodyMats = [
      std({ map: doorTexture(), bumpMap: bumpTexture(14), bumpScale: 0.03 }),  // +X doors
      std({ map: sideTexture(false, 10), bumpMap: endBump, bumpScale: 0.03 }), // -X front wall
      std({ map: roofTexture() }),                                              // +Y roof
      std({ color: "#3a1a10" }),                                                // -Y floor
      std({ map: sideTexture(true, 36), bumpMap: sideBump, bumpScale: 0.03 }), // +Z side
      std({ map: sideTexture(true, 36), bumpMap: sideBump, bumpScale: 0.03 }), // -Z side
    ];
    bodyMats.forEach((m) => { m.emissive = new THREE.Color("#ff1e2e"); m.emissiveIntensity = 0; });
    const body = new THREE.Mesh(new THREE.BoxGeometry(L - 0.06, H - 0.06, W - 0.06), bodyMats);
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);

    // steel frame: corner posts + rails + corner castings
    const frameMat = std({ color: FRAME, roughness: 0.5, metalness: 0.5 });
    const castMat = std({ color: "#2b2b2b", roughness: 0.4, metalness: 0.8 });
    const p = 0.16;
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); };
    const post = new THREE.BoxGeometry(p, H, p);
    const railL = new THREE.BoxGeometry(L, p, p);
    const railW = new THREE.BoxGeometry(p, p, W);
    const cast = new THREE.BoxGeometry(0.2, 0.14, 0.2);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(post, frameMat, sx * (L - p) / 2, 0, sz * (W - p) / 2);
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) add(railL, frameMat, 0, sy * (H - p) / 2, sz * (W - p) / 2);
      for (const sx of [-1, 1]) add(railW, frameMat, sx * (L - p) / 2, sy * (H - p) / 2, 0);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(cast, castMat, sx * (L - 0.1) / 2, sy * (H - 0.07) / 2, sz * (W - 0.1) / 2);
    }
    // door locking bars
    const rodMat = std({ color: "#c9c9c9", metalness: 0.9, roughness: 0.3 });
    const rod = new THREE.CylinderGeometry(0.025, 0.025, H - 0.25, 10);
    const handle = new THREE.BoxGeometry(0.05, 0.05, 0.28);
    [-0.85, -0.35, 0.35, 0.85].forEach((z) => {
      add(rod, rodMat, L / 2 + 0.03, 0, z * W / 2 * 0.95);
      add(handle, rodMat, L / 2 + 0.06, -0.3, z * W / 2 * 0.95 + (z < 0 ? 0.12 : -0.12));
    });
    // IoT tracker box on the front wall (where the ESP32 lives)
    const dev = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.46), std({ color: "#20262e", metalness: 0.2 }));
    dev.position.set(-L / 2 - 0.02, 0.6, 0); g.add(dev);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 12), new THREE.MeshBasicMaterial({ color: "#2ecc8f" }));
    led.position.set(-L / 2 - 0.06, 0.68, 0.14); g.add(led); g.userData.led = led;
    return g;
  }

  /* ---------------- incident replay ghost ---------------- */
  function buildIncidentGhost() {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(L, H, W),
      new THREE.MeshBasicMaterial({ color: "#ff4d5e", transparent: true, opacity: 0.16, depthWrite: false })));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)),
      new THREE.LineBasicMaterial({ color: "#ff4d5e", transparent: true, opacity: 0.95 })));
    g.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), ARROW_LEN, 0xff4d5e, 0.35, 0.2));
    g.visible = false;
    return g;
  }

  /* ---------------- reference helpers ---------------- */
  function buildThresholdIndicator() {
    const grp = new THREE.Group();
    ringMat = new THREE.LineBasicMaterial({ color: "#f5b142", transparent: true, opacity: 0.9 });
    coneMat = new THREE.MeshBasicMaterial({ color: "#f5b142", transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
    ring = new THREE.LineLoop(new THREE.BufferGeometry(), ringMat);
    cone = new THREE.Mesh(new THREE.BufferGeometry(), coneMat);
    grp.add(ring, cone);
    // world-up dashed line
    const upGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, ARROW_LEN + 0.4, 0)]);
    const up = new THREE.Line(upGeo, new THREE.LineDashedMaterial({ color: "#8fb7e8", dashSize: 0.15, gapSize: 0.1, transparent: true, opacity: 0.6 }));
    up.computeLineDistances();
    grp.add(up);
    return grp;
  }

  function updateThresholdGeometry() {
    const a = THREE.MathUtils.degToRad(Math.min(thresholdDeg, 89));
    const r = ARROW_LEN * Math.sin(a), y = ARROW_LEN * Math.cos(a);
    const pts = [];
    for (let i = 0; i < 96; i++) { const t = (i / 96) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r)); }
    ring.geometry.dispose(); ring.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    cone.geometry.dispose();
    const cg = new THREE.ConeGeometry(r, y, 64, 1, true);
    cg.rotateX(Math.PI); cg.translate(0, y / 2, 0);
    cone.geometry = cg;
  }

  function buildOcean() {
    const geo = new THREE.PlaneGeometry(260, 260, 120, 120);
    geo.rotateX(-Math.PI / 2);
    oceanBase = geo.attributes.position.array.slice();
    const mat = new THREE.MeshStandardMaterial({ color: "#041a2e", roughness: 0.85, metalness: 0.0, flatShading: true });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = -4.2;
    return m;
  }

  function animateOcean(t) {
    const pos = ocean.geometry.attributes.position, a = pos.array;
    for (let i = 0; i < a.length; i += 3) {
      const x = oceanBase[i], z = oceanBase[i + 2];
      a[i + 1] = Math.sin(x * 0.12 + t * 0.9) * 0.35 + Math.cos(z * 0.09 + t * 0.7) * 0.3 + Math.sin((x + z) * 0.2 + t * 1.6) * 0.12;
    }
    pos.needsUpdate = true;
    ocean.geometry.computeVertexNormals();
  }

  /* ---------------- public API ---------------- */
  function init(element) {
    el = element;
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.prepend(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color("#0c1a2a");
    scene.fog = new THREE.Fog("#0c1a2a", 30, 110);

    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    camera.position.set(9, 5.5, 10);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.3, 0);
    controls.minDistance = 5; controls.maxDistance = 30;
    controls.maxPolarAngle = Math.PI * 0.58;
    controls.autoRotateSpeed = 0.8;

    scene.add(new THREE.HemisphereLight("#cfe3ff", "#0b1a2a", 0.75));
    const sun = new THREE.DirectionalLight("#fff4e0", 1.3);
    sun.position.set(8, 14, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 40 });
    scene.add(sun);
    const rim = new THREE.DirectionalLight("#5aa8ff", 0.6);
    rim.position.set(-10, 4, -8);
    scene.add(rim);

    // holographic floor
    const grid = new THREE.GridHelper(24, 24, "#2f6fb0", "#1a3350");
    grid.position.y = -2.4; grid.material.transparent = true; grid.material.opacity = 0.55;
    scene.add(grid);
    const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.ShadowMaterial({ opacity: 0.35 }));
    shadowFloor.rotation.x = -Math.PI / 2; shadowFloor.position.y = -2.39; shadowFloor.receiveShadow = true;
    scene.add(shadowFloor);

    ocean = buildOcean();
    scene.add(ocean);

    // static "level" ghost outline
    const ghost = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)),
      new THREE.LineBasicMaterial({ color: "#8fb7e8", transparent: true, opacity: 0.35 })
    );
    scene.add(ghost);

    scene.add(buildThresholdIndicator());
    updateThresholdGeometry();

    pivot = new THREE.Group();
    container = buildContainer();
    pivot.add(container);
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), ARROW_LEN, 0x2ecc8f, 0.35, 0.2);
    pivot.add(arrow);
    pivot.userData.arrow = arrow;
    scene.add(pivot);
    incident = buildIncidentGhost();
    scene.add(incident);

    new ResizeObserver(resize).observe(el);
    resize();
    renderer.setAnimationLoop(frame);
  }

  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
    pivot.quaternion.slerp(targetQ, 1 - Math.exp(-dt * 14));
    animateOcean(t);

    // alarm visuals
    const pulse = alarm ? 0.35 + 0.35 * Math.sin(t * 8) : 0;
    bodyMats.forEach((m) => (m.emissiveIntensity = pulse));
    ringMat.color.set(alarm ? "#ff4d5e" : "#f5b142");
    coneMat.color.set(alarm ? "#ff4d5e" : "#f5b142");
    coneMat.opacity = alarm ? 0.12 + 0.06 * Math.sin(t * 8) : 0.07;
    pivot.userData.arrow.setColor(new THREE.Color(alarm ? 0xff4d5e : 0x2ecc8f));
    container.userData.led.material.color.set(alarm ? (Math.sin(t * 12) > 0 ? "#ff4d5e" : "#330000") : "#2ecc8f");

    controls.update();
    renderer.render(scene, camera);
  }

  const DEG = Math.PI / 180;
  function setOrientation(rollDeg, pitchDeg, yawDeg) {
    const e = new THREE.Euler(rollDeg * DEG, yawDeg * DEG, pitchDeg * DEG, "YZX");
    targetQ.setFromEuler(e);
  }

  function setThreshold(deg) { if (deg !== thresholdDeg) { thresholdDeg = deg; updateThresholdGeometry(); } }
  function setAlarm(on) { alarm = !!on; }

  function setId(id) {
    if (!id || id === deviceId || !bodyMats.length) return;
    deviceId = id;
    const swap = (i, tex) => { bodyMats[i].map.dispose(); bodyMats[i].map = tex; bodyMats[i].needsUpdate = true; };
    swap(0, doorTexture()); swap(4, sideTexture(true, 36)); swap(5, sideTexture(true, 36));
  }

  const VIEWS = { iso: [9, 5.5, 10], side: [0, 1.5, 13], front: [13, 1.5, 0], top: [0.01, 15, 0.01] };
  function setView(name) {
    const v = VIEWS[name]; if (!v) return;
    const from = camera.position.clone(), to = new THREE.Vector3(...v);
    const start = performance.now();
    (function step(now) {
      const k = Math.min((now - start) / 600, 1), e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(from, to, e);
      if (k < 1) requestAnimationFrame(step);
    })(start);
  }
  function setIncident(rollDeg, pitchDeg, yawDeg) {
    incident.quaternion.setFromEuler(new THREE.Euler(rollDeg * DEG, yawDeg * DEG, pitchDeg * DEG, "YZX"));
    incident.visible = true;
  }
  function clearIncident() { if (incident) incident.visible = false; }
  function toggleOrbit() { controls.autoRotate = !controls.autoRotate; return controls.autoRotate; }

  window.Twin = { init, setOrientation, setThreshold, setAlarm, setId, setView, toggleOrbit, setIncident, clearIncident };
})();
