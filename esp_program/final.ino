/*
- ============================================================================
-  SHIPMENT TRACKER (MQTT Version) - ESP32 + MPU6050 + NEO-6M GPS
- ============================================================================
-  - Fuses accelerometer + gyroscope (complementary filter) -> roll / pitch / yaw
-  - Computes total tilt from vertical, detects TILT events above threshold
-    and SHOCK events (sudden g-force spikes)
-  - Timestamps every event with GPS UTC time (or synced time) & GPS position
-  - Saves every event to flash (LittleFS)
-  - Streams JSON telemetry at 20 Hz over:
- USB Serial (115200 baud)
- MQTT Broker running on your laptop
- ============================================================================
 */

#include <Wire.h>
#include <math.h>
#include <LittleFS.h>
#include <TinyGPSPlus.h>
#include <WiFi.h>
#include <PubSubClient.h>

// forward declarations
#define MQTT_MAX_PACKET_SIZE 512
void logInfo(const char *msg);
void broadcast(const char *topicSuffix, const char *line);

// ----------------------------- USER SETTINGS --------------------------------
// Wi-Fi credentials (must be the same network your laptop's MQTT broker is on)
const char *WIFI_SSID = "kevin_EXT";
const char *WIFI_PASS = "air41094";

// MQTT Laptop Broker Settings
const char *MQTT_BROKER_IP = "192.168.1.8"; // <-- CHANGE THIS to your laptop's local IP address
const uint16_t MQTT_PORT = 1883;               // Standard MQTT port

const char *DEVICE_ID = "CONT-001";     // container ID shown on dashboard/broker

float tiltThresholdDeg = 30.0f;          
float shockThresholdG  = 2.0f;           
const float TILT_HYSTERESIS = 3.0f;      
const uint32_t TILT_DEBOUNCE_MS = 250;   
const uint32_t SHOCK_COOLDOWN_MS = 1000;

const int I2C_SDA = 21, I2C_SCL = 22;
const int GPS_RX = 16, GPS_TX = 17;      
const uint32_t GPS_BAUD = 9600;

const uint32_t SAMPLE_INTERVAL_MS = 10;  
const uint32_t TELEMETRY_INTERVAL_MS = 50; 
const float COMP_ALPHA = 0.98f;          
// -----------------------------------------------------------------------------

WiFiClient espClient;
PubSubClient mqttClient(espClient);

TinyGPSPlus gps;
HardwareSerial GPSSerial(2);

// ----------------------------- MPU6050 (raw I2C) ----------------------------
const uint8_t MPU_ADDR = 0x68;
bool mpuOk = false;
float gyroBiasX = 0, gyroBiasY = 0, gyroBiasZ = 0;

float ax, ay, az, gx, gy, gz, tempC; 
float roll = 0, pitch = 0, yaw = 0;   
float rollZero = 0, pitchZero = 0;    
float tiltDeg = 0, gTotal = 1;

void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool mpuReadRaw(int16_t *out7) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, 14) != 14) return false;
  for (int i = 0; i < 7; i++) {
    int16_t hi = Wire.read();
    int16_t lo = Wire.read();
    out7[i] = (hi << 8) | lo;
  }
  return true;
}

bool mpuInit() {
  Wire.beginTransmission(MPU_ADDR);
  if (Wire.endTransmission() != 0) return false;
  mpuWrite(0x6B, 0x00); 
  delay(100);
  mpuWrite(0x1A, 0x03); 
  mpuWrite(0x1B, 0x00); 
  mpuWrite(0x1C, 0x00); 
  return true;
}

bool mpuRead() {
  int16_t r[7];
  if (!mpuReadRaw(r)) return false;
  ax = (float)r[0] / 16384.0f;
  ay = (float)r[1] / 16384.0f;
  az = (float)r[2] / 16384.0f;
  tempC = (r[3] / 340.0f) + 36.53f;
  gx = ((float)r[4] / 131.0f) - gyroBiasX;
  gy = ((float)r[5] / 131.0f) - gyroBiasY;
  gz = ((float)r[6] / 131.0f) - gyroBiasZ;
  return true;
}

void calibrateGyro() {
  logInfo("Calibrating gyro - keep the box still...");
  float sx = 0, sy = 0, sz = 0;
  int n = 0;
  int16_t r[7];
  for (int i = 0; i < 300; i++) {
    if (mpuReadRaw(r)) {
      sx += (float)r[4] / 131.0f; 
      sy += (float)r[5] / 131.0f; 
      sz += (float)r[6] / 131.0f; 
      n++;
    }
    delay(3);
  }
  if (n > 0) { 
    gyroBiasX = sx / n; 
    gyroBiasY = sy / n; 
    gyroBiasZ = sz / n; 
  }
}

// ----------------------------- TIME -----------------------------------------
uint32_t epochAtSync = 0;
uint32_t millisAtSync = 0;
const char *timeSource = "none";

int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return (int64_t)era * 146097 + (int64_t)doe - 719468;
}

void civilFromDays(int64_t z, int &y, unsigned &m, unsigned &d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = (unsigned)(z - era * 146097);
  const unsigned yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
  const unsigned doy = doe - (365*yoe + yoe/4 - yoe/100);
  const unsigned mp = (5*doy + 2)/153;
  d = doy - (153*mp+2)/5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  y = (int)(yoe + era * 400) + (m <= 2);
}

uint32_t nowEpoch() {
  if (epochAtSync == 0) return 0;
  return epochAtSync + (millis() - millisAtSync) / 1000;
}

void formatTime(uint32_t epoch, char *buf, size_t len) {
  if (epoch == 0) { snprintf(buf, len, "T+%lus", (unsigned long)(millis() / 1000)); return; }
  int64_t days = epoch / 86400;
  uint32_t secs = epoch % 86400;
  int y; unsigned m, d;
  civilFromDays(days, y, m, d);
  snprintf(buf, len, "%04d-%02u-%02uT%02lu:%02lu:%02luZ", y, m, d,
           (unsigned long)(secs / 3600), (unsigned long)((secs / 60) % 60), (unsigned long)(secs % 60));
}

void syncTimeFromGps() {
  if (!gps.date.isValid() || !gps.time.isValid() || gps.date.year() < 2020) return;
  if (gps.time.age() > 1500) return;
  int64_t days = daysFromCivil(gps.date.year(), gps.date.month(), gps.date.day());
  uint32_t e = (uint32_t)(days * 86400 + gps.time.hour() * 3600 + gps.time.minute() * 60 + gps.time.second());
  epochAtSync = e;
  millisAtSync = millis() - gps.time.age();
  timeSource = "gps";
}

// ----------------------------- MQTT & OUTPUT --------------------------------
void handleCommand(const char *cmd);

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char buf[256];
  if (length >= sizeof(buf)) length = sizeof(buf) - 1;
  memcpy(buf, payload, length);
  buf[length] = '\0';
  handleCommand(buf);
}

void broadcast(const char *topicSuffix, const char *line) {
  Serial.println(line);
  if (mqttClient.connected()) {
    char fullTopic[64];
    snprintf(fullTopic, sizeof(fullTopic), "shipment/%s/%s", DEVICE_ID, topicSuffix);
    mqttClient.publish(fullTopic, line);
  }
}

void logInfo(const char *msg) {
  char buf[200];
  snprintf(buf, sizeof(buf), "{\"t\":\"log\",\"msg\":\"%s\"}", msg);
  broadcast("log", buf);
}

// ----------------------------- EVENT STORAGE --------------------------------
const char *EVENT_FILE = "/events.jsonl";
bool fsOk = false;

void storeEvent(const char *json) {
  if (!fsOk) return;
  File f = LittleFS.open(EVENT_FILE, FILE_APPEND);
  if (!f) return;
  if (f.size() > 200000) { 
    f.close();
    LittleFS.remove("/events_old.jsonl");
    LittleFS.rename(EVENT_FILE, "/events_old.jsonl");
    f = LittleFS.open(EVENT_FILE, FILE_APPEND);
    if (!f) return;
  }
  f.println(json);
  f.close();
}

void dumpEvents() {
  if (!fsOk) { logInfo("Flash storage unavailable"); return; }
  const char *files[2] = {"/events_old.jsonl", EVENT_FILE};
  int count = 0;
  for (int i = 0; i < 2; i++) {
    File f = LittleFS.open(files[i], FILE_READ);
    if (!f) continue;
    while (f.available()) {
      String line = f.readStringUntil('\n');
      line.trim();
      if (line.length() < 5) continue;
      line.replace("{\"t\":\"e\"", "{\"t\":\"e\",\"hist\":1");
      broadcast("events", line.c_str());
      count++;
      delay(2);
    }
    f.close();
  }
  char msg[64];
  snprintf(msg, sizeof(msg), "Sent %d stored events", count);
  logInfo(msg);
}

void clearEvents() {
  if (!fsOk) return;
  LittleFS.remove(EVENT_FILE);
  LittleFS.remove("/events_old.jsonl");
  logInfo("Event log cleared");
}

// ----------------------------- EVENT DETECTION ------------------------------
bool tiltActive = false;
uint32_t tiltAboveSinceMs = 0;
uint32_t tiltStartMs = 0;
uint32_t tiltStartEpoch = 0;
float tiltPeak = 0, tiltPeakRoll = 0, tiltPeakPitch = 0;
uint32_t lastShockMs = 0;
uint32_t eventCounter = 0;

void gpsPos(double &lat, double &lng, int &fix) {
  fix = gps.location.isValid() && gps.location.age() < 5000;
  lat = gps.location.isValid() ? gps.location.lat() : 0;
  lng = gps.location.isValid() ? gps.location.lng() : 0;
}

void emitEvent(const char *type, const char *phase, uint32_t startEpoch, uint32_t durMs,
               float peak, float pRoll, float pPitch, uint32_t id) {
  double lat, lng; int fix;
  gpsPos(lat, lng, fix);
  char ts[32];
  formatTime(startEpoch, ts, sizeof(ts));
  char buf[360];
  snprintf(buf, sizeof(buf),
           "{\"t\":\"e\",\"id\":\"%s-%lu-%lu\",\"type\":\"%s\",\"phase\":\"%s\",\"time\":\"%s\",\"epoch\":%lu,"
           "\"dur\":%lu,\"peak\":%.1f,\"roll\":%.1f,\"pitch\":%.1f,\"thr\":%.1f,"
           "\"lat\":%.6f,\"lng\":%.6f,\"fix\":%d,\"tsrc\":\"%s\"}",
           DEVICE_ID, (unsigned long)startEpoch, (unsigned long)id, type, phase, ts, (unsigned long)startEpoch,
           (unsigned long)durMs, peak, pRoll, pPitch,
           strcmp(type, "SHOCK") == 0 ? shockThresholdG : tiltThresholdDeg,
           lat, lng, fix, timeSource);
  broadcast("events", buf);
  storeEvent(buf);
}

void detectEvents() {
  uint32_t now = millis();

  if (!tiltActive) {
    if (tiltDeg > tiltThresholdDeg) {
      if (tiltAboveSinceMs == 0) tiltAboveSinceMs = now;
      if (now - tiltAboveSinceMs >= TILT_DEBOUNCE_MS) {
        tiltActive = true;
        tiltStartMs = tiltAboveSinceMs;
        tiltStartEpoch = nowEpoch();
        tiltPeak = tiltDeg; tiltPeakRoll = roll; tiltPeakPitch = pitch;
        eventCounter++;
        emitEvent("TILT", "start", tiltStartEpoch, 0, tiltPeak, tiltPeakRoll, tiltPeakPitch, eventCounter);
      }
    } else {
      tiltAboveSinceMs = 0;
    }
  } else {
    if (tiltDeg > tiltPeak) { tiltPeak = tiltDeg; tiltPeakRoll = roll; tiltPeakPitch = pitch; }
    if (tiltDeg < tiltThresholdDeg - TILT_HYSTERESIS) {
      tiltActive = false;
      tiltAboveSinceMs = 0;
      emitEvent("TILT", "end", tiltStartEpoch, now - tiltStartMs, tiltPeak, tiltPeakRoll, tiltPeakPitch, eventCounter);
    }
  }

  if (gTotal > shockThresholdG && now - lastShockMs > SHOCK_COOLDOWN_MS) {
    lastShockMs = now;
    eventCounter++;
    emitEvent("SHOCK", "instant", nowEpoch(), 0, gTotal, roll, pitch, eventCounter);
  }
}

// ----------------------------- COMMANDS -------------------------------------
float jsonNumber(const char *s, const char *key, float def) {
  const char *p = strstr(s, key);
  if (!p) return def;
  p = strchr(p, ':');
  if (!p) return def;
  return atof(p + 1);
}

void sendConfig() {
  char buf[220];
  snprintf(buf, sizeof(buf),
           "{\"t\":\"cfg\",\"id\":\"%s\",\"thr\":%.1f,\"shock\":%.2f,\"mpu\":%d,\"fs\":%d,\"tsrc\":\"%s\"}",
           DEVICE_ID, tiltThresholdDeg, shockThresholdG, mpuOk, fsOk, timeSource);
  broadcast("config", buf);
}

void handleCommand(const char *cmd) {
  if (strstr(cmd, "\"threshold\"")) {
    float v = jsonNumber(cmd, "\"value\"", tiltThresholdDeg);
    if (v >= 1 && v <= 90) tiltThresholdDeg = v;
    sendConfig();
  } else if (strstr(cmd, "\"shock\"")) {
    float v = jsonNumber(cmd, "\"value\"", shockThresholdG);
    if (v >= 1.1f && v <= 8) shockThresholdG = v;
    sendConfig();
  } else if (strstr(cmd, "\"level\"")) {
    rollZero += roll; pitchZero += pitch; roll = 0; pitch = 0;
    logInfo("Level reference set");
  } else if (strstr(cmd, "\"resetYaw\"")) {
    yaw = 0;
  } else if (strstr(cmd, "\"time\"")) {
    if (strcmp(timeSource, "gps") != 0) {
      const char *p = strstr(cmd, "\"epoch\"");
      uint32_t e = p && strchr(p, ':') ? strtoul(strchr(p, ':') + 1, NULL, 10) : 0;
      if (e > 1600000000UL) { epochAtSync = e; millisAtSync = millis(); timeSource = "host"; }
    }
    sendConfig();
  } else if (strstr(cmd, "\"dump\"")) {
    dumpEvents();
  } else if (strstr(cmd, "\"clear\"")) {
    clearEvents();
  } else if (strstr(cmd, "\"hello\"")) {
    sendConfig();
  }
}

char serialBuf[160];
size_t serialLen = 0;

void readSerialCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialLen > 0) { serialBuf[serialLen] = 0; handleCommand(serialBuf); serialLen = 0; }
    } else if (serialLen < sizeof(serialBuf) - 1) {
      serialBuf[serialLen++] = c;
    }
  }
}

void connectWifiAndMqtt() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  
  logInfo("Connecting to Wi-Fi...");
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(500);
  }

  if (WiFi.status() == WL_CONNECTED) {
    logInfo("Wi-Fi connected successfully.");
    mqttClient.setServer(MQTT_BROKER_IP, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);
  } else {
    logInfo("Wi-Fi connection failed.");
  }
}

void checkMqtt() {
  if (WiFi.status() == WL_CONNECTED && !mqttClient.connected()) {
    char clientId[32];
    snprintf(clientId, sizeof(clientId), "ESP32Tracker-%s-%lu", DEVICE_ID, millis());
    
    // Pass 60 seconds as the keep-alive timer instead of default
    if (mqttClient.connect(clientId, NULL, NULL, NULL, 0, 0, NULL, true)) {
      logInfo("Connected to MQTT Broker!");
      char cmdTopic[64];
      snprintf(cmdTopic, sizeof(cmdTopic), "shipment/%s/cmd", DEVICE_ID);
      mqttClient.subscribe(cmdTopic);
      sendConfig();
    } else {
      delay(2000);
    }
  }
}
// ----------------------------- TELEMETRY ------------------------------------
void sendTelemetry() {
  double lat, lng; int fix;
  gpsPos(lat, lng, fix);
  char ts[32];
  formatTime(nowEpoch(), ts, sizeof(ts));
  char buf[512];
  snprintf(buf, sizeof(buf),
           "{\"t\":\"d\",\"id\":\"%s\",\"ms\":%lu,\"time\":\"%s\",\"roll\":%.2f,\"pitch\":%.2f,\"yaw\":%.2f,"
           "\"tilt\":%.2f,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"g\":%.3f,"
           "\"temp\":%.1f,\"lat\":%.6f,\"lng\":%.6f,\"fix\":%d,\"sats\":%d,\"spd\":%.1f,\"crs\":%.1f,"
           "\"alarm\":%d,\"thr\":%.1f,\"mpu\":%d}",
           DEVICE_ID, (unsigned long)millis(), ts, roll, pitch, yaw, tiltDeg, ax, ay, az, gTotal,
           tempC, lat, lng, fix, gps.satellites.isValid() ? (int)gps.satellites.value() : 0,
           gps.speed.isValid() ? gps.speed.knots() : 0.0, gps.course.isValid() ? gps.course.deg() : 0.0,
           tiltActive ? 1 : 0, tiltThresholdDeg, mpuOk ? 1 : 0);
  broadcast("telemetry", buf);
}

// ----------------------------- SETUP / LOOP ---------------------------------
uint32_t lastSampleMs = 0, lastTelemetryMs = 0, lastGpsSyncMs = 0, lastMpuRetryMs = 0;
uint32_t lastSampleMicros = 0;

void setup() {
  Serial.begin(115200);
  delay(300);
  mqttClient.setBufferSize(768);
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX, GPS_TX);
  Wire.begin(I2C_SDA, I2C_SCL);
  WiFi.setSleep(false); // Disables Wi-Fi power saving to maintain a stable socket stream
  Wire.setClock(400000);

  fsOk = LittleFS.begin(true);
  if (!fsOk) logInfo("WARNING: LittleFS mount failed - events will not be saved");

  mpuOk = mpuInit();
  if (mpuOk) {
    calibrateGyro();
    if (mpuRead()) {
      roll = atan2f(ay, az) * RAD_TO_DEG;
      pitch = atan2f(ax, sqrtf(ay * ay + az * az)) * RAD_TO_DEG;
    }
    logInfo("MPU6050 ready");
  } else {
    logInfo("ERROR: MPU6050 not found - check SDA=21, SCL=22, power");
  }

  connectWifiAndMqtt();
  lastSampleMicros = micros();
}

void loop() {
  uint32_t now = millis();

  // Keep MQTT network socket active and handle ping/pong packets
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) {
      checkMqtt();
    } else {
      mqttClient.loop(); // <-- THIS MUST RUN CONTINUOUSLY
    }
  }

  while (GPSSerial.available()) gps.encode(GPSSerial.read());
  if (now - lastGpsSyncMs > 10000 || (lastGpsSyncMs == 0 && gps.time.isUpdated())) {
    lastGpsSyncMs = now;
    syncTimeFromGps();
  }

  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    uint32_t us = micros();
    float dt = (us - lastSampleMicros) / 1e6f;
    lastSampleMicros = us;
    if (dt <= 0 || dt > 0.2f) dt = SAMPLE_INTERVAL_MS / 1000.0f;

    if (mpuOk && mpuRead()) {
      float accRoll = atan2f(ay, az) * RAD_TO_DEG;
      float accPitch = atan2f(ax, sqrtf(ay * ay + az * az)) * RAD_TO_DEG;
      
      float rawRoll = roll + rollZero, rawPitch = pitch + pitchZero;
      rawRoll = COMP_ALPHA * (rawRoll + gx * dt) + (1.0f - COMP_ALPHA) * accRoll;
      rawPitch = COMP_ALPHA * (rawPitch - gy * dt) + (1.0f - COMP_ALPHA) * accPitch;
      
      roll = rawRoll - rollZero;
      pitch = rawPitch - pitchZero;
      yaw += gz * dt;
      if (yaw > 180) yaw -= 360;
      if (yaw < -180) yaw += 360;

      gTotal = sqrtf(ax * ax + ay * ay + az * az);
      float c = cosf(roll * DEG_TO_RAD) * cosf(pitch * DEG_TO_RAD);
      if (c > 1) c = 1;
      if (c < -1) c = -1;
      tiltDeg = acosf(c) * RAD_TO_DEG;

      detectEvents();
    } else if (now - lastMpuRetryMs > 3000) {
      lastMpuRetryMs = now;
      mpuOk = mpuInit();
      if (mpuOk) { calibrateGyro(); logInfo("MPU6050 reconnected"); }
    }
  }

  if (now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    sendTelemetry();
  }

  readSerialCommands();
}