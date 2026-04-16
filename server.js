const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3001;
const SM_API_KEY = process.env.SHOPMONKEY_API_KEY;
const SM_BASE = "https://api.shopmonkey.cloud/v3";

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", shopmonkey: SM_API_KEY ? "configured" : "NOT SET" });
});

async function smFetch(path, options = {}) {
  const url = SM_BASE + path;
  const res = await fetch(url, {
    ...options,
    headers: { "Authorization": "Bearer " + SM_API_KEY, "Content-Type": "application/json" }
  });
  const data = await res.json();
  return { status: res.status, data };
}

app.get("/api/order/lookup", async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: "number required" });
    const { status, data } = await smFetch("/order?filter=number%3D%3D" + encodeURIComponent(number));
    const order = data && data.data && data.data[0];
    if (!order) {
      const sample = await smFetch("/order?limit=1");
      const s = sample.data && sample.data.data && sample.data.data[0];
      return res.json({ found: false, smStatus: status, sampleFields: s ? { id: s.id, number: s.number } : null });
    }
    const v = order.vehicle || {};
    res.json({ found: true, orderId: order.id, number: order.number, vehicle: [v.year, v.make, v.model].filter(Boolean).join(" "), year: String(v.year || "") });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/order/:orderId/services", async (req, res) => {
  try {
    const { status, data } = await smFetch("/order/" + req.params.orderId + "/service");
    const services = (data.data || []).map(s => ({ id: s.id, name: s.name || s.laborName || "Unnamed", laborPrice: s.laborPrice || 0 }));
    res.json({ found: true, smStatus: status, services });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/order/:orderId/service/:serviceId/part", async (req, res) => {
  try {
    const { orderId, serviceId } = req.params;
    const { name, partNumber, retailPrice, quantity, note } = req.body;
    const { status, data } = await smFetch("/order/" + orderId + "/service/" + serviceId + "/part", {
      method: "POST",
      body: JSON.stringify({ name, partNumber: partNumber || "", retailPrice: retailPrice || 0, wholesalePrice: retailPrice || 0, quantity: quantity || 1, note: note || "", taxable: true })
    });
    res.json({ success: status >= 200 && status < 300, smStatus: status, data: data.data, message: data.message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("GearFlow Relay on port " + PORT));
