const { prisma } = require("../lib/prisma");

// helpers
function startOfWeekLocal(d = new Date()) {
  const x = new Date(d);
  const day = x.getDay(); // 0 domingo
  const diff = day === 0 ? -6 : 1 - day; // segunda
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function yyyyMm(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function parseISOorNull(v) {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d : null;
}
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function clampInt(v, def, min, max) {
  const n = parseInt(String(v ?? ""), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function pct(n, d) {
  if (!d || d <= 0) return 0;
  return Math.round((n / d) * 10000) / 100;
}

// --- helpers de mês (pra garantir recorrência) ---
function monthRange(monthStr) {
  const [y, m] = String(monthStr || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { from, to };
}
function monthKeyFromDateSP(d) {
  const dt = new Date(d);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(dt);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}`;
}
function incMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  dt.setUTCMonth(dt.getUTCMonth() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}
function decMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  dt.setUTCMonth(dt.getUTCMonth() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}
function monthsBetweenSP(a, b) {
  const start = monthKeyFromDateSP(a);
  const end = monthKeyFromDateSP(b);
  const out = [start];
  let cur = start;
  while (cur !== end) {
    cur = incMonth(cur);
    out.push(cur);
    if (out.length > 24) break; // segurança
  }
  return out;
}
function dayOfMonthSP(date) {
  const dt = new Date(date);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
  }).formatToParts(dt);

  const day = parts.find((p) => p.type === "day")?.value;
  const n = Number(day);
  return Number.isFinite(n) ? n : 1;
}
function buildDateForMonthSP(monthStr, dayOfMonth) {
  const [y, m] = String(monthStr || "").split("-").map(Number);
  if (!y || !m) return new Date(`${monthStr}-01T00:00:00-03:00`);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.max(1, Math.min(lastDay, Number(dayOfMonth) || 1));
  const dd = String(d).padStart(2, "0");
  return new Date(`${monthStr}-${dd}T00:00:00-03:00`);
}

// ✅ excluir custos de estoque (igual reports/finance)
function nonStockCostsWhere() {
  return {
    NOT: {
      OR: [
        { category: { equals: "Estoque", mode: "insensitive" } },
        { recurringGroupId: { startsWith: "ESTOQUE:", mode: "insensitive" } },
        { name: { startsWith: "Compra de material", mode: "insensitive" } },
        { name: { startsWith: "Compra de estoque", mode: "insensitive" } },
      ],
    },
  };
}

async function ensureRecurringMonth(salonId, month) {
  if (!monthRange(month)) return;

  await prisma.$transaction(async (tx) => {
    const recurringHistory = await tx.cost.findMany({
      where: {
        salonId,
        isRecurring: true,
        recurringGroupId: { not: null },
        yearMonth: { lte: month },
      },
      orderBy: [{ yearMonth: "desc" }, { createdAt: "desc" }],
      select: {
        recurringGroupId: true,
        yearMonth: true,
        type: true,
        name: true,
        description: true,
        category: true,
        amountCents: true,
        supplierId: true,
        occurredAt: true,
      },
    });

    const lastByGroup = new Map();
    for (const c of recurringHistory) {
      const g = c.recurringGroupId;
      if (!g) continue;
      if (!lastByGroup.has(g)) lastByGroup.set(g, c);
    }

    const groups = Array.from(lastByGroup.keys());
    if (!groups.length) return;

    const existingThisMonth = await tx.cost.findMany({
      where: {
        salonId,
        yearMonth: month,
        recurringGroupId: { in: groups },
      },
      select: { recurringGroupId: true },
    });
    const hasSet = new Set(existingThisMonth.map((x) => x.recurringGroupId));

    const toCreate = [];
    for (const g of groups) {
      if (hasSet.has(g)) continue;

      const base = lastByGroup.get(g);
      if (!base) continue;

      const dueDay = dayOfMonthSP(base.occurredAt);
      const occurredAt = buildDateForMonthSP(month, dueDay);

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
        occurredAt,
        supplierId: base.supplierId || null,
      });
    }

    if (toCreate.length) await tx.cost.createMany({ data: toCreate });
  });
}

// ---------------------------
// OVERVIEW (já existente) — NÃO MEXER NA ASSINATURA
// ---------------------------
async function overview(req, res) {
  const { salonId } = req.user;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);

  const weekStart = parseISOorNull(req.query.weekStart) || startOfWeekLocal(now);
  const weekEnd = addDays(weekStart, 6);
  weekEnd.setHours(23, 59, 59, 999);

  const clientsCount = await prisma.client.count({ where: { salonId } });

  const ordersMonth = await prisma.order.aggregate({
    where: {
      salonId,
      createdAt: { gte: monthStart, lt: monthEnd },
      status: { in: ["PEDIDO", "EM_PRODUCAO", "PRONTO", "ENTREGUE"] },
    },
    _count: { id: true },
    _sum: { totalCents: true },
  });

  const ordersMonthCount = ordersMonth._count.id || 0;
  const ordersMonthTotalCents = ordersMonth._sum.totalCents || 0;

  const recPaidMonth = await prisma.receivableInstallment.aggregate({
    where: {
      receivable: { salonId },
      status: "PAGO",
      paidAt: { gte: monthStart, lt: monthEnd },
    },
    _sum: { amountCents: true },
  });

  const payPaidMonth = await prisma.payableInstallment.aggregate({
    where: {
      payable: { salonId },
      status: "PAGO",
      paidAt: { gte: monthStart, lt: monthEnd },
    },
    _sum: { amountCents: true },
  });

  const receivedPaidMonthCents = recPaidMonth._sum.amountCents || 0;
  const expensesPaidMonthCents = payPaidMonth._sum.amountCents || 0;

  const upcomingDeliveries = await prisma.order.findMany({
    where: {
      salonId,
      status: { in: ["PEDIDO", "EM_PRODUCAO", "PRONTO"] },
      expectedDeliveryAt: { not: null },
    },
    orderBy: { expectedDeliveryAt: "asc" },
    take: 10,
    select: {
      id: true,
      status: true,
      expectedDeliveryAt: true,
      totalCents: true,
      createdAt: true,
      client: { select: { id: true, name: true, phone: true } },
    },
  });

  const recWeek = await prisma.receivableInstallment.findMany({
    where: { receivable: { salonId }, dueDate: { gte: weekStart, lte: weekEnd } },
    select: { amountCents: true, dueDate: true },
  });

  const payWeek = await prisma.payableInstallment.findMany({
    where: { payable: { salonId }, dueDate: { gte: weekStart, lte: weekEnd } },
    select: { amountCents: true, dueDate: true },
  });

  const labels = [];
  const receivablesSeries = [];
  const payablesSeries = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    labels.push(String(day.getDate()).padStart(2, "0"));

    const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);

    const rSum = recWeek
      .filter(x => x.dueDate >= dayStart && x.dueDate <= dayEnd)
      .reduce((a, x) => a + (x.amountCents || 0), 0);

    const pSum = payWeek
      .filter(x => x.dueDate >= dayStart && x.dueDate <= dayEnd)
      .reduce((a, x) => a + (x.amountCents || 0), 0);

    receivablesSeries.push(rSum);
    payablesSeries.push(pSum);
  }

  return res.json({
    meta: {
      month: yyyyMm(now),
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
    },
    kpis: {
      clientsCount,
      ordersMonthCount,
      ordersMonthTotalCents,
      receivedPaidMonthCents,
      expensesPaidMonthCents,
    },
    upcomingDeliveries,
    charts: {
      labels,
      receivablesCents: receivablesSeries,
      payablesCents: payablesSeries,
    },
  });
}

// ✅ já existe: próximos pagamentos (só pagar)
async function upcomingPayments(req, res) {
  const { salonId } = req.user;

  const days = clampInt(req.query.days, 7, 1, 60);
  const take = clampInt(req.query.take, 10, 1, 50);

  const now = new Date();
  const today = startOfDay(now);

  const windowStart = startOfDay(addDays(today, -(days - 1)));
  const windowEnd = endOfDay(addDays(today, days - 1));

  const months = monthsBetweenSP(windowStart, windowEnd);
  for (const m of months) {
    await ensureRecurringMonth(salonId, m);
  }

  const inst = await prisma.payableInstallment.findMany({
    where: {
      payable: { salonId },
      status: { in: ["PENDENTE", "ATRASADO"] },
      dueDate: { gte: windowStart, lte: windowEnd },
    },
    orderBy: { dueDate: "asc" },
    take: Math.max(take, 30),
    select: {
      id: true,
      dueDate: true,
      amountCents: true,
      status: true,
      payable: {
        select: {
          description: true,
          supplier: { select: { name: true } },
        },
      },
    },
  });

  const costs = await prisma.cost.findMany({
    where: {
      salonId,
      type: "FIXO",
      occurredAt: { gte: windowStart, lte: windowEnd },
    },
    orderBy: { occurredAt: "asc" },
    take: Math.max(take, 30),
    select: {
      id: true,
      occurredAt: true,
      amountCents: true,
      name: true,
      supplier: { select: { name: true } },
    },
  });

  const items = [
    ...inst.map((x) => ({
      id: x.id,
      source: "PAYABLE",
      dueDate: x.dueDate,
      amountCents: x.amountCents,
      status: x.status,
      supplierName: x.payable?.supplier?.name || null,
      description: x.payable?.description || "Pagamento",
    })),
    ...costs.map((c) => ({
      id: c.id,
      source: "FIXED_COST",
      dueDate: c.occurredAt,
      amountCents: c.amountCents,
      status: new Date(c.occurredAt) < today ? "ATRASADO" : "PENDENTE",
      supplierName: c.supplier?.name || null,
      description: `Custo fixo - ${c.name}`,
    })),
  ]
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0, take);

  return res.json({
    meta: {
      days,
      take,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
    items,
  });
}

// ---------------------------
// ✅ NOVO: DASHBOARD PLUS
// GET /api/dashboard/plus?months=6&endMonth=YYYY-MM&basis=due|paid&upcomingDays=30&upcomingTake=15
// ---------------------------
async function sumReceivablesForRange({ salonId, from, to, basis }) {
  if (basis === "paid") {
    const agg = await prisma.receivableInstallment.aggregate({
      where: {
        receivable: { salonId },
        status: "PAGO",
        paidAt: { gte: from, lt: to },
      },
      _sum: { amountCents: true },
    });
    return agg._sum.amountCents || 0;
  }

  const agg = await prisma.receivableInstallment.aggregate({
    where: {
      receivable: { salonId },
      dueDate: { gte: from, lt: to },
      status: { not: "CANCELADO" },
    },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function sumCostsByTypeForRange({ salonId, from, to, type }) {
  const agg = await prisma.cost.aggregate({
    where: {
      salonId,
      type,
      occurredAt: { gte: from, lt: to },
      ...nonStockCostsWhere(),
    },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function sumMaterialsPurchasesForRange({ salonId, from, to }) {
  const moves = await prisma.materialMovement.findMany({
    where: { salonId, type: "IN", occurredAt: { gte: from, lt: to } },
    select: { qty: true, unitCostCents: true },
  });

  let total = 0;
  for (const mv of moves) {
    const qty = Number(mv.qty || 0);
    const unit = Number(mv.unitCostCents || 0);
    total += Math.round(qty * unit);
  }
  return total;
}

async function calcDreMonth({ salonId, month, basis }) {
  const r = monthRange(month);
  if (!r) return null;

  await ensureRecurringMonth(salonId, month);

  const revenueCents = await sumReceivablesForRange({ salonId, from: r.from, to: r.to, basis });
  const materialsCents = await sumMaterialsPurchasesForRange({ salonId, from: r.from, to: r.to });
  const variableCostsCents = await sumCostsByTypeForRange({ salonId, from: r.from, to: r.to, type: "VARIAVEL" });
  const fixedCostsCents = await sumCostsByTypeForRange({ salonId, from: r.from, to: r.to, type: "FIXO" });

  const cmvCents = materialsCents + variableCostsCents;
  const grossProfitCents = revenueCents - cmvCents;
  const operatingProfitCents = grossProfitCents - fixedCostsCents;

  return {
    month,
    revenueCents,
    materialsCents,
    variableCostsCents,
    fixedCostsCents,
    profitCents: operatingProfitCents,
    marginPct: pct(operatingProfitCents, revenueCents),
  };
}

async function plus(req, res) {
  const { salonId } = req.user;

  const months = clampInt(req.query.months, 6, 3, 24);
  const upcomingDays = clampInt(req.query.upcomingDays, 30, 7, 90);
  const upcomingTake = clampInt(req.query.upcomingTake, 15, 5, 50);

  const basis = String(req.query.basis || "due").toLowerCase();
  if (!["due", "paid"].includes(basis)) {
    return res.status(400).json({ message: "basis inválido. Use due ou paid" });
  }

  let endMonth = req.query.endMonth ? String(req.query.endMonth).trim() : monthKeyFromDateSP(new Date());
  if (!/^\d{4}-\d{2}$/.test(endMonth)) {
    return res.status(400).json({ message: "endMonth inválido. Use YYYY-MM" });
  }

  // série mensal (lucro x faturamento)
  const labels = [];
  const revenueSeries = [];
  const profitSeries = [];
  const marginSeries = [];

  let cur = endMonth;
  const monthsList = [];
  for (let i = 0; i < months; i++) {
    monthsList.push(cur);
    cur = decMonth(cur);
  }
  monthsList.reverse();

  for (const m of monthsList) {
    const d = await calcDreMonth({ salonId, month: m, basis });
    labels.push(m);
    revenueSeries.push(d?.revenueCents || 0);
    profitSeries.push(d?.profitCents || 0);
    marginSeries.push(d?.marginPct || 0);
  }

  // cards do mês atual (endMonth)
  const dre = await calcDreMonth({ salonId, month: endMonth, basis });
  const cards = {
    month: endMonth,
    revenueCents: dre?.revenueCents || 0,
    profitCents: dre?.profitCents || 0,
    marginPct: dre?.marginPct || 0,
    fixedCostsCents: dre?.fixedCostsCents || 0,
    variableCostsCents: dre?.variableCostsCents || 0,
    materialsCents: dre?.materialsCents || 0,
  };

  // próximos vencimentos (a receber + a pagar + custos) nos próximos X dias
  const now = new Date();
  const start = startOfDay(now);
  const end = endOfDay(addDays(start, upcomingDays));

  // garante recorrentes nos meses cobertos
  const monthsWin = monthsBetweenSP(start, end);
  for (const m of monthsWin) await ensureRecurringMonth(salonId, m);

  const [recvAgg, payAgg, costsAgg] = await Promise.all([
    prisma.receivableInstallment.aggregate({
      where: {
        receivable: { salonId },
        dueDate: { gte: start, lte: end },
        status: { notIn: ["PAGO", "CANCELADO"] },
      },
      _sum: { amountCents: true },
    }),
    prisma.payableInstallment.aggregate({
      where: {
        payable: { salonId },
        dueDate: { gte: start, lte: end },
        status: { notIn: ["PAGO", "CANCELADO"] },
      },
      _sum: { amountCents: true },
    }),
    prisma.cost.aggregate({
      where: {
        salonId,
        occurredAt: { gte: start, lte: end },
        ...nonStockCostsWhere(),
      },
      _sum: { amountCents: true },
    }),
  ]);

  const receivableOpenCents = recvAgg._sum.amountCents || 0;
  const payableOpenCents = payAgg._sum.amountCents || 0;
  const costsCents = costsAgg._sum.amountCents || 0;

  const [recvItems, payItems, costItems] = await Promise.all([
    prisma.receivableInstallment.findMany({
      where: {
        receivable: { salonId },
        dueDate: { gte: start, lte: end },
        status: { notIn: ["PAGO", "CANCELADO"] },
      },
      orderBy: [{ dueDate: "asc" }, { number: "asc" }],
      take: upcomingTake,
      select: {
        id: true,
        dueDate: true,
        amountCents: true,
        status: true,
        number: true,
        receivable: {
          select: {
            order: { select: { id: true, client: { select: { id: true, name: true } } } },
          },
        },
      },
    }),
    prisma.payableInstallment.findMany({
      where: {
        payable: { salonId },
        dueDate: { gte: start, lte: end },
        status: { notIn: ["PAGO", "CANCELADO"] },
      },
      orderBy: [{ dueDate: "asc" }, { number: "asc" }],
      take: upcomingTake,
      select: {
        id: true,
        dueDate: true,
        amountCents: true,
        status: true,
        number: true,
        payable: {
          select: {
            description: true,
            supplier: { select: { name: true } },
          },
        },
      },
    }),
    prisma.cost.findMany({
      where: {
        salonId,
        occurredAt: { gte: start, lte: end },
        ...nonStockCostsWhere(),
      },
      orderBy: { occurredAt: "asc" },
      take: upcomingTake,
      select: {
        id: true,
        occurredAt: true,
        amountCents: true,
        name: true,
        type: true,
        supplier: { select: { name: true } },
      },
    }),
  ]);

  const upcomingItems = [
    ...recvItems.map((r) => ({
      kind: "RECEIVABLE",
      dueDate: r.dueDate,
      amountCents: r.amountCents,
      status: r.status,
      title: r.receivable?.order?.client?.name || "-",
      subtitle: `A receber (parcela ${r.number || 1})`,
    })),
    ...payItems.map((p) => ({
      kind: "PAYABLE",
      dueDate: p.dueDate,
      amountCents: p.amountCents,
      status: p.status,
      title: p.payable?.supplier?.name || "—",
      subtitle: p.payable?.description || "Conta a pagar",
    })),
    ...costItems.map((c) => ({
      kind: "COST",
      dueDate: c.occurredAt,
      amountCents: c.amountCents,
      status: new Date(c.occurredAt) < start ? "ATRASADO" : "PENDENTE",
      title: c.supplier?.name || "—",
      subtitle: `Custo ${String(c.type || "").toLowerCase()} - ${c.name}`,
    })),
  ]
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0, upcomingTake);

  return res.json({
    meta: {
      endMonth,
      basis,
      months,
      asOf: new Date().toISOString(),
      upcomingDays,
      upcomingTake,
    },
    cards,
    series: {
      labels,
      revenueCents: revenueSeries,
      profitCents: profitSeries,
      marginPct: marginSeries,
    },
    upcoming: {
      from: start.toISOString(),
      to: end.toISOString(),
      receivableOpenCents,
      payableOpenCents,
      costsCents,
      toReceiveCents: receivableOpenCents,
      toPayCents: payableOpenCents + costsCents,
      items: upcomingItems,
    },
  });
}

module.exports = { overview, upcomingPayments, plus };