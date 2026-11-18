# CargoTwin: Shipment Tracker with a Digital Twin

ESP32 + MPU6050 + NEO-6M GPS. The device tracks a cargo container's tilt, shocks and position.
Every time the tilt goes over the threshold (or a shock is detected), it logs the event
with a **UTC timestamp + GPS position**. The dashboard shows a **live 3D digital twin** of the
container that moves exactly like the real box.

```
esp_program/final.ino   <- ESP32 firmware (publishes telemetry over MQTT)
app.py                  <- Flask + MQTT backend, stores telemetry in SQLite (shipment.db)
client/index.html       <- 3D digital-twin dashboard (live MQTT over WebSocket)
mosquitto.conf          <- broker config: TCP 1883 for the ESP32, WebSocket 9001 for the dashboard
```

## Architecture

```
ESP32 ──MQTT/TCP :1883──▶ Mosquitto ──MQTT/WS :9001──▶ client/ (3D twin, incident log, map)
                              │
                              └──MQTT/TCP :1883──▶ app.py ──▶ shipment.db ──▶ http://localhost:5000
```

The ESP32 publishes to `shipment/<DEVICE_ID>/<topic>`:

| Topic | Payload |
|---|---|
| `shipment/CONT-001/telemetry` | `{"t":"d", roll, pitch, yaw, tilt, ax, ay, az, g, temp, lat, lng, fix, sats, spd, crs, alarm, thr, time}` at 20 Hz |
| `shipment/CONT-001/events` | `{"t":"e", id, type:"TILT"\|"SHOCK", phase:"start"\|"end"\|"instant", time, epoch, dur, peak, roll, pitch, lat, lng, fix, tsrc}` |
| `shipment/CONT-001/config` | `{"t":"cfg", id, thr, shock, mpu, fs, tsrc}` |
| `shipment/CONT-001/log` | `{"t":"log", msg}` |

The device subscribes to `shipment/CONT-001/cmd` for commands such as
`{"cmd":"threshold","value":25}`, `{"cmd":"shock","value":2.5}`, `{"cmd":"level"}`,
`{"cmd":"resetYaw"}`, `{"cmd":"time","epoch":1731300000}`, `{"cmd":"dump"}`, `{"cmd":"clear"}`, and `{"cmd":"hello"}`.

---

## 1. Wiring

| MPU6050 | ESP32  |     | NEO-6M GPS | ESP32           |
|---------|--------|-----|------------|-----------------|
| VCC     | 3V3    |     | VCC        | 3V3 (or VIN/5V, check your module) |
| GND     | GND    |     | GND        | GND             |
| SDA     | GPIO21 |     | TX         | GPIO16 (RX2)    |
| SCL     | GPIO22 |     | RX         | GPIO17 (TX2)    |

**Mounting:** fix the MPU6050 flat, with its **X arrow pointing along the container's
length, toward the doors**. If it's mounted another way, fix the direction in the dashboard
under ⚙ Settings (no re-flashing needed).

## 2. Start the MQTT broker

Install [Mosquitto](https://mosquitto.org/download/), then from the repo root:

```bash
mosquitto -c mosquitto.conf -v
```

To watch the raw traffic in a second terminal:

```bash
mosquitto_sub -h localhost -p 1883 -t "shipment/#" -v
```

## 3. Flash the ESP32

1. Arduino IDE → Boards Manager → install **"esp32" by Espressif**. Board: **ESP32 Dev Module**.
2. Library Manager → install **TinyGPSPlus** (Mikal Hart) and **PubSubClient** (Nick O'Leary).
3. Open `esp_program/final.ino` and set:
   - `WIFI_SSID` / `WIFI_PASS` to the network your laptop is on
   - `MQTT_BROKER_IP` to your laptop's local IP address (`ipconfig` on Windows, `ip a` on Linux)
4. Upload. **Keep the box still for ~2 s after power-on** while the gyro calibrates.

Serial Monitor at **115200** shows the same JSON lines the device publishes.

## 4. Run the backend (optional, for logging and history)

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000 for the recorded history: tilt and g-force charts, the GPS route, and the most recent 200 records.

## 5. Run the dashboard

Open `client/index.html` in Chrome or Edge. Then pick one:

| Button   | When to use |
|----------|-------------|
| **▶ Demo** | No hardware. Simulated voyage out of Singapore with rolling, heavy-roll and shock events. |
| **MQTT** | Connects to the broker at `ws://localhost:9001` (editable) and shows the live device. |

The dashboard loads MQTT.js from a CDN, so the first load needs internet access.

## Before the demo

1. Place the box on a level surface and click **Set level**. That position becomes 0°.
2. Click **Reset yaw**. Yaw comes from the gyro only, so it drifts slowly; ⚙ → "Ignore yaw" turns it off.
3. Tilt the box. The 3D container should move the same way. If roll or pitch moves the wrong way, use ⚙ Settings → Invert / Swap.
4. Tip it past the threshold (default 30°). You should see a red alert, a beep, and a new row in the Incident Log.
5. Tap or drop it lightly. That triggers a **SHOCK** event (default > 2 g).

> **Note:** in the MQTT setup, the dashboard is receive-only for now. Threshold sliders and
> device buttons don't reach the ESP32 yet. To send a command by hand:
> `mosquitto_pub -h localhost -t shipment/CONT-001/cmd -m '{"cmd":"threshold","value":25}'`

## Features

- **Digital twin**: a 3D 20 ft container at real dimensions, rotated live from the MPU. It also shows a "level" ghost outline,
  the tilt-limit cone (the green up-vector leaving the cone means an alarm), and the container flashes red during an alarm.
- **Event detection on the device**: debounced TILT events (start + end, with duration and peak angle) and SHOCK events,
  saved to the ESP32's flash (LittleFS) so they survive power loss.
- **Timestamps**: GPS UTC time, or synced time when the GPS has no fix. The `tsrc` field says which one was used.
- **Incident replay**: click any incident and a red ghost container appears on the 3D twin in the exact position the box was in at that moment. The map also jumps to where it happened.
- **Integrity summary**: Intact / Inspect cargo / Likely damaged (tilt of 60° or more, or a shock of 4 g or more), plus max tilt and max shock. Use **Export CSV** for the report.
- **Persistent history**: `app.py` stores every telemetry packet in SQLite (WAL mode) and serves charts and a route map.
- **Full screen** button on the 3D view, for projectors.

## Troubleshooting

| Problem | Fix |
|---|---|
| Console says "MPU6050 not found" | Check SDA→21, SCL→22, 3V3, GND. The device retries every 3 s. |
| ESP32 never connects to MQTT | Check that `MQTT_BROKER_IP` is the laptop's current IP, that both are on the same network, and that the firewall allows port 1883. |
| Dashboard says "MQTT error" | Make sure Mosquitto was started with `mosquitto.conf`. The default config has no WebSocket listener on 9001. |
| GPS shows "no fix" | Normal indoors. Take it near a window or outside. The first fix can take 1–5 min. |
| 3D box moves the wrong way | ⚙ Settings → invert or swap axes. |
| Dashboard and container disagree when at rest | Click **Set level** with the box sitting flat. |
