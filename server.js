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
  const res = await fetch(url, { ...options, headers: { "Authorization": "Bearer " + SM_API_KEY, "Content-Type": "application/json" } });
  const data = await res.json();
  return { status: res.status, data };
}
app.get("/api/order/debug", async (req, res) => {
  try {
    const number = req.query.number;
    const w1 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({number: number})) + "&limit=5");
    const w2 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({number: parseInt(number)})) + "&limit=5");
    const w3 = await smFetch("/order?q=" + encodeURIComponent(number) + "&limit=50");
    res.json({ where_string: { count: w1.data && w1.data.data ? w1.data.data.length : 0, first: w1.data && w1.data.data && w1.data.data[0] ? {number: w1.data.data[0].number, vehicle: w1.data.data[0].generatedVehicleName} : null }, where_int: { count: w2.data && w2.data.data ? w2.data.data.length : 0, first: w2.data && w2.data.data && w2.data.data[0] ? {number: w2.data.data[0].number, vehicle: w2.data.data[0].generatedVehicleName} : null }, q_search: { count: w3.data && w3.data.data ? w3.data.data.length : 0, match: w3.data && w3.data.data ? w3.data.data.find(o => String(o.number) === String(number)) : null } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/order/lookup", async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: "number required" });
    let order = null;
    const w1 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({number: number})) + "&limit=5");
    if (w1.data && w1.data.data) order = w1.data.data.find(o => String(o.number) === String(number));
    if (!order) {
      const w2 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({number: parseInt(number)})) + "&limit=5");
      if (w2.data && w2.data.data) order = w2.data.data.find(o => String(o.number) === String(number));
    }
    if (!order) {
      const w3 = await smFetch("/order?q=" + encodeURIComponent(number) + "&limit=50");
      if (w3.data && w3.data.data) order = w3.data.data.find(o => String(o.number) === String(number) || String(o.externalNumber) === String(number));
    }
    if (!order) return res.json({ found: false });
    const genVehicle = order.generatedVehicleName || "";
    const yearMatch = genVehicle.match(/^(\d{4})/);
    const year = yearMatch ? yearMatch[1] : "";
    res.json({ found: true, orderId: order.id, number: order.number, vehicle: genVehicle, year, customer: order.generatedCustomerName || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/order/:orderId/services", async (req, res) => {
  try {
    const { data } = await smFetch("/order/" + req.params.orderId + "/service");
    const services = (data.data || []).map(s => ({ id: s.id, name: s.name || s.laborName || "Unnamed", laborPrice: s.laborPrice || 0 }));
    res.json({ found: true, services });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/order/:orderId/service/:serviceId/part", async (req, res) => {
  try {
    const { orderId, serviceId } = req.params;
    const { name, partNumber, retailPrice, quantity, note } = req.body;
    const { status, data } = await smFetch("/order/" + orderId + "/service/" + serviceId + "/part", { method: "POST", body: JSON.stringify({ name, partNumber: partNumber || "", retailPrice: retailPrice || 0, wholesalePrice: retailPrice || 0, quantity: quantity || 1, note: note || "", taxable: true }) });
    res.json({ success: status >= 200 && status < 300, smStatus: status, data: data.data, message: data.message });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.listen(PORT, () => console.log("GearFlow Relay on port " + PORT));
