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

function daysInMonthUTC(year, monthIndex0) {
  // monthIndex0: 0-11
  return new Date(Date.UTC(year, monthIndex0 + 1, 0, 12, 0, 0)).getUTCDate();
}

function addMonthsUTC(date, monthsToAdd) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  // vai pro 1º dia do mês pra evitar overflow
  const base = new Date(Date.UTC(y, m, 1, 12, 0, 0));
  base.setUTCMonth(base.getUTCMonth() + monthsToAdd);

  const dim = daysInMonthUTC(base.getUTCFullYear(), base.getUTCMonth());
  base.setUTCDate(Math.min(day, dim));

  return base;
}

function buildPayableInstallments({ totalCents, count, firstDueDate, method, paidNow, paidAt }) {
  const n = Math.max(1, Math.min(48, Number(count || 1)));
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;

  const rows = [];
  for (let i = 1; i <= n; i++) {
    const amount = i === n ? base + remainder : base;
    const dueDate = addMonthsUTC(firstDueDate, i - 1);

    const isSingleAndPaid = Boolean(paidNow) && n === 1;

    rows.push({
      number: i,
      dueDate,
      amountCents: amount,
      status: isSingleAndPaid ? "PAGO" : "PENDENTE",
      paidAt: isSingleAndPaid ? paidAt : null,
      method: method || null,
    });
  }
  return rows;
}

function isValidPaymentMethod(m) {
  if (!m) return true;
  const v = String(m).toUpperCase();
  return ["PIX", "CARTAO", "DINHEIRO", "BOLETO", "TRANSFERENCIA", "OUTRO"].includes(v);
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

function monthKeyFromDate(d) {
  const dt = new Date(d);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}


// --------------------
// Materials (Catalog)
// --------------------
// GET /api/materials?q=...&active=1
// GET /api/materials?q=...&active=1&supplierId=...
async function listMaterials(req, res) {
  const { salonId } = req.user;

  const q = String(req.query.q || "").trim();
  const active = req.query.active === undefined ? null : String(req.query.active) === "1";
  const supplierId = req.query.supplierId ? String(req.query.supplierId).trim() : null;

  const where = { salonId };

  if (active !== null) where.isActive = active;

  // filtro por fornecedor (material que tenha pelo menos 1 preço daquele fornecedor)
  if (supplierId) {
    where.supplierPrices = { some: { supplierId } };
  }

  // busca por material OU fornecedor
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      {
        supplierPrices: {
          some: {
            supplier: { name: { contains: q, mode: "insensitive" } },
          },
        },
      },
    ];
  }

  const materials = await prisma.material.findMany({
    where,
    orderBy: [{ name: "asc" }],
    include: {
      supplierPrices: {
        orderBy: { unitCostCents: "asc" }, // já vem do menor pro maior
        include: {
          supplier: { select: { id: true, name: true, phone: true, type: true } },
        },
      },
    },
    take: 200,
  });

  // devolve também o "melhor preço" pronto pro front
  const mapped = materials.map((m) => {
    const best = (m.supplierPrices || [])[0] || null;
    return {
      id: m.id,
      name: m.name,
      unit: m.unit,
      defaultUnitCostCents: m.defaultUnitCostCents,
      isActive: m.isActive,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,

      supplierPrices: (m.supplierPrices || []).map((sp) => ({
        id: sp.id,
        supplierId: sp.supplierId,
        unitCostCents: sp.unitCostCents,
        supplier: sp.supplier,
      })),

      bestSupplier: best
        ? {
            supplierId: best.supplierId,
            name: best.supplier?.name || "-",
            unitCostCents: best.unitCostCents,
          }
        : null,
    };
  });

  return res.json({ materials: mapped });
}


// POST /api/materials
async function createMaterial(req, res) {
  const { salonId } = req.user;

  const { name, unit, defaultUnitCostCents, isActive, suppliers } = req.body || {};

  const n = String(name || "").trim();
  if (n.length < 2) return res.status(400).json({ message: "name é obrigatório (mín 2 caracteres)." });

  const unitNorm = normalizeUnit(unit) || "UN";
  if (unit !== undefined && unitNorm === null) return res.status(400).json({ message: "unit inválida." });

  const cost = defaultUnitCostCents !== undefined
    ? toInt(defaultUnitCostCents, "defaultUnitCostCents")
    : { ok: true, value: 0 };
  if (!cost.ok) return res.status(400).json({ message: cost.message });
  if (cost.value < 0) return res.status(400).json({ message: "defaultUnitCostCents inválido." });

  // --- valida suppliers ---
  const supplierList = Array.isArray(suppliers) ? suppliers : [];
  const cleaned = supplierList
    .map((s) => ({
      supplierId: s?.supplierId ? String(s.supplierId).trim() : null,
      unitCostCents: Number(s?.unitCostCents),
    }))
    .filter((s) => s.supplierId && Number.isInteger(s.unitCostCents) && s.unitCostCents >= 0);

  // remove duplicados por supplierId (último vence)
  const uniqMap = new Map();
  cleaned.forEach((s) => uniqMap.set(s.supplierId, s));
  const uniq = Array.from(uniqMap.values());

  // se veio fornecedor, valida se é FORNECEDOR/BOTH do mesmo salão
  if (uniq.length) {
    const ids = uniq.map((x) => x.supplierId);
    const found = await prisma.client.findMany({
      where: { salonId, id: { in: ids }, type: { in: ["FORNECEDOR", "BOTH"] } },
      select: { id: true },
    });

    const okSet = new Set(found.map((f) => f.id));
    const invalid = ids.filter((id) => !okSet.has(id));
    if (invalid.length) {
      return res.status(400).json({ message: "Há fornecedor inválido (não é FORNECEDOR/BOTH ou não pertence ao salão)." });
    }
  }

  try {
    const created = await prisma.material.create({
      data: {
        salonId,
        name: n,
        unit: unitNorm,
        defaultUnitCostCents: cost.value,
        isActive: isActive === undefined ? true : Boolean(isActive),
      },
      select: { id: true },
    });

    if (uniq.length) {
      await prisma.materialSupplierPrice.createMany({
        data: uniq.map((s) => ({
          materialId: created.id,
          supplierId: s.supplierId,
          unitCostCents: s.unitCostCents,
        })),
        skipDuplicates: true,
      });
    }

    // devolve completo já
    const materialFull = await prisma.material.findFirst({
      where: { id: created.id, salonId },
      include: {
        supplierPrices: {
          orderBy: { unitCostCents: "asc" },
          include: { supplier: { select: { id: true, name: true, phone: true, type: true } } },
        },
      },
    });

    return res.status(201).json({ material: materialFull });
  } catch (e) {
    return res.status(409).json({ message: "Material já existe (mesmo nome)." });
  }
}


// GET /api/materials/:id
async function getMaterial(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const material = await prisma.material.findFirst({
    where: { id, salonId },
    include: {
      supplierPrices: {
        orderBy: { unitCostCents: "asc" },
        include: { supplier: { select: { id: true, name: true, phone: true, type: true } } },
      },
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

  const { name, unit, defaultUnitCostCents, isActive, suppliers } = req.body || {};
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

  // --- suppliers update (se veio no payload) ---
  const hasSuppliersField = Object.prototype.hasOwnProperty.call(req.body || {}, "suppliers");
  let uniq = null;

  if (hasSuppliersField) {
    const supplierList = Array.isArray(suppliers) ? suppliers : [];
    const cleaned = supplierList
      .map((s) => ({
        supplierId: s?.supplierId ? String(s.supplierId).trim() : null,
        unitCostCents: Number(s?.unitCostCents),
      }))
      .filter((s) => s.supplierId && Number.isInteger(s.unitCostCents) && s.unitCostCents >= 0);

    const uniqMap = new Map();
    cleaned.forEach((s) => uniqMap.set(s.supplierId, s));
    uniq = Array.from(uniqMap.values());

    if (uniq.length) {
      const ids = uniq.map((x) => x.supplierId);
      const found = await prisma.client.findMany({
        where: { salonId, id: { in: ids }, type: { in: ["FORNECEDOR", "BOTH"] } },
        select: { id: true },
      });

      const okSet = new Set(found.map((f) => f.id));
      const invalid = ids.filter((id) => !okSet.has(id));
      if (invalid.length) {
        return res.status(400).json({ message: "Há fornecedor inválido (não é FORNECEDOR/BOTH ou não pertence ao salão)." });
      }
    }
  }

  try {
    await prisma.material.update({
      where: { id },
      data,
      select: { id: true },
    });

    // se veio suppliers no PATCH, substitui lista inteira (simples e confiável)
    if (uniq !== null) {
      await prisma.materialSupplierPrice.deleteMany({ where: { materialId: id } });

      if (uniq.length) {
        await prisma.materialSupplierPrice.createMany({
          data: uniq.map((s) => ({
            materialId: id,
            supplierId: s.supplierId,
            unitCostCents: s.unitCostCents,
          })),
          skipDuplicates: true,
        });
      }
    }

    const materialFull = await prisma.material.findFirst({
      where: { id, salonId },
      include: {
        supplierPrices: {
          orderBy: { unitCostCents: "asc" },
          include: { supplier: { select: { id: true, name: true, phone: true, type: true } } },
        },
      },
    });

    return res.json({ material: materialFull });
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
  try {
    const salonId = req.salonId;

    const {
      month,              // modo antigo (lista do mês)
      materialId,         // modo novo (histórico por produto)
      type,               // IN | OUT | ADJUST
      q,                  // busca (produto/fornecedor/nf/obs)
      from,               // YYYY-MM-DD
      to,                 // YYYY-MM-DD
      limit = "50",
      offset = "0",
    } = req.query;

    const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = Math.max(parseInt(offset, 10) || 0, 0);

    // ===========================
    // ✅ MODO NOVO: histórico por material
    // ===========================
    if (materialId) {
      const where = { salonId, materialId };

      if (type && ["IN", "OUT", "ADJUST"].includes(type)) {
        where.type = type;
      }

      if (from || to) {
        where.occurredAt = {};
        if (from) {
          const d = new Date(from);
          d.setHours(0, 0, 0, 0);
          where.occurredAt.gte = d;
        }
        if (to) {
          const d = new Date(to);
          d.setHours(23, 59, 59, 999);
          where.occurredAt.lte = d;
        }
      }

      const total = await prisma.materialMovement.count({ where });

      const movements = await prisma.materialMovement.findMany({
        where,
        include: { material: true, supplier: true },
        orderBy: { occurredAt: "desc" },
        skip,
        take,
      });

      return res.json({ movements, total, limit: take, offset: skip });
    }

    // ===========================
    // ✅ MODO ANTIGO: lista do mês (com filtros extras)
    // ===========================
    if (!month) {
      return res.status(400).json({ error: "month é obrigatório (ex: 2026-01) quando materialId não for enviado." });
    }

    const { start, end } = parseMonthRange(month);

    const where = {
      salonId,
      occurredAt: { gte: start, lt: end },
    };

    if (type && ["IN", "OUT", "ADJUST"].includes(type)) {
      where.type = type;
    }

    if (q && String(q).trim()) {
      const query = String(q).trim();
      where.OR = [
        { material: { name: { contains: query, mode: "insensitive" } } },
        { supplier: { name: { contains: query, mode: "insensitive" } } },
        { nfNumber: { contains: query, mode: "insensitive" } },
        { notes: { contains: query, mode: "insensitive" } },
      ];
    }

    if (from || to) {
      where.occurredAt = {};
      if (from) {
        const d = new Date(from);
        d.setHours(0, 0, 0, 0);
        where.occurredAt.gte = d;
      } else {
        where.occurredAt.gte = start;
      }

      if (to) {
        const d = new Date(to);
        d.setHours(23, 59, 59, 999);
        where.occurredAt.lte = d;
      } else {
        // mantém o range do mês
        const d = new Date(end);
        d.setMilliseconds(d.getMilliseconds() - 1);
        where.occurredAt.lte = d;
      }
    }

    const movements = await prisma.materialMovement.findMany({
      where,
      include: { material: true, supplier: true },
      orderBy: { occurredAt: "desc" },
      
    });

    return res.json({ movements });
  } catch (err) {
    console.error("listMovements error:", err);
    return res.status(500).json({ error: "Erro ao listar movimentações." });
  }
}

// POST /api/materials/movements
// POST /api/materials/movements
async function createMovement(req, res) {
  const { salonId } = req.user;

  const {
    type,
    materialId,
    qty,
    unitCostCents,
    occurredAt,
    notes,
    source = "MANUAL",

    supplierId,
    nfNumber,

    // ✅ NOVO: opcional (quando for compra parcelada)
    payable, 
    // payable: {
    //   enabled?: boolean,
    //   installmentsCount?: number,
    //   firstDueDate?: string|Date,
    //   method?: "PIX"|"CARTAO"|...,
    //   paidNow?: boolean,
    //   description?: string
    // }
  } = req.body || {};

  if (!type || !["IN", "OUT", "ADJUST"].includes(type)) {
    return res.status(400).json({ message: "Tipo inválido (IN/OUT/ADJUST)." });
  }
  if (!materialId) return res.status(400).json({ message: "materialId é obrigatório." });

  const qtyN = toFloat(qty);
  if (!Number.isFinite(qtyN) || qtyN <= 0) {
    return res.status(400).json({ message: "Quantidade inválida." });
  }

  const occurredAtDt = toDate(occurredAt);
  if (!occurredAtDt) return res.status(400).json({ message: "Data inválida." });

  // OUT não precisa custo / fornecedor / NF
  let unitCents = toInt(unitCostCents);
  let supId = supplierId || null;
  let nf = (nfNumber || "").trim() || null;

  if (type === "OUT") {
    unitCents = 0;
    supId = null;
    nf = null;
  }

  // IN exige fornecedor
  if (type === "IN") {
    if (!supId) return res.status(400).json({ message: "Fornecedor é obrigatório na entrada (IN)." });
    if (!Number.isFinite(unitCents) || unitCents <= 0) {
      return res.status(400).json({ message: "Custo unitário inválido." });
    }
  }

  // valida material
  const mat = await prisma.material.findFirst({
    where: { id: materialId, salonId },
    select: { id: true, name: true, unit: true, isActive: true },
  });
  if (!mat) return res.status(404).json({ message: "Material não encontrado." });

  // IN: valida fornecedor (tipo FORNECEDOR/BOTH)
  if (type === "IN") {
    const supplier = await prisma.client.findFirst({
      where: {
        id: supId,
        salonId,
        OR: [{ type: "FORNECEDOR" }, { type: "BOTH" }],
      },
      select: { id: true },
    });
    if (!supplier) return res.status(400).json({ message: "Fornecedor inválido." });
  }

  // ✅ decide se cria Payable
  const p = payable && typeof payable === "object" ? payable : null;
  const wantPayable =
    type === "IN" &&
    !!p &&
    (p.enabled === true ||
      Number(p.installmentsCount || 0) > 0 ||
      !!p.firstDueDate ||
      !!p.method);

  if (wantPayable) {
    if (!isValidPaymentMethod(p.method)) {
      return res.status(400).json({ message: "Método de pagamento do payable inválido." });
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let payableId = null;

      // =========================
      // 1) (opcional) cria PAYABLE + parcelas
      // =========================
      if (wantPayable) {
        const totalCents = Math.round(qtyN * unitCents);

        const installmentsCount = Math.max(1, Math.min(48, toInt(p.installmentsCount || 1) || 1));
        const firstDue = toDate(p.firstDueDate) || occurredAtDt;

        const method = p.method ? String(p.method).toUpperCase() : null;

        const description =
          (p.description || "").trim() ||
          `Compra de estoque: ${mat.name}${nf ? ` • NF ${nf}` : ""}`;

        const installments = buildPayableInstallments({
          totalCents,
          count: installmentsCount,
          firstDueDate: firstDue,
          method,
          paidNow: Boolean(p.paidNow),
          paidAt: occurredAtDt,
        });

        const createdPayable = await tx.payable.create({
          data: {
            salonId,
            supplierId: supId,
            description,
            totalCents,
            installments: { create: installments },
          },
          select: { id: true },
        });

        payableId = createdPayable.id;
      }

      // =========================
      // 2) cria MOVEMENT (linka payableId se existir)
      // =========================
      const created = await tx.materialMovement.create({
        data: {
          salonId,
          materialId,
          type,
          source,
          qty: qtyN,
          unitCostCents: unitCents,
          occurredAt: occurredAtDt,
          notes: notes || null,
          supplierId: type === "IN" ? supId : null,
          nfNumber: type === "IN" ? nf : null,
          payableId: payableId,
        },
        select: {
          id: true,
          type: true,
          source: true,
          qty: true,
          unitCostCents: true,
          occurredAt: true,
          notes: true,
          nfNumber: true,
          supplierId: true,
          payableId: true,
          material: { select: { id: true, name: true, unit: true } },
          supplier: { select: { id: true, name: true, phone: true } },
          payable: payableId
            ? { select: { id: true, description: true, totalCents: true } }
            : false,
        },
      });

      // =========================
      // 3) mantém seu COST (como já era)
      // =========================
      if (type === "IN") {
        const amountCents = Math.round(qtyN * unitCents);
        const yearMonth = monthKeyFromDate(occurredAtDt);

        const descKey = `ESTOQUE:${supId}:${nf || "-"}:${mat.name}`;
        await tx.cost.create({
          data: {
            salonId,
            type: "VARIAVEL",
            name: `Compra de material — ${mat.name}`,
            description: nf ? `NF: ${nf}` : null,
            category: "Estoque",
            isRecurring: false,
            recurringGroupId: descKey,
            yearMonth,
            amountCents,
            occurredAt: occurredAtDt,
            supplierId: supId,
          },
        });
      }

      return created;
    });

    return res.status(201).json({ movement: result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Erro ao criar movimentação." });
  }
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
