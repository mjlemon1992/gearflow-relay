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

app.get("/api/order/debug", async (req, res) => {
  try {
    const number = req.query.number;
    const attempts = {};
    const filters = [
      ["q=number", "/order?q=" + encodeURIComponent(number) + "&limit=5"],
      ["search", "/order?search=" + encodeURIComponent(number) + "&limit=5"],
      ["number eq", "/order?filter=number+eq+" + encodeURIComponent(number) + "&limit=5"],
      ["number contains", "/order?filter=number+contains+" + encodeURIComponent(number) + "&limit=5"],
    ];
    for (const [label, path] of filters) {
      const { status, data } = await smFetch(path);
      attempts[label] = { status, count: data && data.data ? data.data.length : 0, first: data && data.data && data.data[0] ? { number: data.data[0].number, vehicle: data.data[0].generatedVehicleName } : null };
    }
    res.json({ attempts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/order/lookup", async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: "number required" });

    // Search using q parameter and then filter client-side
    const { data } = await smFetch("/order?q=" + encodeURIComponent(number) + "&limit=20");
    const orders = data && data.data ? data.data : [];
    
    // Find exact match
    const order = orders.find(o => 
      String(o.number) === String(number) ||
      String(o.number) === "-" + number ||
      String(o.externalNumber) === String(number)
    );

    if (!order) {
      return res.json({ found: false, searched: orders.length });
    }

    const genVehicle = order.generatedVehicleName || "";
    const yearMatch = genVehicle.match(/^(\d{4})/);
    const year = yearMatch ? yearMatch[1] : "";
    const customer = order.generatedCustomerName || "";
    res.json({ found: true, orderId: order.id, number: order.number, vehicle: genVehicle, year, customer });
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
