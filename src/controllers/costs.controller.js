const { prisma } = require("../lib/prisma");

const VALID_TYPES = new Set(["FIXO", "VARIAVEL"]);

function toInt(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: `Campo inválido: ${field}` };
  }
  return { ok: true, value: n };
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

  const occ = toDate(occurredAt, "occurredAt");
  if (!occ.ok) return res.status(400).json({ message: occ.message });

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
      occurredAt: occ.value,
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

module.exports = {
  listCosts,
  getCost,
  createCost,
  updateCost,
  deleteCost,
};
