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

function monthRange(monthStr) {
  const [y, m] = String(monthStr || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;

  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { from, to };
}

function monthKeyFromDate(d) {
  const dt = new Date(d);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthStartUTC(monthStr) {
  const range = monthRange(monthStr);
  if (!range) return null;
  return range.from; // primeiro dia do mês UTC
}

/**
 * ✅ Garante que TODOS custos recorrentes tenham um registro no month (YYYY-MM).
 * Regra:
 * - Para cada recurringGroupId, se não existir Cost no month, cria copiando o último valor conhecido (<= month).
 * - Edição em um mês só muda aquele mês. Meses futuros usam o “último conhecido” quando forem gerados.
 */
async function ensureRecurringMonth(salonId, month) {
  if (!monthRange(month)) return;

  const monthStart = monthStartUTC(month);
  if (!monthStart) return;

  await prisma.$transaction(async (tx) => {
    // 1) Pega todos os custos recorrentes “historicamente” até o mês alvo
    const recurringHistory = await tx.cost.findMany({
      where: {
        salonId,
        isRecurring: true,
        recurringGroupId: { not: null },
        yearMonth: { lte: month },
      },
      orderBy: [{ yearMonth: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        recurringGroupId: true,
        yearMonth: true,
        type: true,
        name: true,
        description: true,
        category: true,
        amountCents: true,
        supplierId: true,
      },
    });

    // 2) Descobre o “último custo conhecido” de cada grupo
    const lastByGroup = new Map();
    for (const c of recurringHistory) {
      const g = c.recurringGroupId;
      if (!g) continue;
      if (!lastByGroup.has(g)) lastByGroup.set(g, c); // como tá orderBy desc, o primeiro é o mais recente
    }
    const groups = Array.from(lastByGroup.keys());
    if (!groups.length) return;

    // 3) Quais desses grupos já têm registro no mês?
    const existingThisMonth = await tx.cost.findMany({
      where: {
        salonId,
        yearMonth: month,
        recurringGroupId: { in: groups },
      },
      select: { recurringGroupId: true },
    });
    const hasSet = new Set(existingThisMonth.map((x) => x.recurringGroupId));

    // 4) Cria os que faltam
    const toCreate = [];
    for (const g of groups) {
      if (hasSet.has(g)) continue;

      const base = lastByGroup.get(g);
      if (!base) continue;

      toCreate.push({
        salonId,
        type: base.type,
        name: base.name,
        description: base.description,
        category: base.category,
        isRecurring: true,
        recurringGroupId: g,
        yearMonth: month,
        amountCents: base.amountCents,
        occurredAt: monthStart,
        supplierId: base.supplierId || null,
      });
    }

    if (toCreate.length) {
      await tx.cost.createMany({ data: toCreate });
    }
  });
}

// GET /api/costs?month=YYYY-MM&type=&supplierId=
async function listCosts(req, res) {
  const { salonId } = req.user;
  const { type, supplierId, month } = req.query;

  const where = { salonId };

  if (type) {
    const t = normalizeType(type);
    if (!t) return res.status(400).json({ message: "type inválido (FIXO ou VARIAVEL)." });
    where.type = t;
  }

  if (supplierId) where.supplierId = supplierId;

  // ✅ Agora a listagem é mensal
  if (month) {
    const m = String(month).trim();
    if (!monthRange(m)) return res.status(400).json({ message: "month inválido. Use YYYY-MM" });

    // garante recorrentes no mês
    await ensureRecurringMonth(salonId, m);

    where.yearMonth = m;
  }

  const costs = await prisma.cost.findMany({
    where,
    orderBy: [{ yearMonth: "desc" }, { occurredAt: "desc" }],
    select: {
      id: true,
      name: true,
      description: true,
      type: true,
      category: true,
      isRecurring: true,
      recurringGroupId: true,
      yearMonth: true,
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
      category: true,
      isRecurring: true,
      recurringGroupId: true,
      yearMonth: true,
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
async function createCost(req, res) {
  const { salonId } = req.user;
  const {
    name,
    type,
    amountCents,
    occurredAt,
    description,
    supplierId,
    category,
    isRecurring,
  } = req.body;

  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ message: "name é obrigatório." });
  }

  const t = normalizeType(type);
  if (!t) return res.status(400).json({ message: "type inválido (FIXO ou VARIAVEL)." });

  const amt = toInt(amountCents, "amountCents");
  if (!amt.ok || amt.value <= 0) {
    return res.status(400).json({ message: "amountCents inválido." });
  }

  // occurredAt opcional
  let occDate = new Date();
  if (occurredAt !== undefined && occurredAt !== null && occurredAt !== "") {
    const occ = toDate(occurredAt, "occurredAt");
    if (!occ.ok) return res.status(400).json({ message: occ.message });
    occDate = occ.value;
  }

  const ym = monthKeyFromDate(occDate);

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

  const recurring = !!isRecurring;

  // ✅ se é recorrente, cria um grupo próprio
  const recurringGroupId = recurring ? `rec_${Date.now()}_${Math.random().toString(16).slice(2)}` : null;

  const cost = await prisma.cost.create({
    data: {
      salonId,
      name: String(name).trim(),
      type: t,
      amountCents: amt.value,
      occurredAt: occDate,
      yearMonth: ym,

      description: description ? String(description).trim() : null,
      category: category ? String(category).trim() : null,
      isRecurring: recurring,
      recurringGroupId,

      supplierId: supplierId || null,
    },
    select: {
      id: true,
      name: true,
      type: true,
      category: true,
      isRecurring: true,
      recurringGroupId: true,
      yearMonth: true,
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
  const {
    name,
    type,
    amountCents,
    occurredAt,
    description,
    supplierId,
    category,
    isRecurring,
  } = req.body;

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
    data.yearMonth = monthKeyFromDate(occ.value);
  }

  if (description !== undefined) {
    data.description = description ? String(description).trim() : null;
  }

  if (category !== undefined) {
    data.category = category ? String(category).trim() : null;
  }

  if (isRecurring !== undefined) {
    data.isRecurring = !!isRecurring;
    // não mexe em recurringGroupId aqui (pra não quebrar séries antigas)
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
      category: true,
      isRecurring: true,
      recurringGroupId: true,
      yearMonth: true,
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

// GET /api/costs/summary?month=YYYY-MM&workDays=22
async function costSummary(req, res) {
  const { salonId } = req.user;

  const month = String(req.query.month || "").trim();
  if (!monthRange(month)) {
    return res.status(400).json({ message: "month inválido. Use YYYY-MM" });
  }

  const workDaysRaw = req.query.workDays;
  const workDays = workDaysRaw ? Number(workDaysRaw) : 22;
  if (!Number.isFinite(workDays) || workDays <= 0 || !Number.isInteger(workDays)) {
    return res.status(400).json({ message: "workDays inválido (inteiro > 0)." });
  }

  // ✅ garante recorrentes no mês antes de somar
  await ensureRecurringMonth(salonId, month);

  const costs = await prisma.cost.findMany({
    where: {
      salonId,
      yearMonth: month,
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
  const dailyCents = Math.round(totalCents / workDays);

  return res.json({
    month,
    workDays,
    totals: { fixedCents, variableCents, totalCents, dailyCents },
  });
}

module.exports = {
  listCosts,
  getCost,
  createCost,
  updateCost,
  deleteCost,
  costSummary,
};
