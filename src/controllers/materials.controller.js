// src/controllers/materials.controller.js
const { prisma } = require("../lib/prisma");

// --------------------
// Utils
// --------------------
function toInt(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: `Campo inválido: ${field}` };
  }
  return { ok: true, value: n };
}

function toFloat(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return { ok: false, message: `Campo inválido: ${field}` };
  }
  return { ok: true, value: n };
}

function parseMonthRange(monthStr) {
  // monthStr: "YYYY-MM"
  if (!monthStr || typeof monthStr !== "string") return null;
  const m = monthStr.trim();
  if (!/^\d{4}-\d{2}$/.test(m)) return null;

  const [yy, mm] = m.split("-").map((x) => Number(x));
  const start = new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(yy, mm, 1, 0, 0, 0)); // next month
  return { start, end };
}

function normalizeUnit(v) {
  if (!v) return undefined;
  const u = String(v).trim().toUpperCase();
  const allowed = new Set(["UN", "M", "M2", "M3", "L", "KG", "CX", "OUTRO"]);
  return allowed.has(u) ? u : null;
}

function normalizeMovementType(v) {
  if (!v) return undefined;
  const t = String(v).trim().toUpperCase();
  const allowed = new Set(["IN", "OUT", "ADJUST"]);
  return allowed.has(t) ? t : null;
}

function normalizeMovementSource(v) {
  if (!v) return undefined;
  const s = String(v).trim().toUpperCase();
  const allowed = new Set(["MANUAL", "ORDER", "PURCHASE"]);
  return allowed.has(s) ? s : null;
}

// --------------------
// Materials (Catalog)
// --------------------
// GET /api/materials?q=...&active=1
async function listMaterials(req, res) {
  const { salonId } = req.user;

  const q = String(req.query.q || "").trim();
  const active = req.query.active === undefined ? null : String(req.query.active) === "1";

  const where = { salonId };
  if (active !== null) where.isActive = active;

  if (q) {
    where.name = { contains: q, mode: "insensitive" };
  }

  const materials = await prisma.material.findMany({
    where,
    orderBy: [{ name: "asc" }],
    select: {
      id: true,
      name: true,
      unit: true,
      defaultUnitCostCents: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
    take: 100,
  });

  return res.json({ materials });
}

// POST /api/materials
async function createMaterial(req, res) {
  const { salonId } = req.user;

  const { name, unit, defaultUnitCostCents, isActive } = req.body || {};

  const n = String(name || "").trim();
  if (n.length < 2) return res.status(400).json({ message: "name é obrigatório (mín 2 caracteres)." });

  const unitNorm = normalizeUnit(unit) || "UN";
  if (unit !== undefined && unitNorm === null) return res.status(400).json({ message: "unit inválida." });

  const cost = defaultUnitCostCents !== undefined ? toInt(defaultUnitCostCents, "defaultUnitCostCents") : { ok: true, value: 0 };
  if (!cost.ok) return res.status(400).json({ message: cost.message });
  if (cost.value < 0) return res.status(400).json({ message: "defaultUnitCostCents inválido." });

  try {
    const created = await prisma.material.create({
      data: {
        salonId,
        name: n,
        unit: unitNorm,
        defaultUnitCostCents: cost.value,
        isActive: isActive === undefined ? true : Boolean(isActive),
      },
      select: {
        id: true,
        name: true,
        unit: true,
        defaultUnitCostCents: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.status(201).json({ material: created });
  } catch (e) {
    // unique constraint (salonId, name)
    return res.status(409).json({ message: "Material já existe (mesmo nome)." });
  }
}

// GET /api/materials/:id
async function getMaterial(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const material = await prisma.material.findFirst({
    where: { id, salonId },
    select: {
      id: true,
      name: true,
      unit: true,
      defaultUnitCostCents: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!material) return res.status(404).json({ message: "Material não encontrado." });
  return res.json({ material });
}

// PATCH /api/materials/:id
async function updateMaterial(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.material.findFirst({ where: { id, salonId }, select: { id: true } });
  if (!exists) return res.status(404).json({ message: "Material não encontrado." });

  const { name, unit, defaultUnitCostCents, isActive } = req.body || {};
  const data = {};

  if (name !== undefined) {
    const n = String(name || "").trim();
    if (n.length < 2) return res.status(400).json({ message: "name inválido (mín 2 caracteres)." });
    data.name = n;
  }

  if (unit !== undefined) {
    const unitNorm = normalizeUnit(unit);
    if (unitNorm === null) return res.status(400).json({ message: "unit inválida." });
    data.unit = unitNorm;
  }

  if (defaultUnitCostCents !== undefined) {
    const cost = toInt(defaultUnitCostCents, "defaultUnitCostCents");
    if (!cost.ok) return res.status(400).json({ message: cost.message });
    if (cost.value < 0) return res.status(400).json({ message: "defaultUnitCostCents inválido." });
    data.defaultUnitCostCents = cost.value;
  }

  if (isActive !== undefined) data.isActive = Boolean(isActive);

  try {
    const updated = await prisma.material.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        unit: true,
        defaultUnitCostCents: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ material: updated });
  } catch (e) {
    return res.status(409).json({ message: "Material já existe (mesmo nome)." });
  }
}

// DELETE /api/materials/:id  (soft delete -> desativa)
async function deleteMaterial(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.material.findFirst({ where: { id, salonId }, select: { id: true } });
  if (!exists) return res.status(404).json({ message: "Material não encontrado." });

  await prisma.material.update({
    where: { id },
    data: { isActive: false },
    select: { id: true },
  });

  return res.json({ ok: true });
}

// --------------------
// Movements (Real control)
// --------------------
// GET /api/materials/movements?month=YYYY-MM
async function listMovements(req, res) {
  const { salonId } = req.user;

  const month = String(req.query.month || "").trim();
  const range = parseMonthRange(month);
  if (!range) return res.status(400).json({ message: "month inválido (use YYYY-MM)." });

  const movements = await prisma.materialMovement.findMany({
    where: {
      salonId,
      occurredAt: { gte: range.start, lt: range.end },
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
   include: {
  material: { select: { id: true, name: true, unit: true } },
  supplier: { select: { id: true, name: true, phone: true, type: true } },
},
  });

  return res.json({ movements });
}

// POST /api/materials/movements
async function createMovement(req, res) {
  const { salonId } = req.user;

  const {materialId, type, source, qty, unitCostCents, occurredAt, notes, orderId, supplierId, nfNumber} = req.body || {};


  if (!materialId) return res.status(400).json({ message: "materialId é obrigatório." });

  const mat = await prisma.material.findFirst({
    where: { id: materialId, salonId },
    select: { id: true },
  });
  if (!mat) return res.status(404).json({ message: "Material não encontrado." });

  const typeNorm = normalizeMovementType(type);
  if (!typeNorm) return res.status(400).json({ message: "type inválido (IN, OUT, ADJUST)." });

  let supplierIdFinal = null;
let nfNumberFinal = null;

if (typeNorm === "IN") {
  // fornecedor obrigatório (como seu front já valida)
  if (!supplierId) {
    return res.status(400).json({ message: "supplierId é obrigatório para Entrada (IN)." });
  }

  const supplier = await prisma.client.findFirst({
    where: { id: supplierId, salonId },
    select: { id: true, type: true },
  });

  if (!supplier) return res.status(404).json({ message: "Fornecedor não encontrado." });

  const t = String(supplier.type || "").toUpperCase();
  if (t !== "FORNECEDOR" && t !== "BOTH") {
    return res.status(400).json({ message: "Cliente selecionado não é FORNECEDOR/BOTH." });
  }

  supplierIdFinal = supplierId;
  nfNumberFinal = nfNumber ? String(nfNumber).trim().slice(0, 50) : null;
} else {
  // OUT/ADJUST não guarda fornecedor/NF
  supplierIdFinal = null;
  nfNumberFinal = null;
}


  const sourceNorm = normalizeMovementSource(source) || "MANUAL";
  if (source !== undefined && sourceNorm === null) return res.status(400).json({ message: "source inválido." });

  const q = toFloat(qty, "qty");
  if (!q.ok) return res.status(400).json({ message: q.message });
  if (q.value <= 0) return res.status(400).json({ message: "qty deve ser > 0." });

  const cost = unitCostCents !== undefined ? toInt(unitCostCents, "unitCostCents") : { ok: true, value: 0 };
  if (!cost.ok) return res.status(400).json({ message: cost.message });
  if (cost.value < 0) return res.status(400).json({ message: "unitCostCents inválido." });

  const occ = occurredAt ? new Date(occurredAt) : new Date();
  if (Number.isNaN(occ.getTime())) return res.status(400).json({ message: "occurredAt inválido (use ISO date)." });

  const created = await prisma.materialMovement.create({
  data: {
    salonId,
    materialId,
    type: typeNorm,
    source: sourceNorm,
    qty: q.value,
    unitCostCents: cost.value,
    occurredAt: occ,
    notes: notes ? String(notes).trim() : null,
    orderId: orderId || null,

    supplierId: supplierIdFinal,
    nfNumber: nfNumberFinal,
  },
  include: {
    material: { select: { id: true, name: true, unit: true } },
    supplier: { select: { id: true, name: true, phone: true, type: true } },
  },
});


  return res.status(201).json({ movement: created });
}

// GET /api/materials/stock
async function materialsStock(req, res) {
  const { salonId } = req.user;

  // pega todos materiais ativos (ou todos, se você quiser)
  const materials = await prisma.material.findMany({
    where: { salonId },
    select: {
      id: true,
      name: true,
      unit: true,
      defaultUnitCostCents: true,
      isActive: true,
    },
    orderBy: { name: "asc" },
  });

  // pega movimentos (tudo, pra saldo real)
  const movements = await prisma.materialMovement.findMany({
    where: { salonId },
    select: { materialId: true, type: true, qty: true },
  });

  const map = new Map(); // materialId -> { in, out, adjust }
  for (const mv of movements) {
    const cur = map.get(mv.materialId) || { inQty: 0, outQty: 0, adjustQty: 0 };
    if (mv.type === "IN") cur.inQty += Number(mv.qty || 0);
    else if (mv.type === "OUT") cur.outQty += Number(mv.qty || 0);
    else cur.adjustQty += Number(mv.qty || 0); // ADJUST soma (se quiser ajuste negativo, a gente evolui depois)
    map.set(mv.materialId, cur);
  }

  const stock = materials.map((m) => {
    const s = map.get(m.id) || { inQty: 0, outQty: 0, adjustQty: 0 };
    const balanceQty = (s.inQty + s.adjustQty) - s.outQty;
    return {
      materialId: m.id,
      name: m.name,
      unit: m.unit,
      isActive: m.isActive,
      defaultUnitCostCents: m.defaultUnitCostCents,
      inQty: s.inQty,
      outQty: s.outQty,
      adjustQty: s.adjustQty,
      balanceQty,
    };
  });

  return res.json({ stock });
}


// GET /api/materials/summary?month=YYYY-MM
async function materialsSummary(req, res) {
  const { salonId } = req.user;

  const month = String(req.query.month || "").trim();
  const range = parseMonthRange(month);
  if (!range) return res.status(400).json({ message: "month inválido (use YYYY-MM)." });

  const movements = await prisma.materialMovement.findMany({
    where: {
      salonId,
      occurredAt: { gte: range.start, lt: range.end },
    },
    include: {
      material: { select: { id: true, name: true, unit: true } },
    },
    orderBy: [{ occurredAt: "asc" }],
  });

  // Total gasto (compras): soma de IN (qty * unitCostCents)
  let totalInCents = 0;
  let totalOutCents = 0;

  const byMaterial = new Map(); // materialId -> stats
  for (const mv of movements) {
    const totalCents = Math.round((mv.qty || 0) * (mv.unitCostCents || 0));

    if (mv.type === "IN") totalInCents += totalCents;
    if (mv.type === "OUT") totalOutCents += totalCents;

    const mid = mv.materialId;
    const cur = byMaterial.get(mid) || {
      materialId: mid,
      name: mv.material?.name || "-",
      unit: mv.material?.unit || "UN",
      inQty: 0,
      inCents: 0,
      outQty: 0,
      outCents: 0,
      adjustQty: 0,
      adjustCents: 0,
    };

    if (mv.type === "IN") {
      cur.inQty += mv.qty;
      cur.inCents += totalCents;
    } else if (mv.type === "OUT") {
      cur.outQty += mv.qty;
      cur.outCents += totalCents;
    } else {
      cur.adjustQty += mv.qty;
      cur.adjustCents += totalCents;
    }

    byMaterial.set(mid, cur);
  }

  const materials = Array.from(byMaterial.values()).sort((a, b) => b.inCents - a.inCents);

  // top 10 por custo de compra no mês
  const topByCost = materials.slice(0, 10);

  return res.json({
    month,
    totals: {
      totalInCents,
      totalOutCents,
    },
    topByCost,
    materials,
  });
}

module.exports = {
  // catalog
  listMaterials,
  createMaterial,
  getMaterial,
  updateMaterial,
  deleteMaterial,

  // movements
  listMovements,
  createMovement,

  // summary
  materialsSummary,
  materialsStock,
};
