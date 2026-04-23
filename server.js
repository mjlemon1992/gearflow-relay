const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3001;
const SM_API_KEY = process.env.SHOPMONKEY_API_KEY;
const SM_BASE = "https://api.shopmonkey.cloud/v3";
app.use(cors({ origin: "*" }));
app.use(express.json());

const roStore = {};

// Shopmonkey statuses that mean the job is done
const CLOSED_STATUSES = ["Invoice", "Closed", "Void", "Completed"];

async function smFetch(path, options = {}) {
  const res = await fetch(SM_BASE + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + SM_API_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, version: "3.0", ros: Object.keys(roStore).length });
});

// ── RO STORAGE ────────────────────────────────────────────────────────

app.post("/api/ro/:roNumber/save", (req, res) => {
  try {
    const { roNumber } = req.params;
    const existing = roStore[roNumber] || {};
    roStore[roNumber] = { ...existing, ...req.body, roNumber, updatedAt: new Date().toISOString() };
    res.json({ ok: true, roNumber, updatedAt: roStore[roNumber].updatedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/ro/:roNumber/load", (req, res) => {
  try {
    const { roNumber } = req.params;
    const data = roStore[roNumber] || null;
    res.json({ found: !!data, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List ROs - checks Shopmonkey status and filters out closed orders
app.get("/api/ro/list", async (req, res) => {
  try {
    const all = Object.values(roStore).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const list = [];
    for (const r of all) {
      let smStatus = null;
      let closed = false;
      if (r.orderId) {
        try {
          const { data } = await smFetch("/order/" + r.orderId);
          const order = data && data.data;
          if (order) {
            smStatus = order.status;
            closed = CLOSED_STATUSES.includes(order.status) && order.invoiced === true && order.paid === true;
          }
        } catch (e) { /* ignore - include RO if we can't check */ }
      }
      if (!closed) {
        list.push({
          roNumber: r.roNumber,
          vehicle: r.vehicle || "",
          trans: r.trans || "",
          stage: r.stage || "ro",
          updatedAt: r.updatedAt,
          smStatus
        });
      } else {
        // Remove closed ROs from store
        delete roStore[r.roNumber];
      }
    }
    res.json({ list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SHOPMONKEY LOOKUP ─────────────────────────────────────────────────

app.get("/api/order/debug", async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: "number required" });
    const searches = [
      smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ number: number })) + "&limit=5"),
      smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ number: parseInt(number) })) + "&limit=5"),
      smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ externalNumber: number })) + "&limit=5"),
      smFetch("/order?q=" + encodeURIComponent(number) + "&limit=20")
    ];
    const [w1, w2, w3, w4] = await Promise.all(searches);
    const allOrders = [...(w1.data.data || []), ...(w2.data.data || []), ...(w3.data.data || []), ...(w4.data.data || [])];
    const seen = new Set();
    const unique = allOrders.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; });
    const match = unique.find(o => String(o.number) === String(number) || String(o.externalNumber) === String(number)) || unique[0];
    res.json({ status: 200, totalFound: unique.length, order: match || null, allNumbers: unique.map(o => ({ id: o.id, number: o.number, external: o.externalNumber, vehicle: o.generatedVehicleName, customer: o.generatedCustomerName })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/order/lookup", async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: "number required" });
    let order = null;
    const w1 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ number: number })) + "&limit=10");
    if (w1.data && w1.data.data) order = w1.data.data.find(o => String(o.number) === String(number));
    if (!order) {
      const w2 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ number: parseInt(number) })) + "&limit=10");
      if (w2.data && w2.data.data) order = w2.data.data.find(o => String(o.number) === String(number));
    }
    if (!order) {
      const w3 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ externalNumber: number })) + "&limit=10");
      if (w3.data && w3.data.data) order = w3.data.data.find(o => String(o.externalNumber) === String(number) || String(o.number) === String(number));
    }
    if (!order) {
      const w4 = await smFetch("/order?q=" + encodeURIComponent(number) + "&limit=50");
      if (w4.data && w4.data.data) {
        order = w4.data.data.find(o => String(o.number) === String(number) || String(o.externalNumber) === String(number) || String(Math.abs(parseInt(o.number || 0))) === String(number));
        if (!order && number.length >= 4) order = w4.data.data.find(o => String(Math.abs(parseInt(o.number || 0))).endsWith(number.slice(-4)));
      }
    }
    if (!order) return res.json({ found: false });
    const genVehicle = order.generatedVehicleName || order.generatedName || "";
    const yearMatch = genVehicle.match(/^(\d{4})/);
    const year = yearMatch ? yearMatch[1] : "";
    res.json({ found: true, orderId: order.id, number: order.number, externalNumber: order.externalNumber, vehicle: genVehicle, year, customer: order.generatedCustomerName || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/order/:orderId/services", async (req, res) => {
  try {
    const { data } = await smFetch("/order/" + req.params.orderId + "/service");
    const services = (data.data || []).map(s => ({ id: s.id, name: s.name || s.laborName || "Unnamed", laborPrice: s.laborPrice || 0 }));
    res.json({ found: true, services });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUSH PARTS — auto-creates "Overhaul Transmission" service line ────
app.post("/api/order/:orderId/push-parts", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { parts, failureNote } = req.body; // array of { name, partNumber, retailPrice, supplier }

    if (!parts || parts.length === 0) return res.json({ ok: false, message: "No parts to push" });

    // Always create a fresh "Overhaul Transmission" service line
    const svcRes = await smFetch("/order/" + orderId + "/service", {
      method: "POST",
      body: JSON.stringify([{
        name: "Overhaul Transmission",
        laborPrice: 0,
        note: failureNote ? "Reason for Failure: " + failureNote + "\n\nParts added via GearFlow Strip Down" : "Parts added via GearFlow Strip Down"
      }])
    });

    if (svcRes.status < 200 || svcRes.status >= 300) {
      return res.status(500).json({ ok: false, message: "Failed to create service line", smStatus: svcRes.status, detail: svcRes.data });
    }

    const d = svcRes.data && svcRes.data.data;
    const serviceId = d && (
      (d.services && d.services[0] && d.services[0].id) ||
      (Array.isArray(d) && d[0] && d[0].id) ||
      d.id
    );

    if (!serviceId) return res.status(500).json({ ok: false, message: "No service ID returned", detail: svcRes.data });

    // Add each part
    const results = [];
    for (const part of parts) {
      const partRes = await smFetch("/order/" + orderId + "/service/" + serviceId + "/part", {
        method: "POST",
        body: JSON.stringify({
          name: part.name,
          partNumber: part.partNumber || "",
          retailPrice: part.retailPrice || 0,
          wholesalePrice: part.retailPrice || 0,
          quantity: 1,
          note: part.supplier ? "Supplier: " + part.supplier : "",
          taxable: true
        })
      });
      results.push({ name: part.name, success: partRes.status >= 200 && partRes.status < 300, smStatus: partRes.status });
    }

    res.json({ ok: true, serviceId, serviceName: "Overhaul Transmission", results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Keep old part endpoint for backwards compatibility
app.post("/api/order/:orderId/service/:serviceId/part", async (req, res) => {
  try {
    const { orderId, serviceId } = req.params;
    const { name, partNumber, retailPrice, quantity, note } = req.body;
    const { status, data } = await smFetch("/order/" + orderId + "/service/" + serviceId + "/part", {
      method: "POST",
      body: JSON.stringify({ name, partNumber: partNumber || "", retailPrice: retailPrice || 0, wholesalePrice: retailPrice || 0, quantity: quantity || 1, note: note || "", taxable: true })
    });
    res.json({ success: status >= 200 && status < 300, smStatus: status, data: data.data, message: data.message });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUSH RECOMMENDATIONS ──────────────────────────────────────────────
app.post("/api/order/:orderId/recommendations", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { findings } = req.body;
    if (!findings || findings.length === 0) return res.json({ ok: false, message: "No findings to push" });

    const svcRes = await smFetch("/order/" + orderId + "/service", {
      method: "POST",
      body: JSON.stringify([{ name: "Recommendations - Removal Inspection", laborPrice: 0, note: "Auto-generated from GearFlow Stage 1 inspection" }])
    });

    if (svcRes.status < 200 || svcRes.status >= 300) {
      return res.status(500).json({ ok: false, message: "Failed to create service line", smStatus: svcRes.status, detail: svcRes.data });
    }

    const d = svcRes.data && svcRes.data.data;
    const serviceId = d && (
      (d.services && d.services[0] && d.services[0].id) ||
      (Array.isArray(d) && d[0] && d[0].id) ||
      d.id
    );
    if (!serviceId) return res.status(500).json({ ok: false, message: "No service ID returned", detail: svcRes.data });

    const results = [];
    for (const finding of findings) {
      const label = "[" + finding.status + "] " + finding.label;
      const note = finding.note ? "Tech note: " + finding.note : "";
      const partRes = await smFetch("/order/" + orderId + "/service/" + serviceId + "/part", {
        method: "POST",
        body: JSON.stringify({ name: label, partNumber: "", retailPrice: 0, wholesalePrice: 0, quantity: 1, note, taxable: false })
      });
      results.push({ label, success: partRes.status >= 200 && partRes.status < 300, smStatus: partRes.status });
    }
    res.json({ ok: true, serviceId, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post("/api/order/:orderId/note", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: "note required" });
    const { status, data } = await smFetch("/conversation", {
      method: "POST",
      body: JSON.stringify({ note })
    });
    res.json({ ok: status >= 200 && status < 300, smStatus: status, data: data.data, message: data.message });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log("GearFlow Relay v3.0 on port " + PORT));
