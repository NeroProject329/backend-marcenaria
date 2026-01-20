const { prisma } = require("../lib/prisma");

const VALID_TYPES = new Set(["FIXO", "VARIAVEL"]);

function toInt(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: `Campo inválido: ${field}` };
  }
  return { ok: true, value: n };
}

function monthRange(monthStr) {
  const [y, m] = String(monthStr || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;

  // UTC pra evitar “pular dia” por timezone
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { from, to };
}


function toDate(v, field) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) {
    return { ok: false, message: `Data inválida: ${field}` };
  }
  return { ok: true, value: d };
}

function normalizeType(v) {
  if (!v) return null;
  const t = String(v).trim().toUpperCase();
  return VALID_TYPES.has(t) ? t : null;
}

// GET /api/costs?type=&from=&to=&supplierId=
async function listCosts(req, res) {
  const { salonId } = req.user;
  const { type, from, to, supplierId } = req.query;

  const where = { salonId };

  if (type) {
    const t = normalizeType(type);
    if (!t) return res.status(400).json({ message: "type inválido (FIXO ou VARIAVEL)." });
    where.type = t;
  }

  if (supplierId) where.supplierId = supplierId;

  if (from || to) {
    where.occurredAt = {};
    if (from) {
      const d = toDate(from, "from");
      if (!d.ok) return res.status(400).json({ message: d.message });
      where.occurredAt.gte = d.value;
    }
    if (to) {
      const d = toDate(to, "to");
      if (!d.ok) return res.status(400).json({ message: d.message });
      where.occurredAt.lte = d.value;
    }
  }

  const costs = await prisma.cost.findMany({
    where,
    orderBy: { occurredAt: "desc" },
    select: {
      id: true,
      name: true,
      description: true,
      type: true,
      amountCents: true,
      occurredAt: true,
      createdAt: true,
      supplier: { select: { id: true, name: true, type: true } },
    },
  });

  return res.json({ costs });
}

// GET /api/costs/:id
async function getCost(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const cost = await prisma.cost.findFirst({
    where: { id, salonId },
    select: {
      id: true,
      name: true,
      description: true,
      type: true,
      amountCents: true,
      occurredAt: true,
      createdAt: true,
      updatedAt: true,
      supplier: { select: { id: true, name: true, phone: true, type: true } },
    },
  });

  if (!cost) return res.status(404).json({ message: "Custo não encontrado." });
  return res.json({ cost });
}

// POST /api/costs
// body: { name, type, amountCents, occurredAt, description?, supplierId? }
async function createCost(req, res) {
  const { salonId } = req.user;
  const { name, type, amountCents, occurredAt, description, supplierId } = req.body;

  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ message: "name é obrigatório." });
  }

  const t = normalizeType(type);
  if (!t) return res.status(400).json({ message: "type inválido (FIXO ou VARIAVEL)." });

  const amt = toInt(amountCents, "amountCents");
  if (!amt.ok || amt.value <= 0) {
    return res.status(400).json({ message: "amountCents inválido." });
  }

  // ✅ occurredAt opcional: se não vier, usa hoje
let occDate = new Date();
if (occurredAt !== undefined && occurredAt !== null && occurredAt !== "") {
  const occ = toDate(occurredAt, "occurredAt");
  if (!occ.ok) return res.status(400).json({ message: occ.message });
  occDate = occ.value;
}


  if (supplierId) {
    const supplier = await prisma.client.findFirst({
      where: { id: supplierId, salonId },
      select: { id: true, type: true },
    });
    if (!supplier) return res.status(404).json({ message: "Fornecedor não encontrado." });
    if (supplier.type !== "FORNECEDOR" && supplier.type !== "BOTH") {
      return res.status(400).json({ message: "supplierId precisa ser FORNECEDOR ou BOTH." });
    }
  }

  const cost = await prisma.cost.create({
    data: {
      salonId,
      name: String(name).trim(),
      type: t,
      amountCents: amt.value,
      occurredAt: occDate,
      description: description ? String(description).trim() : null,
      supplierId: supplierId || null,
    },
    select: {
      id: true,
      name: true,
      type: true,
      amountCents: true,
      occurredAt: true,
      supplier: { select: { id: true, name: true, type: true } },
    },
  });

  return res.status(201).json({ cost });
}

// PATCH /api/costs/:id
async function updateCost(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;
  const { name, type, amountCents, occurredAt, description, supplierId } = req.body;

  const exists = await prisma.cost.findFirst({
    where: { id, salonId },
    select: { id: true },
  });
  if (!exists) return res.status(404).json({ message: "Custo não encontrado." });

  const data = {};

  if (name !== undefined) {
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ message: "name inválido." });
    }
    data.name = String(name).trim();
  }

  if (type !== undefined) {
    const t = normalizeType(type);
    if (!t) return res.status(400).json({ message: "type inválido (FIXO ou VARIAVEL)." });
    data.type = t;
  }

  if (amountCents !== undefined) {
    const amt = toInt(amountCents, "amountCents");
    if (!amt.ok || amt.value <= 0) {
      return res.status(400).json({ message: "amountCents inválido." });
    }
    data.amountCents = amt.value;
  }

  if (occurredAt !== undefined) {
    const occ = toDate(occurredAt, "occurredAt");
    if (!occ.ok) return res.status(400).json({ message: occ.message });
    data.occurredAt = occ.value;
  }

  if (description !== undefined) {
    data.description = description ? String(description).trim() : null;
  }

  if (supplierId !== undefined) {
    if (!supplierId) {
      data.supplierId = null;
    } else {
      const supplier = await prisma.client.findFirst({
        where: { id: supplierId, salonId },
        select: { id: true, type: true },
      });
      if (!supplier) return res.status(404).json({ message: "Fornecedor não encontrado." });
      if (supplier.type !== "FORNECEDOR" && supplier.type !== "BOTH") {
        return res.status(400).json({ message: "supplierId precisa ser FORNECEDOR ou BOTH." });
      }
      data.supplierId = supplierId;
    }
  }

  const cost = await prisma.cost.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      type: true,
      amountCents: true,
      occurredAt: true,
      supplier: { select: { id: true, name: true, type: true } },
    },
  });

  return res.json({ cost });
}

// DELETE /api/costs/:id
async function deleteCost(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.cost.findFirst({
    where: { id, salonId },
    select: { id: true },
  });
  if (!exists) return res.status(404).json({ message: "Custo não encontrado." });

  await prisma.cost.delete({ where: { id } });
  return res.json({ ok: true });
}

async function costSummary(req, res) {
  const { salonId } = req.user;

  const month = String(req.query.month || "").trim();
  const range = monthRange(month);
  if (!range) {
    return res.status(400).json({ message: "month inválido. Use YYYY-MM" });
  }

  const workDaysRaw = req.query.workDays;
  const workDays = workDaysRaw ? Number(workDaysRaw) : 22;
  if (!Number.isFinite(workDays) || workDays <= 0 || !Number.isInteger(workDays)) {
    return res.status(400).json({ message: "workDays inválido (inteiro > 0)." });
  }

  // busca custos do mês
  const costs = await prisma.cost.findMany({
    where: {
      salonId,
      occurredAt: { gte: range.from, lt: range.to },
    },
    select: { type: true, amountCents: true },
  });

  const fixedCents = costs
    .filter((c) => c.type === "FIXO")
    .reduce((a, c) => a + (c.amountCents || 0), 0);

  const variableCents = costs
    .filter((c) => c.type === "VARIAVEL")
    .reduce((a, c) => a + (c.amountCents || 0), 0);

  const totalCents = fixedCents + variableCents;

  // custo diário (arredonda para inteiro em centavos)
  const dailyCents = Math.round(totalCents / workDays);

  return res.json({
    month,
    workDays,
    totals: {
      fixedCents,
      variableCents,
      totalCents,
      dailyCents,
    },
  });
}


module.exports = {
  listCosts,
  getCost,
  createCost,
  updateCost,
  deleteCost,
  costSummary, // ✅ novo
};
