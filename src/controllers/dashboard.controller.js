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
function monthsBetweenSP(a, b) {
  const start = monthKeyFromDateSP(a);
  const end = monthKeyFromDateSP(b);
  const out = [start];
  let cur = start;
  while (cur !== end) {
    cur = incMonth(cur);
    out.push(cur);
    if (out.length > 12) break; // segurança
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

// ✅ NOVO: GET /api/dashboard/upcoming-payments?days=7&take=10
async function upcomingPayments(req, res) {
  const { salonId } = req.user;

  const days = clampInt(req.query.days, 7, 1, 60);
  const take = clampInt(req.query.take, 10, 1, 50);

  const now = new Date();
  const today = startOfDay(now);

  // janela: mostra próximos + atrasados recentes (até "days-1" pra trás)
  const windowStart = startOfDay(addDays(today, -(days - 1)));
  const windowEnd = endOfDay(addDays(today, days - 1));

  // garante recorrentes nos meses cobertos
  const months = monthsBetweenSP(windowStart, windowEnd);
  for (const m of months) {
    await ensureRecurringMonth(salonId, m);
  }

  // 1) parcelas de contas a pagar
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

  // 2) custos FIXOS (vencimento = occurredAt)
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

module.exports = { overview, upcomingPayments };