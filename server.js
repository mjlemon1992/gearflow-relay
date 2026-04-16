const express = require(“express”);
const cors = require(“cors”);
const fetch = require(“node-fetch”);

const app = express();
const PORT = process.env.PORT || 3001;
const SM_API_KEY = process.env.SHOPMONKEY_API_KEY;
const SM_BASE = “https://api.shopmonkey.cloud/v3”;

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow requests from your GearFlow app (Claude artifact URL or your domain)
app.use(cors({
origin: “*”, // Tighten this to your GearFlow domain once deployed
methods: [“GET”, “POST”, “PUT”, “DELETE”, “OPTIONS”],
allowedHeaders: [“Content-Type”, “Authorization”],
}));

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get(”/health”, (req, res) => {
res.json({
status: “ok”,
service: “GearFlow Relay”,
shopmonkey: SM_API_KEY ? “API key configured ✓” : “⚠ SHOPMONKEY_API_KEY not set”
});
});

// ── Helper: forward to Shopmonkey ─────────────────────────────────────────────
async function smFetch(path, options = {}) {
const url = `${SM_BASE}${path}`;
const res = await fetch(url, {
…options,
headers: {
“Authorization”: `Bearer ${SM_API_KEY}`,
“Content-Type”: “application/json”,
…(options.headers || {}),
},
});
const data = await res.json();
return { status: res.status, data };
}

// ── LOOKUP ORDER BY NUMBER ────────────────────────────────────────────────────
// GET /api/order/lookup?number=10600252
app.get(”/api/order/lookup”, async (req, res) => {
try {
const { number } = req.query;
if (!number) return res.status(400).json({ error: “number query param required” });

```
// Try filter by number field
const { status, data } = await smFetch(`/order?filter=number%3D%3D${encodeURIComponent(number)}`);

// If no match, also try fetching a recent order so client can see field format
if (data?.data?.length === 0) {
  const sample = await smFetch(`/order?limit=1`);
  const sampleOrder = sample.data?.data?.[0];
  return res.json({
    found: false,
    smStatus: status,
    sampleFields: sampleOrder
      ? { id: sampleOrder.id, number: sampleOrder.number, orderNumber: sampleOrder.orderNumber }
      : null,
  });
}

const order = data?.data?.[0];
if (!order) return res.json({ found: false, smStatus: status });

const v = order.vehicle || {};
res.json({
  found: true,
  orderId: order.id,
  number: order.number,
  vehicle: `${v.year || ""} ${v.make || ""} ${v.model || ""} ${v.submodel || ""}`.trim(),
  year: String(v.year || ""),
  customer: order.customer?.firstName
    ? `${order.customer.firstName} ${order.customer.lastName || ""}`.trim()
    : null,
});
```

} catch (e) {
res.status(500).json({ error: e.message });
}
});

// ── GET SERVICES ON AN ORDER ──────────────────────────────────────────────────
// GET /api/order/:orderId/services
app.get(”/api/order/:orderId/services”, async (req, res) => {
try {
const { orderId } = req.params;
const { status, data } = await smFetch(`/order/${orderId}/service`);
const services = (data?.data || []).map(s => ({
id: s.id,
name: s.name || s.laborName || s.serviceItemName || “Unnamed Service”,
laborPrice: s.laborPrice || 0,
}));
res.json({ found: true, smStatus: status, services });
} catch (e) {
res.status(500).json({ error: e.message });
}
});

// ── ADD PART TO SERVICE ───────────────────────────────────────────────────────
// POST /api/order/:orderId/service/:serviceId/part
app.post(”/api/order/:orderId/service/:serviceId/part”, async (req, res) => {
try {
const { orderId, serviceId } = req.params;
const { name, partNumber, retailPrice, wholesalePrice, quantity, note } = req.body;

```
const { status, data } = await smFetch(
  `/order/${orderId}/service/${serviceId}/part`,
  {
    method: "POST",
    body: JSON.stringify({
      name,
      partNumber: partNumber || "",
      retailPrice: retailPrice || 0,
      wholesalePrice: wholesalePrice || retailPrice || 0,
      quantity: quantity || 1,
      note: note || "",
      taxable: true,
    }),
  }
);

res.json({ success: status >= 200 && status < 300, smStatus: status, data: data?.data, message: data?.message });
```

} catch (e) {
res.status(500).json({ error: e.message });
}
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
console.log(`GearFlow Relay running on port ${PORT}`);
console.log(`Shopmonkey API key: ${SM_API_KEY ? "✓ configured" : "✗ NOT SET — add SHOPMONKEY_API_KEY env var"}`);
});
