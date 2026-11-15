import sqlite3
import threading
import json
import queue
import paho.mqtt.client as mqtt
from flask import Flask, jsonify, render_template_string

app = Flask(__name__)
DB_FILE = "shipment.db"
data_queue = queue.Queue()

# Initialize SQLite Database with lat/lng columns
def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('PRAGMA journal_mode=WAL;')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS telemetry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            tilt REAL,
            g_total REAL,
            roll REAL,
            pitch REAL,
            lat REAL,
            lng REAL,
            fix INTEGER
        )
    ''')
    conn.commit()
    conn.close()

init_db()

# Background Database Writer Worker
def db_writer_worker():
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    cursor = conn.cursor()
    while True:
        batch = []
        while not data_queue.empty():
            batch.append(data_queue.get())

        if batch:
            try:
                cursor.executemany(
                    "INSERT INTO telemetry (timestamp, tilt, g_total, roll, pitch, lat, lng, fix) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    batch
                )
                conn.commit()
            except Exception as e:
                print("DB Write Error:", e)

        threading.Event().wait(0.05)

threading.Thread(target=db_writer_worker, daemon=True).start()

# MQTT Background Worker
def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
        if payload.get("t") == "d":
            data_queue.put((
                payload.get("time"),
                payload.get("tilt"),
                payload.get("g"),
                payload.get("roll"),
                payload.get("pitch"),
                payload.get("lat"),
                payload.get("lng"),
                payload.get("fix")
            ))
    except Exception as e:
        print("Error parsing MQTT payload:", e)

def start_mqtt():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)
    client.on_message = on_message
    client.connect("localhost", 1883, 60)
    client.subscribe("shipment/+/+")
    client.loop_forever()

threading.Thread(target=start_mqtt, daemon=True).start()

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Shipment Tracker Dashboard with GPS Map</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- Leaflet CSS & JS for OpenStreetMap -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</head>
<body class="bg-gray-900 text-white font-sans p-6">
    <div class="max-w-6xl mx-auto">
        <header class="flex justify-between items-center mb-8 border-b border-gray-800 pb-4">
            <div>
                <h1 class="text-3xl font-bold">📦 Shipment Tracker & GPS Map</h1>
                <p class="text-sm text-gray-400 mt-1">Live Telemetry & Route Tracking</p>
            </div>
            <button onclick="loadData()" class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded text-sm font-semibold transition shadow">🔄 Refresh Data</button>
        </header>

        <!-- Grid for Map and Charts -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div class="bg-gray-800 p-5 rounded-xl shadow-lg border border-gray-700 flex flex-col">
                <h2 class="text-lg font-semibold mb-4 text-yellow-400">Live GPS Location</h2>
                <div id="map" class="w-full h-72 rounded-lg z-10"></div>
                <div id="gps-status" class="mt-3 text-sm text-gray-300">Awaiting GPS fix...</div>
            </div>
            <div class="bg-gray-800 p-5 rounded-xl shadow-lg border border-gray-700">
                <h2 class="text-lg font-semibold mb-4 text-blue-400">Tilt Angle History (°)</h2>
                <canvas id="tiltChart" class="max-h-72"></canvas>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div class="bg-gray-800 p-5 rounded-xl shadow-lg border border-gray-700">
                <h2 class="text-lg font-semibold mb-4 text-green-400">Total G-Force History (g)</h2>
                <canvas id="gChart" class="max-h-72"></canvas>
            </div>
            <div class="bg-gray-800 p-5 rounded-xl shadow-lg border border-gray-700">
                <h2 class="text-lg font-semibold mb-4 text-purple-400">Recent Records</h2>
                <div class="overflow-x-auto max-h-72">
                    <table class="w-full text-left text-sm text-gray-300">
                        <thead class="bg-gray-700 text-xs uppercase text-gray-400 sticky top-0">
                            <tr>
                                <th class="p-2">Time</th>
                                <th class="p-2">Tilt (°)</th>
                                <th class="p-2">G</th>
                                <th class="p-2">Lat, Lng</th>
                                <th class="p-2">Fix</th>
                            </tr>
                        </thead>
                        <tbody id="tableBody"></tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <script>
        let tiltChart, gChart, map, marker, polyline;

        function initMap() {
            map = L.map('map').setView([12.9716, 77.5946], 13);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap'
            }).addTo(map);
            polyline = L.polyline([], {color: '#3b82f6', weight: 4}).addTo(map);
        }

        initMap();

        let firstLoad = true;

        async function loadData() {
            try {
                const res = await fetch('/api/data');
                const data = await res.json();
                if (data.length === 0) return;

                const labels = data.map(d => d.timestamp);
                const tilts = data.map(d => d.tilt);
                const gTotals = data.map(d => d.g_total);

                const tbody = document.getElementById('tableBody');
                tbody.innerHTML = data.slice().reverse().map(d => `
                    <tr class="border-b border-gray-700 hover:bg-gray-750">
                        <td class="p-2">${d.timestamp}</td>
                        <td class="p-2">${d.tilt}</td>
                        <td class="p-2">${d.g_total}</td>
                        <td class="p-2 text-xs">${d.lat !== 0 ? d.lat.toFixed(4) + ', ' + d.lng.toFixed(4) : 'No GPS'}</td>
                        <td class="p-2">${d.fix === 1 ? '✅' : '❌'}</td>
                    </tr>
                `).join('');

                const validPoints = data.filter(d => d.fix === 1 && d.lat !== 0 && d.lng !== 0);
                if (validPoints.length > 0) {
                    const latest = validPoints[validPoints.length - 1];
                    const latLngs = validPoints.map(d => [d.lat, d.lng]);

                    polyline.setLatLngs(latLngs);
                    if (!marker) {
                        marker = L.marker([latest.lat, latest.lng]).addTo(map);
                    } else {
                        marker.setLatLng([latest.lat, latest.lng]);
                    }

                    if (firstLoad) {
                        map.setView([latest.lat, latest.lng], 16);
                        firstLoad = false;
                    }
                    document.getElementById('gps-status').innerHTML = `Status: <span class="text-green-400 font-semibold">Locked</span> (${latest.lat.toFixed(5)}, ${latest.lng.toFixed(5)})`;
                } else {
                    document.getElementById('gps-status').innerHTML = `Status: <span class="text-yellow-400 font-semibold">Searching for satellites (No Fix)...</span>`;
                }

                if (!tiltChart) {
                    const ctx1 = document.getElementById('tiltChart').getContext('2d');
                    tiltChart = new Chart(ctx1, {
                        type: 'line',
                        data: { labels: labels, datasets: [{ label: 'Tilt (°)', data: tilts, borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, tension: 0.1 }] },
                        options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: false } } }
                    });

                    const ctx2 = document.getElementById('gChart').getContext('2d');
                    gChart = new Chart(ctx2, {
                        type: 'line',
                        data: { labels: labels, datasets: [{ label: 'G-Force (g)', data: gTotals, borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true, tension: 0.1 }] },
                        options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: false } } }
                    });
                } else {
                    tiltChart.data.labels = labels;
                    tiltChart.data.datasets[0].data = tilts;
                    tiltChart.update();

                    gChart.data.labels = labels;
                    gChart.data.datasets[0].data = gTotals;
                    gChart.update();
                }
            } catch (err) {
                console.error("Failed to load telemetry data:", err);
            }
        }

        loadData();
        setInterval(loadData, 1000);
    </script>
</body>
</html>
"""

@app.route('/')
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route('/api/data')
def get_data():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT timestamp, tilt, g_total, roll, pitch, lat, lng, fix FROM telemetry ORDER BY id DESC LIMIT 200")
    rows = cursor.fetchall()
    conn.close()
    rows.reverse()
    data = [{
        "timestamp": r[0], "tilt": r[1], "g_total": r[2],
        "roll": r[3], "pitch": r[4], "lat": r[5], "lng": r[6], "fix": r[7]
    } for r in rows]
    return jsonify(data)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
