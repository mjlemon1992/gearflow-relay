const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3001;
const SM_API_KEY = process.env.SHOPMONKEY_API_KEY;
const SM_BASE = "https://api.shopmonkey.cloud/v3";
app.use(cors({ origin: "*" }));
app.use(express.json());

// In-memory RO storage (persists while server is running)
const roStore = {};

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
  res.json({ ok: true, version: "2.2", ros: Object.keys(roStore).length });
});

// ── RO STORAGE ENDPOINTS ──────────────────────────────────────────────

app.post("/api/ro/:roNumber/save", (req, res) => {
  try {
    const { roNumber } = req.params;
    const existing = roStore[roNumber] || {};
    roStore[roNumber] = {
      ...existing,
      ...req.body,
      roNumber,
      updatedAt: new Date().toISOString()
    };
    res.json({ ok: true, roNumber, updatedAt: roStore[roNumber].updatedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ro/:roNumber/load", (req, res) => {
  try {
    const { roNumber } = req.params;
    const data = roStore[roNumber] || null;
    res.json({ found: !!data, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ro/list", (req, res) => {
  try {
    const list = Object.values(roStore).map(r => ({
      roNumber: r.roNumber,
      vehicle: r.vehicle || "",
      trans: r.trans || "",
      stage: r.stage || "ro",
      updatedAt: r.updatedAt
    })).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SHOPMONKEY ENDPOINTS ──────────────────────────────────────────────

// Debug endpoint - returns full order object so we can see what fields exist
app.get("/api/order/debug", async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: "number required" });

    // Try multiple search strategies
    const searches = [
      smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ number: number })) + "&limit=5"),
      smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ number: parseInt(number) })) + "&limit=5"),
      smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ externalNumber: number })) + "&limit=5"),
      smFetch("/order?q=" + encodeURIComponent(number) + "&limit=20")
    ];

    const [w1, w2, w3, w4] = await Promise.all(searches);

    // Try to find a match across all results
    const allOrders = [
      ...(w1.data.data || []),
      ...(w2.data.data || []),
      ...(w3.data.data || []),
      ...(w4.data.data || [])
    ];

    // Deduplicate by id
    const seen = new Set();
    const unique = allOrders.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; });

    // Find best match
    const match = unique.find(o =>
      String(o.number) === String(number) ||
      String(o.externalNumber) === String(number) ||
      String(o.number) === String(parseInt(number)) ||
      (o.coalescedName && o.coalescedName.includes(number))
    ) || unique[0];

    res.json({ status: 200, totalFound: unique.length, order: match || null, allNumbers: unique.map(o => ({ id: o.id, number: o.number, external: o.externalNumber, vehicle: o.generatedVehicleName, customer: o.generatedCustomerName })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Main lookup - finds order and returns vehicle/customer info
app.get("/api/order/lookup", async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: "number required" });

    let order = null;

    // Strategy 1: exact string match on number field
    const w1 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ number: number })) + "&limit=10");
    if (w1.data && w1.data.data) {
      order = w1.data.data.find(o => String(o.number) === String(number));
    }

    // Strategy 2: integer match
    if (!order) {
      const w2 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ number: parseInt(number) })) + "&limit=10");
      if (w2.data && w2.data.data) {
        order = w2.data.data.find(o => String(o.number) === String(number));
      }
    }

    // Strategy 3: externalNumber match
    if (!order) {
      const w3 = await smFetch("/order?where=" + encodeURIComponent(JSON.stringify({ externalNumber: number })) + "&limit=10");
      if (w3.data && w3.data.data) {
        order = w3.data.data.find(o =>
          String(o.externalNumber) === String(number) ||
          String(o.number) === String(number)
        );
      }
    }

    // Strategy 4: q search (searches across multiple fields)
    if (!order) {
      const w4 = await smFetch("/order?q=" + encodeURIComponent(number) + "&limit=50");
      if (w4.data && w4.data.data) {
        order = w4.data.data.find(o =>
          String(o.number) === String(number) ||
          String(o.externalNumber) === String(number) ||
          String(Math.abs(parseInt(o.number || 0))) === String(number)
        );
        // If still not found, try matching last digits
        if (!order && number.length >= 4) {
          order = w4.data.data.find(o => String(Math.abs(parseInt(o.number || 0))).endsWith(number.slice(-4)));
        }
      }
    }

    if (!order) return res.json({ found: false });

    // Extract vehicle info from multiple possible fields
    const genVehicle = order.generatedVehicleName || order.generatedName || "";
    const yearMatch = genVehicle.match(/^(\d{4})/);
    const year = yearMatch ? yearMatch[1] : "";
    const customer = order.generatedCustomerName || "";

    res.json({
      found: true,
      orderId: order.id,
      number: order.number,
      externalNumber: order.externalNumber,
      vehicle: genVehicle,
      year,
      customer
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/order/:orderId/services", async (req, res) => {
  try {
    const { data } = await smFetch("/order/" + req.params.orderId + "/service");
    const services = (data.data || []).map(s => ({
      id: s.id,
      name: s.name || s.laborName || "Unnamed",
      laborPrice: s.laborPrice || 0
    }));
    res.json({ found: true, services });
  } catch (e) {
    res.status(500).json({ error: e.message }); }
});

app.post("/api/order/:orderId/service/:serviceId/part", async (req, res) => {
  try {
    const { orderId, serviceId } = req.params;
    const { name, partNumber, retailPrice, quantity, note } = req.body;
    const { status, data } = await smFetch("/order/" + orderId + "/service/" + serviceId + "/part", {
      method: "POST",
      body: JSON.stringify({
        name,
        partNumber: partNumber || "",
        retailPrice: retailPrice || 0,
        wholesalePrice: retailPrice || 0,
        quantity: quantity || 1,
        note: note || "",
        taxable: true
      })
    });
    res.json({ success: status >= 200 && status < 300, smStatus: status, data: data.data, message: data.message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUSH RECOMMENDATIONS (removal findings) ───────────────────────────
app.post("/api/order/:orderId/recommendations", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { findings } = req.body;

    if (!findings || findings.length === 0) {
      return res.json({ ok: false, message: "No findings to push" });
    }

    // Create "Recommendations" service line - Shopmonkey requires array
    const svcRes = await smFetch("/order/" + orderId + "/service", {
      method: "POST",
      body: JSON.stringify([{
        name: "Recommendations - Removal Inspection",
        laborPrice: 0,
        note: "Auto-generated from GearFlow Stage 1 inspection"
      }])
    });

    if (svcRes.status < 200 || svcRes.status >= 300) {
      return res.status(500).json({ ok: false, message: "Failed to create service line", smStatus: svcRes.status, detail: svcRes.data });
    }

    const serviceId = svcRes.data && (
      (svcRes.data.data && Array.isArray(svcRes.data.data) && svcRes.data.data[0] && svcRes.data.data[0].id) ||
      (svcRes.data.data && svcRes.data.data.id)
    );
    if (!serviceId) {
      return res.status(500).json({ ok: false, message: "No service ID returned", detail: svcRes.data });
    }

    // Add each finding as a separate line item
    const results = [];
    for (const finding of findings) {
      const label = "[" + finding.status + "] " + finding.label;
      const note = finding.note ? "Tech note: " + finding.note : "";
      const partRes = await smFetch("/order/" + orderId + "/service/" + serviceId + "/part", {
        method: "POST",
        body: JSON.stringify([{
          name: label,
          partNumber: "",
          retailPrice: 0,
          wholesalePrice: 0,
          quantity: 1,
          note,
          taxable: false
        }])
      });
      results.push({
        label,
        success: partRes.status >= 200 && partRes.status < 300,
        smStatus: partRes.status
      });
    }

    res.json({ ok: true, serviceId, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("GearFlow Relay v2.1 on port " + PORT));
