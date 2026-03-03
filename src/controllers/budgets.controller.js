const { prisma } = require("../lib/prisma");

// =====================
// Helpers
// =====================
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

function normalizeDiscountType(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const t = String(v).trim().toUpperCase();
  if (t === "VALOR" || t === "PERCENT") return t;
  return null;
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
// NOVO CÁLCULO (planilha)
// materiais + (dias_fabricação * custo_do_dia) + taxa cartão (se parcelado) + custos adicionais + lucro%
// desconto: apenas à vista
// =====================
function computeBudgetFromInputs({
  itemsNorm,
  deliveryDays,
  dailyRateCents,
  paymentMode,
  paymentMethod,
  installmentsCount,
  cardFeePercentInput,
  extras,
  profitPercent,
  discountType,
  discountPercent,
  discountCentsRaw,
}) {
  // 1) materiais (somatório de todos os materiais em todos os itens)
  let materialsCents = 0;
  for (const it of itemsNorm) {
    const qtyItem = Number(it.quantity || 0);

    const mats = Array.isArray(it.materials) ? it.materials : [];
    const costPerUnit = mats.reduce((acc, m) => {
      const q = Number(m.qty || 0);
      const u = Number(m.unitCostCents || 0);
      return acc + q * u;
    }, 0);

    const itemMatTotal = Math.round(qtyItem * costPerUnit);
    materialsCents += Number.isFinite(itemMatTotal) ? itemMatTotal : 0;
  }

  // 2) custo do dia (dias_fabricação * custo_do_dia)
  const days = Math.max(0, Number(deliveryDays || 0));
  const daily = Math.max(0, Number(dailyRateCents || 0));
  const laborCents = Math.round(days) * Math.round(daily);

  // 3) custo do projeto (material + custo do dia total)
  const projectCostCents = Math.max(0, materialsCents + laborCents);

  // 4) taxa cartão (somente se PARCELADO + CARTAO)
  let cardFeePercent = 0;
  if (paymentMode === "PARCELADO" && paymentMethod === "CARTAO") {
    const pct = Number(cardFeePercentInput);
    cardFeePercent = Number.isFinite(pct) && pct >= 0 ? pct : 12.3;
  }

  const cardFeeCents =
    cardFeePercent > 0 ? Math.round(projectCostCents * (cardFeePercent / 100)) : 0;

  // 5) custos adicionais (lista)
  const extrasNorm = Array.isArray(extras) ? extras : [];
  const extrasCents = extrasNorm.reduce((acc, e) => acc + (Number(e.amountCents) || 0), 0);

  // 6) base para lucro
  const baseWithExtrasCents = Math.max(0, projectCostCents + cardFeeCents + extrasCents);

  // 7) lucro %
  const p = Number(profitPercent);
  const profitPct = Number.isFinite(p) && p >= 0 ? p : 0;
  const profitCents = profitPct > 0 ? Math.round(baseWithExtrasCents * (profitPct / 100)) : 0;

  const totalBeforeDiscountCents = Math.max(0, baseWithExtrasCents + profitCents);

  // 8) desconto (apenas à vista)
  let effectiveDiscountCents = 0;
  if (paymentMode === "AVISTA") {
    if (discountType === "PERCENT") {
      const dp = Number(discountPercent);
      const pct = Number.isFinite(dp) && dp > 0 ? dp : 0;
      effectiveDiscountCents = Math.round(totalBeforeDiscountCents * (pct / 100));
    } else {
      effectiveDiscountCents = Math.max(0, Number(discountCentsRaw) || 0);
    }
  }

  if (effectiveDiscountCents > totalBeforeDiscountCents) {
    effectiveDiscountCents = totalBeforeDiscountCents;
  }

  const totalCents = Math.max(0, totalBeforeDiscountCents - effectiveDiscountCents);

  return {
    materialsCents,
    laborCents,
    projectCostCents,
    cardFeePercent,
    cardFeeCents,
    extrasCents,
    profitPercent: profitPct,
    profitCents,
    totalBeforeDiscountCents,
    discountCents: effectiveDiscountCents,
    totalCents,
  };
}

function normalizeExtras(raw) {
  const list = Array.isArray(raw) ? raw : [];

  // aceita {name, amountCents} (já em centavos)
  const out = [];
  for (const e of list) {
    const name = String(e?.name || "").trim();
    if (!name) continue;

    const amt = Number(e?.amountCents);
    if (!Number.isFinite(amt) || !Number.isInteger(amt) || amt < 0) continue;

    out.push({ name: name.slice(0, 60), amountCents: amt });
  }

  return out;
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
      items: {
        orderBy: { createdAt: "asc" },
        include: { materials: { orderBy: { createdAt: "asc" } } },
      },
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

    // produção
    deliveryDays,
    dailyRateCents,

    // desconto à vista
    discountType,
    discountPercent,
    discountCents,

    // pagamento
    paymentMode,
    paymentMethod,
    installmentsCount,
    firstDueDate,
    installments, // custom

    // taxa cartão
    cardFeePercent,

    // novos
    extras, // [{name, amountCents}]
    profitPercent,

    // itens + materiais
    items,
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

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "items deve ser um array com pelo menos 1 item." });
  }

  // produção
  const dd =
    deliveryDays !== undefined && deliveryDays !== null && deliveryDays !== ""
      ? toInt(deliveryDays, "deliveryDays")
      : { ok: true, value: null };
  if (!dd.ok) return res.status(400).json({ message: dd.message });
  if (dd.value !== null && dd.value < 0) return res.status(400).json({ message: "deliveryDays inválido." });

  const dr =
    dailyRateCents !== undefined && dailyRateCents !== null && dailyRateCents !== ""
      ? toInt(dailyRateCents, "dailyRateCents")
      : { ok: true, value: null };
  if (!dr.ok) return res.status(400).json({ message: dr.message });
  if (dr.value !== null && dr.value < 0) return res.status(400).json({ message: "dailyRateCents inválido." });

  // desconto
  const discTypeNorm = normalizeDiscountType(discountType) || "VALOR";
  if (discountType !== undefined && discTypeNorm === null) {
    return res.status(400).json({ message: "discountType inválido (VALOR ou PERCENT)." });
  }

  const discCentsRaw = discountCents !== undefined ? toInt(discountCents, "discountCents") : { ok: true, value: 0 };
  if (!discCentsRaw.ok) return res.status(400).json({ message: discCentsRaw.message });
  if (discCentsRaw.value < 0) return res.status(400).json({ message: "discountCents inválido." });

  const discPctRaw = discountPercent !== undefined ? toFloat(discountPercent, "discountPercent") : { ok: true, value: 0 };
  if (!discPctRaw.ok) return res.status(400).json({ message: discPctRaw.message });

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
    if (c.value < 2 || c.value > 24) {
      return res.status(400).json({ message: "installmentsCount deve ser entre 2 e 24." });
    }
    count = c.value;
  }

  const parsedFirst = toDateOrNull(firstDueDate);
  if (firstDueDate && !parsedFirst) {
    return res.status(400).json({ message: "firstDueDate inválido (use ISO date)." });
  }

  const baseDue = parsedFirst || exp || new Date();

  // normaliza itens + materiais
  const itemsNorm = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const name = String(it.name || "").trim();
      if (name.length < 2) throw new Error(`Item ${i + 1}: nome inválido.`);

      const q = toInt(it.quantity ?? 1, `items[${i}].quantity`);
      if (!q.ok) throw new Error(q.message);
      if (q.value <= 0) throw new Error(`Item ${i + 1}: quantity inválido.`);

      // unitPriceCents agora é opcional (compatibilidade)
      const up = toInt(it.unitPriceCents ?? 0, `items[${i}].unitPriceCents`);
      if (!up.ok) throw new Error(up.message);
      if (up.value < 0) throw new Error(`Item ${i + 1}: unitPriceCents inválido.`);

      // materiais (opcional)
      let materialsNorm = [];
      if (Array.isArray(it.materials)) {
        materialsNorm = it.materials
          .filter((m) => m && String(m.name || "").trim())
          .map((m, midx) => {
            const mName = String(m.name || "").trim();
            const qty = Number(m.qty);
            const unitCostCents = Number(m.unitCostCents);

            if (!Number.isFinite(qty) || qty <= 0) {
              throw new Error(`Item ${i + 1} material ${midx + 1}: qty inválido.`);
            }
            if (!Number.isFinite(unitCostCents) || unitCostCents < 0) {
              throw new Error(`Item ${i + 1} material ${midx + 1}: unitCostCents inválido.`);
            }

            return { name: mName, qty, unitCostCents: Math.trunc(unitCostCents) };
          });
      }

      itemsNorm.push({
        name,
        description: it.description ? String(it.description).trim() : null,
        quantity: q.value,
        unitPriceCents: up.value,
        totalCents: q.value * up.value,
        materials: materialsNorm,
      });
    }
  } catch (e) {
    return res.status(400).json({ message: e.message || "Itens/materiais inválidos." });
  }

  // extras
  const extrasNorm = normalizeExtras(extras || req.body.additionalCosts || req.body.extraCosts);

  // calcula tudo no backend
  const computed = computeBudgetFromInputs({
    itemsNorm,
    deliveryDays: dd.value ?? 0,
    dailyRateCents: dr.value ?? 0,
    paymentMode: modeNorm,
    paymentMethod: methodNorm || null,
    installmentsCount: count,
    cardFeePercentInput: cardFeePercent,
    extras: extrasNorm,
    profitPercent,
    discountType: discTypeNorm,
    discountPercent: discPctRaw.value,
    discountCentsRaw: discCentsRaw.value,
  });

  // parcelas do orçamento
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
      totalCents: computed.totalCents,
    });

    if (!built.ok) return res.status(400).json({ message: built.error });

    finalFirstDueDate = built.firstDueDate;
    budgetInstallmentsData = built.installmentsData;
  } else if (modeNorm === "PARCELADO") {
    const amounts = splitIntoInstallments(computed.totalCents, count);
    budgetInstallmentsData = amounts.map((amt, idx) => ({
      number: idx + 1,
      dueDate: addMonths(baseDue, idx),
      amountCents: amt,
    }));
    finalFirstDueDate = baseDue;
  }

  const created = await prisma.budget.create({
    data: {
      salonId,
      clientId,
      status: "RASCUNHO",
      expectedDeliveryAt: exp,
      notes: notes ? String(notes).trim() : null,

      subtotalCents: computed.totalBeforeDiscountCents,
      discountCents: computed.discountCents,
      totalCents: computed.totalCents,

      paymentMode: modeNorm,
      paymentMethod: methodNorm || null,
      installmentsCount: count,
      firstDueDate: finalFirstDueDate,

      deliveryDays: dd.value ?? null,
      dailyRateCents: dr.value ?? null,

      discountType: discTypeNorm,
      discountPercent: discTypeNorm === "PERCENT" ? discPctRaw.value : null,

      cardFeePercent: computed.cardFeePercent,

      // breakdown
      materialsCents: computed.materialsCents,
      laborCents: computed.laborCents,
      projectCostCents: computed.projectCostCents,
      cardFeeCents: computed.cardFeeCents,
      extrasCents: computed.extrasCents,
      extrasJson: extrasNorm.length ? JSON.stringify(extrasNorm) : null,
      profitPercent: computed.profitPercent,
      profitCents: computed.profitCents,
      totalBeforeDiscountCents: computed.totalBeforeDiscountCents,

      items: {
        create: itemsNorm.map((it) => ({
          name: it.name,
          description: it.description,
          quantity: it.quantity,
          unitPriceCents: it.unitPriceCents,
          totalCents: it.totalCents,
          ...(it.materials?.length ? { materials: { create: it.materials } } : {}),
        })),
      },

      ...(budgetInstallmentsData.length ? { installments: { create: budgetInstallmentsData } } : {}),
    },
    include: {
      client: { select: { id: true, name: true, phone: true, type: true } },
      items: { include: { materials: true }, orderBy: { createdAt: "asc" } },
      installments: { orderBy: { number: "asc" } },
    },
  });

  return res.status(201).json({ budget: created });
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

    deliveryDays,
    dailyRateCents,

    discountType,
    discountPercent,
    discountCents,

    paymentMode,
    paymentMethod,
    installmentsCount,
    firstDueDate,
    installments, // custom

    cardFeePercent,

    extras,
    profitPercent,

    items,
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

  const dd =
    deliveryDays !== undefined && deliveryDays !== null && deliveryDays !== ""
      ? toInt(deliveryDays, "deliveryDays")
      : { ok: true, value: null };
  if (!dd.ok) return res.status(400).json({ message: dd.message });
  if (dd.value !== null && dd.value < 0) return res.status(400).json({ message: "deliveryDays inválido." });

  const dr =
    dailyRateCents !== undefined && dailyRateCents !== null && dailyRateCents !== ""
      ? toInt(dailyRateCents, "dailyRateCents")
      : { ok: true, value: null };
  if (!dr.ok) return res.status(400).json({ message: dr.message });
  if (dr.value !== null && dr.value < 0) return res.status(400).json({ message: "dailyRateCents inválido." });

  const discTypeNorm = normalizeDiscountType(discountType) || "VALOR";
  if (discountType !== undefined && discTypeNorm === null) {
    return res.status(400).json({ message: "discountType inválido (VALOR ou PERCENT)." });
  }

  const discCentsRaw = discountCents !== undefined ? toInt(discountCents, "discountCents") : { ok: true, value: 0 };
  if (!discCentsRaw.ok) return res.status(400).json({ message: discCentsRaw.message });
  if (discCentsRaw.value < 0) return res.status(400).json({ message: "discountCents inválido." });

  const discPctRaw = discountPercent !== undefined ? toFloat(discountPercent, "discountPercent") : { ok: true, value: 0 };
  if (!discPctRaw.ok) return res.status(400).json({ message: discPctRaw.message });

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "items deve ser um array com pelo menos 1 item." });
  }

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

  const itemsNorm = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const name = String(it.name || "").trim();
      if (name.length < 2) throw new Error(`Item ${i + 1}: nome inválido.`);

      const q = toInt(it.quantity ?? 1, `items[${i}].quantity`);
      if (!q.ok) throw new Error(q.message);
      if (q.value <= 0) throw new Error(`Item ${i + 1}: quantity inválido.`);

      const up = toInt(it.unitPriceCents ?? 0, `items[${i}].unitPriceCents`);
      if (!up.ok) throw new Error(up.message);
      if (up.value < 0) throw new Error(`Item ${i + 1}: unitPriceCents inválido.`);

      let materialsNorm = [];
      if (Array.isArray(it.materials)) {
        materialsNorm = it.materials
          .filter((m) => m && String(m.name || "").trim())
          .map((m, midx) => {
            const mName = String(m.name || "").trim();
            const qty = Number(m.qty);
            const unitCostCents = Number(m.unitCostCents);

            if (!Number.isFinite(qty) || qty <= 0) {
              throw new Error(`Item ${i + 1} material ${midx + 1}: qty inválido.`);
            }
            if (!Number.isFinite(unitCostCents) || unitCostCents < 0) {
              throw new Error(`Item ${i + 1} material ${midx + 1}: unitCostCents inválido.`);
            }

            return { name: mName, qty, unitCostCents: Math.trunc(unitCostCents) };
          });
      }

      itemsNorm.push({
        name,
        description: it.description ? String(it.description).trim() : null,
        quantity: q.value,
        unitPriceCents: up.value,
        totalCents: q.value * up.value,
        materials: materialsNorm,
      });
    }
  } catch (e) {
    return res.status(400).json({ message: e.message || "Itens/materiais inválidos." });
  }

  const extrasNorm = normalizeExtras(extras || req.body.additionalCosts || req.body.extraCosts);

  const computed = computeBudgetFromInputs({
    itemsNorm,
    deliveryDays: dd.value ?? 0,
    dailyRateCents: dr.value ?? 0,
    paymentMode: modeNorm,
    paymentMethod: methodNorm || null,
    installmentsCount: count,
    cardFeePercentInput: cardFeePercent,
    extras: extrasNorm,
    profitPercent,
    discountType: discTypeNorm,
    discountPercent: discPctRaw.value,
    discountCentsRaw: discCentsRaw.value,
  });

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
      totalCents: computed.totalCents,
    });

    if (!built.ok) return res.status(400).json({ message: built.error });

    finalFirstDueDate = built.firstDueDate;
    budgetInstallmentsData = built.installmentsData;
  } else if (modeNorm === "PARCELADO") {
    const amounts = splitIntoInstallments(computed.totalCents, count);
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

        subtotalCents: computed.totalBeforeDiscountCents,
        discountCents: computed.discountCents,
        totalCents: computed.totalCents,

        paymentMode: modeNorm,
        paymentMethod: methodNorm || null,
        installmentsCount: count,
        firstDueDate: finalFirstDueDate,

        deliveryDays: dd.value ?? null,
        dailyRateCents: dr.value ?? null,

        discountType: discTypeNorm,
        discountPercent: discTypeNorm === "PERCENT" ? discPctRaw.value : null,

        cardFeePercent: computed.cardFeePercent,

        // breakdown
        materialsCents: computed.materialsCents,
        laborCents: computed.laborCents,
        projectCostCents: computed.projectCostCents,
        cardFeeCents: computed.cardFeeCents,
        extrasCents: computed.extrasCents,
        extrasJson: extrasNorm.length ? JSON.stringify(extrasNorm) : null,
        profitPercent: computed.profitPercent,
        profitCents: computed.profitCents,
        totalBeforeDiscountCents: computed.totalBeforeDiscountCents,
      },
      select: { id: true },
    });

    await tx.budgetInstallment.deleteMany({ where: { budgetId: id } });
    if (budgetInstallmentsData.length) {
      await tx.budgetInstallment.createMany({
        data: budgetInstallmentsData.map((p) => ({ ...p, budgetId: id })),
      });
    }

    await tx.budgetItemMaterial.deleteMany({
      where: { budgetItem: { budgetId: id } },
    });
    await tx.budgetItem.deleteMany({ where: { budgetId: id } });

    for (const it of itemsNorm) {
      await tx.budgetItem.create({
        data: {
          budgetId: id,
          name: it.name,
          description: it.description,
          quantity: it.quantity,
          unitPriceCents: it.unitPriceCents,
          totalCents: it.totalCents,
          ...(it.materials?.length ? { materials: { create: it.materials } } : {}),
        },
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
    const order = await tx.order.create({
      data: {
        salonId,
        clientId: budget.clientId,
        status: "PEDIDO",
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

  if (exists.status === "APROVADO") {
    return res.status(409).json({ message: "Orçamento aprovado não pode ser removido." });
  }

  await prisma.$transaction(async (tx) => {
    await tx.budgetInstallment.deleteMany({ where: { budgetId: id } });
    await tx.budgetItemMaterial.deleteMany({ where: { budgetItem: { budgetId: id } } });
    await tx.budgetItem.deleteMany({ where: { budgetId: id } });
    await tx.budget.delete({ where: { id } });
  });

  return res.json({ ok: true });
}

module.exports = {
  listBudgets,
  getBudget,
  createBudget,
  updateBudgetFull,
  sendBudget,
  approveBudget,
  cancelBudget,
  deleteBudget,
};