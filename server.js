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
      ["where number", "/order?where=" + encodeURIComponent(JSON.stringify({number: number})) + "&limit=5"],
      ["where number int", "/order?where=" + encodeURIComponent(JSON.stringify({number: parseInt(number)})) + "&limit=5"],
      ["ids search", "/order/search?limit=5"],
      ["q param", "/order?q=" + encodeURIComponent(number) + "&limit=5"],
    ];
    for (const [label, path] of filters) {
      try {
        const { status, data } = await smFetch(path);
        attempts[label] = { status, count: data && data.data ? data.data.length : 0, first: data && data.data && data.data[0] ? { number: data.data[0].number, externalNumber: data.data[0].externalNumber, vehicle: data.data[0].generatedVehicleName } : null, error: data && data.message };
      } catch(e) {
        attempts[label] = { error: e.message };
      }
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

    // Try where filter with JSON
    const whereNum = "/order?where=" + encodeURIComponent(JSON.stringify({number: number})) + "&limit=5";
    const { data: d1 } = await smFetch(whereNum);
    let order = d1 && d1.data && d1.data.find(o => String(o.number) === String(number));

    // Try as integer
    if (!order) {
      const whereInt = "/order?where=" + encodeURIComponent(JSON.stringify({number: parseInt(number)})) + "&limit=5";
      const { data: d2 } = await smFetch(whereInt);
      order = d2 && d2.data && d2.data.find(o => String(o.number) === String(number));
    }

    // Try q search and filter client side
    if (!order) {
      const { data: d3 } = await smFetch("/order?q=" + encodeURIComponent(number) + "&limit=50");
      order = d3 && d3.data && d3.data.find(o => 
        String(o.number) === String(number) ||
        String(o.externalNumber) === String(number)
      );
    }

    if (!order) {
      return res.json({ found: false });
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
