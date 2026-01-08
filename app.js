/* =========================
   CONFIG
========================= */
const CENTER = [16.073128, 108.224769]; // [lat, lng]
const RADIUS_KM = 2;
const FLOOD_OSM_WAYS = new Set();
let floodAcknowledged = false;
let isFloodMode = false;

/* =========================
   SPEED TABLE (km/h)
========================= */
const SPEED_TABLE = {
  car: {
    motorway: 80,
    trunk: 70,
    primary: 60,
    secondary: 50,
    tertiary: 40,
    residential: 30,
    service: 20,
    unclassified: 40,
  },
  bike: {
    primary: 20,
    secondary: 18,
    tertiary: 16,
    residential: 15,
    service: 12,
    cycleway: 20,
    unclassified: 15,
  },
  foot: {
    footway: 5,
    pedestrian: 5,
    path: 5,
    residential: 4,
    service: 4,
    unclassified: 4,
  },
};

/* =========================
   MAP INIT
========================= */
const map = L.map("map", {
  center: CENTER,
  zoom: 15,
  minZoom: 14,
  maxZoom: 18,
});

L.tileLayer("https://tile.openstreetmap.de/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap",
}).addTo(map);

/* =========================
   LIMIT MAP TO 2KM
========================= */
const circle = turf.circle([CENTER[1], CENTER[0]], RADIUS_KM, {
  units: "kilometers",
});
const bounds = L.geoJSON(circle).getBounds();
map.setMaxBounds(bounds);
map.on("drag", () => map.panInsideBounds(bounds));

/* =========================
   MARKERS
========================= */
let startMarker = null;
let endMarker = null;
let routeLine = null;
let osmLoaded = false;

/* =========================
   BLOCKED ROADS
========================= */
const blockedEdges = new Set();

/* =========================
   CLICK TO SET START / END
========================= */
let clickState = "start";

map.on("click", (e) => {
  if (!bounds.contains(e.latlng)) return;

  if (clickState === "start") {
    if (startMarker) map.removeLayer(startMarker);
    startMarker = L.marker(e.latlng).addTo(map);
    document.getElementById("start").value = `${e.latlng.lat},${e.latlng.lng}`;
    clickState = "end";
  } else {
    if (endMarker) map.removeLayer(endMarker);
    endMarker = L.marker(e.latlng).addTo(map);
    document.getElementById("end").value = `${e.latlng.lat},${e.latlng.lng}`;
    clickState = "start";
  }
});

/* =========================
   ROAD NETWORK
========================= */
const ROAD_LAYER = L.layerGroup().addTo(map);

/* =========================
   GRAPH STRUCTURE
========================= */
const graph = {
  nodes: new Map(), // key -> { lat, lng, edges[] }
};

function nodeKey(lat, lng) {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function addNode(lat, lng) {
  const key = nodeKey(lat, lng);
  if (!graph.nodes.has(key)) {
    graph.nodes.set(key, { lat, lng, edges: [] });
  }
  return key;
}

function addEdge(from, to, distanceKm, road) {
  graph.nodes.get(from).edges.push({
    to,
    distanceKm,
    road,
  });
}

/* =========================
   LOAD OSM ROADS
========================= */
const centerPoint = turf.point([CENTER[1], CENTER[0]]);

function insideRadius(latlng) {
  const p = turf.point([latlng[1], latlng[0]]);
  return turf.distance(centerPoint, p, { units: "kilometers" }) <= RADIUS_KM;
}

function parseOneWay(tags = {}) {
  if (!tags.oneway) return "no";
  if (tags.oneway === "yes" || tags.oneway === "1") return "forward";
  if (tags.oneway === "-1") return "backward";
  return "no";
}

function getSpeed(road, mode) {
  const tags = road.tags || {};
  const highway = tags.highway;

  // Ưu tiên maxspeed cho car
  if (mode === "car" && tags.maxspeed) {
    const ms = parseInt(tags.maxspeed);
    if (!isNaN(ms)) return ms;
  }

  return SPEED_TABLE[mode]?.[highway] || 10; // fallback an toàn
}

async function loadOSMRoads() {
  const query = `
[out:json];
(
  way["highway"](around:${RADIUS_KM * 1000},${CENTER[0]},${CENTER[1]});
);
out geom tags;
`;

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: query,
  });

  const data = await res.json();

  data.elements.forEach((el) => {
    if (!el.geometry) return;

    const latlngs = el.geometry
      .map((p) => [p.lat, p.lon])
      .filter((ll) => insideRadius(ll));

    if (latlngs.length < 2) return;

    const road = L.polyline(latlngs, {
      color: "white",
      weight: 3,
    }).addTo(ROAD_LAYER);

    road.isBlocked = false;
    road.osmId = el.id;
    road.tags = el.tags || {};
    road.oneway = parseOneWay(road.tags);

    road.on("click", () => {
      road.setStyle(
        road.isBlocked
          ? { color: "red", dashArray: "5,5" }
          : { color: "white", dashArray: null }
      );

      road.isBlocked
        ? blockedEdges.add(road.osmId)
        : blockedEdges.delete(road.osmId);

      updateBlockedList();
    });

    // BUILD GRAPH WITH ONE-WAY LOGIC
    for (let i = 0; i < latlngs.length - 1; i++) {
      const a = latlngs[i];
      const b = latlngs[i + 1];

      const k1 = addNode(a[0], a[1]);
      const k2 = addNode(b[0], b[1]);

      const distanceKm = turf.distance([a[1], a[0]], [b[1], b[0]], {
        units: "kilometers",
      });

      if (road.oneway === "forward") {
        addEdge(k1, k2, distanceKm, road);
      } else if (road.oneway === "backward") {
        addEdge(k2, k1, distanceKm, road);
      } else {
        addEdge(k1, k2, distanceKm, road);
        addEdge(k2, k1, distanceKm, road);
      }
    }
  });

  console.log("Graph nodes:", graph.nodes.size);

  osmLoaded = true;

  // 🔥 NẾU ĐANG NGẬP → BLOCK NGAY SAU KHI LOAD
  if (isFloodMode) {
    setRoadBlockedByOSM(1279915923, true);
  }
}

loadOSMRoads();

/* =========================
   A* ALGORITHM
========================= */
function heuristic(a, b) {
  const n1 = graph.nodes.get(a);
  const n2 = graph.nodes.get(b);
  return turf.distance([n1.lng, n1.lat], [n2.lng, n2.lat], {
    units: "kilometers",
  });
}

function findNearestNode(lat, lng) {
  let min = Infinity,
    nearest = null;

  graph.nodes.forEach((n, key) => {
    const d = turf.distance([lng, lat], [n.lng, n.lat], {
      units: "kilometers",
    });
    if (d < min) {
      min = d;
      nearest = key;
    }
  });

  return nearest;
}

function aStar(start, goal, mode) {
  const open = new Set([start]);
  const cameFrom = new Map();
  const g = new Map(),
    f = new Map();

  graph.nodes.forEach((_, k) => {
    g.set(k, Infinity);
    f.set(k, Infinity);
  });

  g.set(start, 0);
  f.set(start, heuristic(start, goal));

  while (open.size) {
    let current = null,
      min = Infinity;
    open.forEach((k) => {
      if (f.get(k) < min) {
        min = f.get(k);
        current = k;
      }
    });

    if (current === goal) return reconstruct(cameFrom, current);

    open.delete(current);

    for (const edge of graph.nodes.get(current).edges) {
      if (edge.road.isBlocked) continue;

      const speed = getSpeed(edge.road, mode);
      const time = (edge.distanceKm / speed) * 60; // phút
      const tentative = g.get(current) + time;

      if (tentative < g.get(edge.to)) {
        cameFrom.set(edge.to, current);
        g.set(edge.to, tentative);
        f.set(edge.to, tentative + heuristic(edge.to, goal));
        open.add(edge.to);
      }
    }
  }
  return null;
}

function reconstruct(cameFrom, current) {
  const path = [current];
  while (cameFrom.has(current)) {
    current = cameFrom.get(current);
    path.push(current);
  }
  return path.reverse();
}

/* =========================
   DRAW ROUTE
========================= */
function drawRoute(path) {
  if (routeLine) map.removeLayer(routeLine);

  const latlngs = path.map((k) => {
    const n = graph.nodes.get(k);
    return [n.lat, n.lng];
  });

  routeLine = L.polyline(latlngs, {
    color: "blue",
    weight: 5,
  }).addTo(map);
}

function calculateRouteInfo(path, mode) {
  let totalDistance = 0; // km
  let totalTime = 0; // phút

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];

    const node = graph.nodes.get(from);
    const edge = node.edges.find((e) => e.to === to);
    if (!edge) continue;

    const speed = getSpeed(edge.road, mode); // km/h
    const distance = edge.distanceKm;

    totalDistance += distance;
    totalTime += (distance / speed) * 60;
  }

  return {
    distanceKm: totalDistance,
    timeMin: totalTime,
  };
}

/* =========================
   ROUTE BUTTON
========================= */
function route() {
  if (!startMarker || !endMarker) {
    alert("Chọn đủ điểm");
    return;
  }

  const mode = document.getElementById("mode").value;

  const s = startMarker.getLatLng();
  const e = endMarker.getLatLng();

  const startKey = findNearestNode(s.lat, s.lng);
  const endKey = findNearestNode(e.lat, e.lng);

  const path = aStar(startKey, endKey, mode);

  if (!path) {
    alert("Không tìm được đường (do chặn hoặc đường một chiều)");
    return;
  }

  drawRoute(path);

  // ⭐ THÊM ĐOẠN NÀY
  const info = calculateRouteInfo(path, mode);

  document.getElementById("distance").textContent = `${info.distanceKm.toFixed(
    2
  )} km`;

  document.getElementById("time").textContent = `${info.timeMin.toFixed(
    1
  )} phút`;

  document.getElementById("routeInfo").classList.remove("hidden");
}

document.getElementById("routeBtn").onclick = route;

function reset() {
  // Xóa tuyến đường
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }

  // Xóa marker bắt đầu
  if (startMarker) {
    map.removeLayer(startMarker);
    startMarker = null;
  }

  // Xóa marker kết thúc
  if (endMarker) {
    map.removeLayer(endMarker);
    endMarker = null;
  }

  // Clear input
  document.getElementById("start").value = "";
  document.getElementById("end").value = "";

  // Reset trạng thái click
  clickState = "start";
  document.getElementById("routeInfo").classList.add("hidden");
}

document.getElementById("resetBtn").onclick = reset;

/* =========================
   BLOCKED LIST UI
========================= */
function updateBlockedList() {
  const ul = document.getElementById("blockedList");
  ul.innerHTML = "";
  blockedEdges.forEach((id) => {
    const li = document.createElement("li");
    if (id === 1279915923 && isFloodMode) {
      li.textContent = `Đường Bạch Đằng (Đang Ngập)`;
    } else {
      li.textContent = `OSM Way ${id}`;
    }
    ul.appendChild(li);
  });
}

function setRoadBlockedByOSM(osmId, blocked) {
  ROAD_LAYER.eachLayer((road) => {
    if (String(road.osmId) === String(osmId)) {
      road.isBlocked = blocked;

      road.setStyle(
        blocked
          ? { color: "red", dashArray: "8,5" }
          : { color: "white", dashArray: null }
      );

      blocked ? blockedEdges.add(road.osmId) : blockedEdges.delete(road.osmId);
    }
  });

  updateBlockedList();
}

// ====== THÔNG BÁO NGẬP ======
const floodNotice = document.getElementById("floodNotice");
const closeNoticeBtn = document.getElementById("closeNoticeBtn");
closeNoticeBtn.addEventListener("click", () => {
  floodNotice.style.display = "none";
  floodAcknowledged = true;
});

async function checkFloodStatus() {
  try {
    const res = await fetch("http://localhost:5000/status");
    const data = await res.json();

    const shouldFlood = data.flood === true;

    // Nếu trạng thái ngập thay đổi
    if (shouldFlood !== isFloodMode) {
      isFloodMode = shouldFlood;
      floodAcknowledged = false; // reset khi có thay đổi trạng thái

      if (osmLoaded) {
        setRoadBlockedByOSM(1279915923, isFloodMode);
      }

      // 👉 BLOCK đường OSM theo logic ngập (bạn đã làm ở bước trước)
      if (isFloodMode && !floodAcknowledged) {
        setRoadBlockedByOSM(1279915923, true);
      } else {
        setRoadBlockedByOSM(1279915923, false);
      }
    }

    // 👉 HIỂN THỊ POPUP
    if (isFloodMode && !floodAcknowledged) {
      floodNotice.style.display = "flex";
    }

    if (!isFloodMode) {
      floodNotice.style.display = "none";
    }
  } catch (err) {
    console.error("Không thể kết nối Flask server:", err);
  }
}

document.getElementById("clearBlock").onclick = () => {
  ROAD_LAYER.eachLayer((r) => {
    r.isBlocked = false;
    r.setStyle({ color: "#666", dashArray: null });
  });
  blockedEdges.clear();
  updateBlockedList();
};

setInterval(checkFloodStatus, 1000);
/* =========================
   RESCUE REPORT (MANUAL)
========================= */
const rescueBtn = document.getElementById("rescueBtn");
const rescueModal = document.getElementById("rescueModal");
const cancelRescue = document.getElementById("cancelRescue");
const submitRescue = document.getElementById("submitRescue");

const rescueName = document.getElementById("rescueName");
const rescuePhone = document.getElementById("rescuePhone");
const rescueAddress = document.getElementById("rescueAddress");
const rescueReason = document.getElementById("rescueReason");

const loadingOverlay = document.getElementById("loadingOverlay");
const commitCheckbox = document.getElementById("commitCheckbox");

submitRescue.disabled = true;
commitCheckbox.addEventListener("change", () => {
  submitRescue.disabled = !commitCheckbox.checked;
});

// Mở form
rescueBtn.onclick = () => {
  rescueModal.classList.remove("hidden");
  commitCheckbox.checked = false;
  submitRescue.disabled = true;
};

// Hủy
cancelRescue.onclick = () => {
  rescueName.value = "";
  rescuePhone.value = "";
  rescueAddress.value = "";
  rescueReason.value = "";
  rescueModal.classList.add("hidden");
  commitCheckbox.checked = false;
  submitRescue.disabled = true;
};

// Gửi báo cáo
submitRescue.onclick = async () => {
  if (!commitCheckbox.checked) {
    alert("⚠️ Bạn phải cam kết thông tin là đúng sự thật trước khi gửi.");
    return;
  }
  const name = rescueName.value.trim();
  const phone = rescuePhone.value.trim();
  const address = rescueAddress.value.trim();
  const reason = rescueReason.value.trim();

  if (!name || !phone || !address || !reason) {
    alert("⚠️ Vui lòng điền đầy đủ thông tin");
    return;
  }

  const phoneRegex = /^(0|\+84)[0-9]{9}$/;
  if (!phoneRegex.test(phone)) {
    alert("⚠️ Số điện thoại không hợp lệ");
    return;
  }

  const ok = confirm(
    "⚠️ CẢNH BÁO PHÁP LUẬT ⚠️\n\n" +
      "Báo cáo sai sự thật sẽ bị xử lý theo quy định pháp luật.\n\n" +
      "Bạn xác nhận gửi thông tin?"
  );
  if (!ok) return;

  try {
    // 🔥 HIỆN LOADING
    loadingOverlay.classList.remove("hidden");
    submitRescue.disabled = true;

    await sendEmail(name, phone, address, reason);

    alert("✅ Yêu cầu cứu hộ của bạn đã được gửi đến trung tâm.");
    rescueModal.classList.add("hidden");

    // reset form
    rescueName.value = "";
    rescuePhone.value = "";
    rescueAddress.value = "";
    rescueReason.value = "";
  } catch (err) {
    console.error("Lỗi gửi email:", err);
    alert("❌ Gửi email thất bại. Vui lòng thử lại sau.");
  } finally {
    // 🔥 ẨN LOADING (DÙ THÀNH CÔNG HAY THẤT BẠI)
    loadingOverlay.classList.add("hidden");
    commitCheckbox.checked = false;
    submitRescue.disabled = true;
  }
};

// Hàm gửi email qua EmailJS
async function sendEmail(name, phone, address, desc) {
  const templateParams = {
    rescue_name: name,
    rescue_phone: phone,
    rescue_address: address,
    rescue_desc: desc,
  };

  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: "service_ih1vkhc", // 🔹 thay bằng service ID của bạn
      template_id: "template_6noiann", // 🔹 thay bằng template ID của bạn
      user_id: "Xs6XzRo559iGDXWjV", // 🔹 thay bằng public key (EmailJS public key)
      template_params: templateParams,
    }),
  });

  if (!response.ok) {
    throw new Error("Không thể gửi email");
  }
}
