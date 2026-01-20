const { prisma } = require("../lib/prisma");

// =====================
// Helpers (iguais Orders)
// =====================
function toInt(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: `Campo inválido: ${field}` };
  }
  return { ok: true, value: n };
}

function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseISODate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  while (d.getDate() < day) d.setDate(d.getDate() - 1);
  return d;
}

function splitIntoInstallments(totalCents, count) {
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  const arr = Array.from({ length: count }, () => base);
  arr[count - 1] = base + remainder;
  return arr;
}

function calcTotals(items, discountCents = 0) {
  const subtotal = items.reduce((sum, it) => sum + it.totalCents, 0);
  const total = Math.max(0, subtotal - (discountCents || 0));
  return { subtotalCents: subtotal, totalCents: total };
}

const VALID_PAYMENT_MODE = new Set(["AVISTA", "PARCELADO"]);
const VALID_PAYMENT_METHOD = new Set([
  "PIX",
  "CARTAO",
  "DINHEIRO",
  "BOLETO",
  "TRANSFERENCIA",
  "OUTRO",
]);

function normalizePaymentMode(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const m = String(v).trim().toUpperCase();
  return VALID_PAYMENT_MODE.has(m) ? m : null;
}

function normalizePaymentMethod(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const m = String(v).trim().toUpperCase();
  return VALID_PAYMENT_METHOD.has(m) ? m : null;
}

const VALID_BUDGET_STATUS = new Set([
  "RASCUNHO",
  "ENVIADO",
  "APROVADO",
  "REJEITADO",
  "CANCELADO",
]);

function normalizeBudgetStatus(v) {
  if (!v) return undefined;
  const s = String(v).trim().toUpperCase();
  return VALID_BUDGET_STATUS.has(s) ? s : null;
}

/**
 * Parcela custom do orçamento (sem status, sem paidAt)
 * Espera installments = [{ dueDate, amountCents }]
 */
function validateAndBuildBudgetInstallments({ installments, totalCents }) {
  if (!Array.isArray(installments) || installments.length < 2) {
    return { ok: false, error: "installments precisa ter no mínimo 2 parcelas." };
  }

  const normalized = installments.map((p, idx) => {
    const due = parseISODate(p?.dueDate);
    const amountCents = Number(p?.amountCents);

    if (!due) return { ok: false, error: `Parcela ${idx + 1}: dueDate inválido.` };
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return { ok: false, error: `Parcela ${idx + 1}: amountCents inválido.` };
    }

    return { ok: true, dueDate: due, amountCents: Math.trunc(amountCents) };
  });

  const bad = normalized.find((x) => x.ok === false);
  if (bad) return bad;

  const list = normalized
    .filter((x) => x.ok)
    .map((x) => ({ dueDate: x.dueDate, amountCents: x.amountCents }))
    .sort((a, b) => a.dueDate - b.dueDate);

  const sum = list.reduce((acc, p) => acc + p.amountCents, 0);
  if (sum !== totalCents) {
    return {
      ok: false,
      error: `Soma das parcelas (${sum}) diferente do total (${totalCents}).`,
    };
  }

  const installmentsData = list.map((p, idx) => ({
    number: idx + 1,
    dueDate: p.dueDate,
    amountCents: p.amountCents,
  }));

  return { ok: true, firstDueDate: installmentsData[0].dueDate, installmentsData };
}

// =====================
// GET /api/budgets
// =====================
async function listBudgets(req, res) {
  const { salonId } = req.user;

  const q = String(req.query.q || "").trim();
  const statusNorm = normalizeBudgetStatus(req.query.status);
  if (req.query.status && statusNorm === null) {
    return res.status(400).json({ message: "status inválido." });
  }

  const where = { salonId };
  if (statusNorm) where.status = statusNorm;

  if (q) {
    where.OR = [
      { client: { name: { contains: q, mode: "insensitive" } } },
      { client: { phone: { contains: q.replace(/\D/g, "") } } },
      { notes: { contains: q, mode: "insensitive" } },
    ];
  }

  const budgets = await prisma.budget.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      expectedDeliveryAt: true,
      subtotalCents: true,
      discountCents: true,
      totalCents: true,
      paymentMode: true,
      paymentMethod: true,
      installmentsCount: true,
      firstDueDate: true,
      approvedAt: true,
      approvedOrderId: true,
      client: { select: { id: true, name: true, phone: true, type: true } },
    },
  });

  return res.json({ budgets });
}

// =====================
// GET /api/budgets/:id
// =====================
async function getBudget(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const budget = await prisma.budget.findFirst({
    where: { id, salonId },
    include: {
      client: { select: { id: true, name: true, phone: true, instagram: true, notes: true, type: true } },
      items: { orderBy: { createdAt: "asc" } },
      installments: { orderBy: { number: "asc" } },
      approvedOrder: { select: { id: true, status: true, createdAt: true } },
    },
  });

  if (!budget) return res.status(404).json({ message: "Orçamento não encontrado." });
  return res.json({ budget });
}

// =====================
// POST /api/budgets
// =====================
async function createBudget(req, res) {
  const { salonId } = req.user;

  const {
    clientId,
    expectedDeliveryAt,
    notes,
    discountCents,
    items,

    paymentMode,
    paymentMethod,
    installmentsCount,
    firstDueDate,
    installments, // custom
  } = req.body;

  if (!clientId) return res.status(400).json({ message: "clientId é obrigatório." });

  const client = await prisma.client.findFirst({
    where: { id: clientId, salonId },
    select: { id: true },
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado." });

  const exp = toDateOrNull(expectedDeliveryAt);
  if (expectedDeliveryAt && !exp) {
    return res.status(400).json({ message: "expectedDeliveryAt inválido (use ISO date)." });
  }

  const disc = discountCents !== undefined ? toInt(discountCents, "discountCents") : { ok: true, value: 0 };
  if (!disc.ok) return res.status(400).json({ message: disc.message });
  if (disc.value < 0) return res.status(400).json({ message: "discountCents inválido." });

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "items deve ser um array com pelo menos 1 item." });
  }

  // normaliza itens
  const itemsNorm = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const name = String(it.name || "").trim();
    if (name.length < 2) return res.status(400).json({ message: `Item ${i + 1}: nome inválido.` });

    const q = toInt(it.quantity ?? 1, `items[${i}].quantity`);
    if (!q.ok) return res.status(400).json({ message: q.message });
    if (q.value <= 0) return res.status(400).json({ message: `Item ${i + 1}: quantity inválido.` });

    const up = toInt(it.unitPriceCents ?? 0, `items[${i}].unitPriceCents`);
    if (!up.ok) return res.status(400).json({ message: up.message });
    if (up.value < 0) return res.status(400).json({ message: `Item ${i + 1}: unitPriceCents inválido.` });

    itemsNorm.push({
      name,
      description: it.description ? String(it.description).trim() : null,
      quantity: q.value,
      unitPriceCents: up.value,
      totalCents: q.value * up.value,
    });
  }

  const totals = calcTotals(itemsNorm, disc.value);

  // pagamento sugerido
  const modeNorm = normalizePaymentMode(paymentMode) || "AVISTA";
  if (paymentMode !== undefined && modeNorm === null) {
    return res.status(400).json({ message: "paymentMode inválido (AVISTA ou PARCELADO)." });
  }

  const methodNorm = normalizePaymentMethod(paymentMethod);
  if (paymentMethod !== undefined && methodNorm === null) {
    return res.status(400).json({ message: "paymentMethod inválido." });
  }

  let count = 1;
  if (modeNorm === "PARCELADO") {
    const c = toInt(installmentsCount, "installmentsCount");
    if (!c.ok) return res.status(400).json({ message: c.message });
    if (c.value < 2 || c.value > 24) return res.status(400).json({ message: "installmentsCount deve ser entre 2 e 24." });
    count = c.value;
  }

  const parsedFirst = toDateOrNull(firstDueDate);
  if (firstDueDate && !parsedFirst) {
    return res.status(400).json({ message: "firstDueDate inválido (use ISO date)." });
  }

  // base (fallback) se não vier lista custom
  const baseDue = parsedFirst || exp || new Date();

  let finalFirstDueDate = baseDue;
  let budgetInstallmentsData = [];

  // custom installments (se PARCELADO e veio installments)
  if (modeNorm === "PARCELADO" && Array.isArray(installments) && installments.length) {
    if (installments.length !== count) {
      return res.status(400).json({
        message: `installments tem ${installments.length} parcelas, mas installmentsCount é ${count}.`,
      });
    }

    const built = validateAndBuildBudgetInstallments({
      installments,
      totalCents: totals.totalCents,
    });

    if (!built.ok) return res.status(400).json({ message: built.error });

    finalFirstDueDate = built.firstDueDate;
    budgetInstallmentsData = built.installmentsData;
  } else if (modeNorm === "PARCELADO") {
    // gera mensal automático (só para orçamento)
    const amounts = splitIntoInstallments(totals.totalCents, count);
    budgetInstallmentsData = amounts.map((amt, idx) => ({
      number: idx + 1,
      dueDate: addMonths(baseDue, idx),
      amountCents: amt,
    }));
    finalFirstDueDate = baseDue;
  } else {
    // AVISTA -> 1 parcela “virtual”
    budgetInstallmentsData = [];
    finalFirstDueDate = baseDue;
  }

  const created = await prisma.budget.create({
    data: {
      salonId,
      clientId,
      status: "RASCUNHO",
      expectedDeliveryAt: exp,
      notes: notes ? String(notes).trim() : null,
      discountCents: disc.value,
      subtotalCents: totals.subtotalCents,
      totalCents: totals.totalCents,

      paymentMode: modeNorm,
      paymentMethod: methodNorm || null,
      installmentsCount: count,
      firstDueDate: finalFirstDueDate,

      items: { create: itemsNorm },
      ...(budgetInstallmentsData.length ? { installments: { create: budgetInstallmentsData } } : {}),
    },
    include: {
      client: { select: { id: true, name: true, phone: true, type: true } },
      items: true,
      installments: { orderBy: { number: "asc" } },
    },
  });

  return res.status(201).json({ budget: created });
}

// =====================
// PATCH /api/budgets/:id  (simples)
// =====================
async function updateBudget(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.budget.findFirst({
    where: { id, salonId },
    select: { id: true, status: true },
  });
  if (!exists) return res.status(404).json({ message: "Orçamento não encontrado." });

  const { status, expectedDeliveryAt, notes } = req.body;

  const data = {};

  if (status !== undefined) {
    const s = normalizeBudgetStatus(status);
    if (s === null) return res.status(400).json({ message: "status inválido." });

    // trava: não deixa mexer se já aprovado
    if (exists.status === "APROVADO") {
      return res.status(409).json({ message: "Orçamento já aprovado. Não é possível alterar status." });
    }

    data.status = s;
  }

  if (expectedDeliveryAt !== undefined) {
    const d = toDateOrNull(expectedDeliveryAt);
    if (expectedDeliveryAt && !d) return res.status(400).json({ message: "expectedDeliveryAt inválido." });
    data.expectedDeliveryAt = d;
  }

  if (notes !== undefined) data.notes = notes ? String(notes).trim() : null;

  const budget = await prisma.budget.update({
    where: { id },
    data,
    select: {
      id: true,
      status: true,
      updatedAt: true,
      expectedDeliveryAt: true,
      notes: true,
    },
  });

  return res.json({ budget });
}

// =====================
// PATCH /api/budgets/:id/full
// =====================
async function updateBudgetFull(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.budget.findFirst({
    where: { id, salonId },
    select: { id: true, status: true },
  });
  if (!exists) return res.status(404).json({ message: "Orçamento não encontrado." });

  if (exists.status === "APROVADO") {
    return res.status(409).json({ message: "Orçamento já aprovado. Não é possível editar." });
  }

  const {
    clientId,
    status,
    expectedDeliveryAt,
    notes,
    discountCents,
    items,
    paymentMode,
    paymentMethod,
    installmentsCount,
    firstDueDate,
    installments, // custom
  } = req.body;

  if (!clientId) return res.status(400).json({ message: "clientId é obrigatório." });

  const client = await prisma.client.findFirst({
    where: { id: clientId, salonId },
    select: { id: true },
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado." });

  const statusNorm = status ? normalizeBudgetStatus(status) : undefined;
  if (status && statusNorm === null) return res.status(400).json({ message: "status inválido." });

  const exp = toDateOrNull(expectedDeliveryAt);
  if (expectedDeliveryAt && !exp) return res.status(400).json({ message: "expectedDeliveryAt inválido (use ISO date)." });

  const disc = discountCents !== undefined ? toInt(discountCents, "discountCents") : { ok: true, value: 0 };
  if (!disc.ok) return res.status(400).json({ message: disc.message });
  if (disc.value < 0) return res.status(400).json({ message: "discountCents inválido." });

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "items deve ser um array com pelo menos 1 item." });
  }

  // normaliza itens
  const itemsNorm = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const name = String(it.name || "").trim();
    if (name.length < 2) return res.status(400).json({ message: `Item ${i + 1}: nome inválido.` });

    const q = toInt(it.quantity ?? 1, `items[${i}].quantity`);
    if (!q.ok) return res.status(400).json({ message: q.message });
    if (q.value <= 0) return res.status(400).json({ message: `Item ${i + 1}: quantity inválido.` });

    const up = toInt(it.unitPriceCents ?? 0, `items[${i}].unitPriceCents`);
    if (!up.ok) return res.status(400).json({ message: up.message });
    if (up.value < 0) return res.status(400).json({ message: `Item ${i + 1}: unitPriceCents inválido.` });

    itemsNorm.push({
      name,
      description: it.description ? String(it.description).trim() : null,
      quantity: q.value,
      unitPriceCents: up.value,
      totalCents: q.value * up.value,
    });
  }

  const totals = calcTotals(itemsNorm, disc.value);

  // pagamento
  const modeNorm = normalizePaymentMode(paymentMode) || "AVISTA";
  if (paymentMode !== undefined && modeNorm === null) {
    return res.status(400).json({ message: "paymentMode inválido (AVISTA ou PARCELADO)." });
  }

  const methodNorm = normalizePaymentMethod(paymentMethod);
  if (paymentMethod !== undefined && methodNorm === null) {
    return res.status(400).json({ message: "paymentMethod inválido." });
  }

  let count = 1;
  if (modeNorm === "PARCELADO") {
    const c = toInt(installmentsCount, "installmentsCount");
    if (!c.ok) return res.status(400).json({ message: c.message });
    if (c.value < 2 || c.value > 24) return res.status(400).json({ message: "installmentsCount deve ser entre 2 e 24." });
    count = c.value;
  }

  const parsedFirst = toDateOrNull(firstDueDate);
  if (firstDueDate && !parsedFirst) return res.status(400).json({ message: "firstDueDate inválido (use ISO date)." });

  const baseDue = parsedFirst || exp || new Date();

  let finalFirstDueDate = baseDue;
  let budgetInstallmentsData = [];

  if (modeNorm === "PARCELADO" && Array.isArray(installments) && installments.length) {
    if (installments.length !== count) {
      return res.status(400).json({
        message: `installments tem ${installments.length} parcelas, mas installmentsCount é ${count}.`,
      });
    }

    const built = validateAndBuildBudgetInstallments({
      installments,
      totalCents: totals.totalCents,
    });

    if (!built.ok) return res.status(400).json({ message: built.error });

    finalFirstDueDate = built.firstDueDate;
    budgetInstallmentsData = built.installmentsData;
  } else if (modeNorm === "PARCELADO") {
    const amounts = splitIntoInstallments(totals.totalCents, count);
    budgetInstallmentsData = amounts.map((amt, idx) => ({
      number: idx + 1,
      dueDate: addMonths(baseDue, idx),
      amountCents: amt,
    }));
    finalFirstDueDate = baseDue;
  }

  await prisma.$transaction(async (tx) => {
    await tx.budget.update({
      where: { id },
      data: {
        clientId,
        ...(statusNorm ? { status: statusNorm } : {}),
        expectedDeliveryAt: exp,
        notes: notes ? String(notes).trim() : null,
        discountCents: disc.value,
        subtotalCents: totals.subtotalCents,
        totalCents: totals.totalCents,

        paymentMode: modeNorm,
        paymentMethod: methodNorm || null,
        installmentsCount: count,
        firstDueDate: finalFirstDueDate,
      },
      select: { id: true },
    });

    // troca itens
    await tx.budgetItem.deleteMany({ where: { budgetId: id } });
    await tx.budgetItem.createMany({
      data: itemsNorm.map((it) => ({ ...it, budgetId: id })),
    });

    // troca parcelas do orçamento (se tiver model)
    await tx.budgetInstallment.deleteMany({ where: { budgetId: id } });
    if (budgetInstallmentsData.length) {
      await tx.budgetInstallment.createMany({
        data: budgetInstallmentsData.map((p) => ({ ...p, budgetId: id })),
      });
    }
  });

  return res.json({ ok: true, budgetId: id });
}

// =====================
// POST /api/budgets/:id/send
// =====================
async function sendBudget(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const budget = await prisma.budget.findFirst({
    where: { id, salonId },
    select: { id: true, status: true },
  });
  if (!budget) return res.status(404).json({ message: "Orçamento não encontrado." });

  if (budget.status === "APROVADO") {
    return res.status(409).json({ message: "Orçamento já aprovado." });
  }

  const updated = await prisma.budget.update({
    where: { id },
    data: { status: "ENVIADO" },
    select: { id: true, status: true, updatedAt: true },
  });

  return res.json({ budget: updated });
}

// =====================
// POST /api/budgets/:id/cancel
// =====================
async function cancelBudget(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const budget = await prisma.budget.findFirst({
    where: { id, salonId },
    select: { id: true, status: true },
  });
  if (!budget) return res.status(404).json({ message: "Orçamento não encontrado." });

  if (budget.status === "APROVADO") {
    return res.status(409).json({ message: "Orçamento já aprovado. Não é possível cancelar." });
  }

  const updated = await prisma.budget.update({
    where: { id },
    data: { status: "CANCELADO" },
    select: { id: true, status: true, updatedAt: true },
  });

  return res.json({ budget: updated });
}

// =====================
// POST /api/budgets/:id/approve
// - Cria Order + Receivable (igual orders.controller)
// - Marca Budget como APROVADO e linka approvedOrderId
// =====================
async function approveBudget(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const budget = await prisma.budget.findFirst({
    where: { id, salonId },
    include: {
      items: true,
      installments: { orderBy: { number: "asc" } },
    },
  });

  if (!budget) return res.status(404).json({ message: "Orçamento não encontrado." });

  if (budget.status === "APROVADO") {
    return res.status(409).json({ message: "Orçamento já aprovado." });
  }
  if (budget.status === "CANCELADO") {
    return res.status(409).json({ message: "Orçamento cancelado. Não é possível aprovar." });
  }

  // cria installments para RECEIVABLE:
  // - se orçamento PARCELADO e tiver installments custom -> usa essas datas/valores
  // - senão gera mensal automático
  const now = new Date();

  let installmentsData = [];
  let finalFirstDueDate = budget.firstDueDate || budget.expectedDeliveryAt || now;

  if (budget.paymentMode === "PARCELADO") {
    if (Array.isArray(budget.installments) && budget.installments.length) {
      installmentsData = budget.installments.map((p) => ({
        number: p.number,
        dueDate: p.dueDate,
        amountCents: p.amountCents,
        status: "PENDENTE",
        paidAt: null,
        method: budget.paymentMethod || null,
      }));
      finalFirstDueDate = installmentsData[0]?.dueDate || finalFirstDueDate;
    } else {
      const baseDue = finalFirstDueDate;
      const amounts = splitIntoInstallments(budget.totalCents, budget.installmentsCount || 2);
      installmentsData = amounts.map((amt, idx) => ({
        number: idx + 1,
        dueDate: addMonths(baseDue, idx),
        amountCents: amt,
        status: "PENDENTE",
        paidAt: null,
        method: budget.paymentMethod || null,
      }));
    }
  } else {
    // AVISTA -> 1 parcela (pendente)
    installmentsData = [
      {
        number: 1,
        dueDate: finalFirstDueDate,
        amountCents: budget.totalCents,
        status: "PENDENTE",
        paidAt: null,
        method: budget.paymentMethod || null,
      },
    ];
  }

  const created = await prisma.$transaction(async (tx) => {
    // 1) cria Order com itens do Budget
    const order = await tx.order.create({
      data: {
        salonId,
        clientId: budget.clientId,
        status: "PEDIDO", // quando aprovar, vira pedido
        expectedDeliveryAt: budget.expectedDeliveryAt,
        notes: budget.notes,

        subtotalCents: budget.subtotalCents,
        discountCents: budget.discountCents,
        totalCents: budget.totalCents,

        paymentMode: budget.paymentMode,
        paymentMethod: budget.paymentMethod,
        installmentsCount: budget.installmentsCount || 1,
        firstDueDate: finalFirstDueDate,

        items: {
          create: budget.items.map((it) => ({
            name: it.name,
            description: it.description,
            quantity: it.quantity,
            unitPriceCents: it.unitPriceCents,
            totalCents: it.totalCents,
          })),
        },
      },
      select: { id: true, status: true, createdAt: true },
    });

    // 2) cria receivable + installments (financeiro)
    const receivable = await tx.receivable.create({
      data: {
        salonId,
        orderId: order.id,
        totalCents: budget.totalCents,
        method: budget.paymentMethod || null,
        installments: { create: installmentsData },
      },
      select: {
        id: true,
        totalCents: true,
        method: true,
        installments: {
          orderBy: { number: "asc" },
          select: {
            id: true,
            number: true,
            dueDate: true,
            amountCents: true,
            status: true,
            paidAt: true,
            method: true,
          },
        },
      },
    });

    // 3) marca orçamento como aprovado e linka pedido
    const updatedBudget = await tx.budget.update({
      where: { id: budget.id },
      data: {
        status: "APROVADO",
        approvedAt: new Date(),
        approvedOrderId: order.id,
      },
      select: { id: true, status: true, approvedAt: true, approvedOrderId: true },
    });

    return { order, receivable, budget: updatedBudget };
  });

  return res.json(created);
}

// =====================
// DELETE /api/budgets/:id
// =====================
async function deleteBudget(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.budget.findFirst({
    where: { id, salonId },
    select: { id: true, status: true },
  });
  if (!exists) return res.status(404).json({ message: "Orçamento não encontrado." });

  // se já aprovou, não deixa deletar (porque já virou pedido)
  if (exists.status === "APROVADO") {
    return res.status(409).json({ message: "Orçamento já aprovado. Não é possível excluir." });
  }

  await prisma.$transaction(async (tx) => {
    await tx.budgetInstallment.deleteMany({ where: { budgetId: id } });
    await tx.budgetItem.deleteMany({ where: { budgetId: id } });
    await tx.budget.delete({ where: { id } });
  });

  return res.json({ ok: true });
}

module.exports = {
  listBudgets,
  getBudget,
  createBudget,
  updateBudget,
  updateBudgetFull,
  sendBudget,
  approveBudget,
  cancelBudget,
  deleteBudget,
};
