from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ====== CẤU HÌNH ======
FLOOD_THRESHOLD = 1.5  # cm
FLOODED_WAYS = ["1279915923"]  # OSM Way bị ngập

current_flood = False

@app.route("/data", methods=["POST"])
def receive_data():
    global current_flood

    if not request.is_json:
        return jsonify({"status": "error", "message": "JSON required"}), 400

    data = request.get_json()
    muc_nuoc = float(data.get("muc_nuoc", 0))

    print("📡 ESP32 DATA")
    print(f"  Mực nước: {muc_nuoc} cm")

    current_flood = muc_nuoc > FLOOD_THRESHOLD

    return jsonify({
        "status": "success",
        "flood": current_flood
    })

@app.route("/status", methods=["GET"])
def status():
    return jsonify({
        "flood": current_flood,
        "blockedWays": FLOODED_WAYS if current_flood else []
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
