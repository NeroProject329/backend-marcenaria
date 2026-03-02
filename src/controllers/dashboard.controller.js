const { prisma } = require("../lib/prisma");

// ============================
// Helpers
// ============================
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

function startOfWeekLocal(d = new Date()) {
  const x = new Date(d);
  const day = x.getDay(); // 0 domingo
  const diff = day === 0 ? -6 : 1 - day; // segunda como início
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
  if (!v) return null;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) ? d : null;
}

function clampInt(v, def, min, max) {
  const n = parseInt(String(v ?? ""), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

async function getUpcomingPayments({ salonId, days, take }) {
  const now = new Date();
  const today = startOfDay(now);
  const end = endOfDay(addDays(today, days - 1));

  // Mostra: parcelas PENDENTES/ATRASADAS até o limite de dias.
  // Obs: não filtramos ">= hoje" para também aparecerem atrasadas.
  const items = await prisma.payableInstallment.findMany({
    where: {
      payable: { salonId },
      status: { in: ["PENDENTE", "ATRASADO"] },
      dueDate: { lte: end },
    },
    orderBy: { dueDate: "asc" },
    take,
    select: {
      id: true,
      payableId: true,
      number: true,
      dueDate: true,
      amountCents: true,
      status: true,
      paidAt: true,
      method: true,
      payable: {
        select: {
          id: true,
          description: true,
          totalCents: true,
          supplier: { select: { id: true, name: true, phone: true } },
        },
      },
    },
  });

  return { now, today, end, items };
}

async function buildWeekSummary({ salonId, weekStart, weekEnd }) {
  // TOTAL DA SEMANA (por vencimento)
  const recTotal = await prisma.receivableInstallment.aggregate({
    where: {
      receivable: { salonId },
      dueDate: { gte: weekStart, lte: weekEnd },
      status: { not: "CANCELADO" },
    },
    _sum: { amountCents: true },
    _count: { id: true },
  });

  const recPaid = await prisma.receivableInstallment.aggregate({
    where: {
      receivable: { salonId },
      dueDate: { gte: weekStart, lte: weekEnd },
      status: "PAGO",
    },
    _sum: { amountCents: true },
    _count: { id: true },
  });

  const payTotal = await prisma.payableInstallment.aggregate({
    where: {
      payable: { salonId },
      dueDate: { gte: weekStart, lte: weekEnd },
      status: { not: "CANCELADO" },
    },
    _sum: { amountCents: true },
    _count: { id: true },
  });

  const payPaid = await prisma.payableInstallment.aggregate({
    where: {
      payable: { salonId },
      dueDate: { gte: weekStart, lte: weekEnd },
      status: "PAGO",
    },
    _sum: { amountCents: true },
    _count: { id: true },
  });

  const receivablesTotalCents = recTotal._sum.amountCents || 0;
  const receivablesPaidCents = recPaid._sum.amountCents || 0;

  const payablesTotalCents = payTotal._sum.amountCents || 0;
  const payablesPaidCents = payPaid._sum.amountCents || 0;

  return {
    meta: {
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
    },
    receivables: {
      totalCents: receivablesTotalCents,
      paidCents: receivablesPaidCents,
      remainingCents: Math.max(0, receivablesTotalCents - receivablesPaidCents),
      totalCount: recTotal._count.id || 0,
      paidCount: recPaid._count.id || 0,
    },
    payables: {
      totalCents: payablesTotalCents,
      paidCents: payablesPaidCents,
      remainingCents: Math.max(0, payablesTotalCents - payablesPaidCents),
      totalCount: payTotal._count.id || 0,
      paidCount: payPaid._count.id || 0,
    },
  };
}

// ============================
// Handlers
// ============================

// GET /api/dashboard/overview
async function overview(req, res) {
  const { salonId } = req.user;

  const now = new Date();

  // período do mês (para vendas do mês)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);

  // semana (para resumo)
  const weekStart = parseISOorNull(req.query.weekStart) || startOfWeekLocal(now);
  const weekEnd = endOfDay(addDays(weekStart, 6));

  // widget de próximos pagamentos (7/15 dias)
  const upcomingDays = clampInt(req.query.upcomingDays, 7, 1, 60);

  // 1) clientes
  const clientsCount = await prisma.client.count({ where: { salonId } });

  // 2) vendas do mês (quantidade + total)
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

  // 2.1) recebido no mês (parcelas pagas por paidAt)
  const recPaidMonth = await prisma.receivableInstallment.aggregate({
    where: {
      receivable: { salonId },
      status: "PAGO",
      paidAt: { gte: monthStart, lt: monthEnd },
    },
    _sum: { amountCents: true },
  });

  // 2.2) pago no mês (parcelas pagas por paidAt)
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

  // 3) próximas entregas (status em andamento + expectedDeliveryAt)
  const upcomingDeliveries = await prisma.order.findMany({
    where: {
      salonId,
      status: { in: ["PEDIDO", "EM_PRODUCAO", "PRONTO"] },
      expectedDeliveryAt: { not: null },
    },
    orderBy: { expectedDeliveryAt: "asc" },
    take: 12,
    select: {
      id: true,
      status: true,
      createdAt: true,
      expectedDeliveryAt: true,
      totalCents: true,
      client: { select: { id: true, name: true, phone: true } },
    },
  });

  // 4) resumo da semana (a pagar / a receber)
  const weekSummary = await buildWeekSummary({ salonId, weekStart, weekEnd });

  // 5) próximos pagamentos (para já vir no overview)
  const upcoming = await getUpcomingPayments({ salonId, days: upcomingDays, take: 10 });

  return res.json({
    meta: {
      month: yyyyMm(now),
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      upcomingDays,
    },
    kpis: {
      clientsCount,
      ordersMonthCount,
      ordersMonthTotalCents,
      receivedPaidMonthCents,
      expensesPaidMonthCents,
    },
    upcomingDeliveries,
    weekSummary,
    upcomingPayments: {
      days: upcomingDays,
      end: upcoming.end.toISOString(),
      items: upcoming.items,
    },
  });
}

// GET /api/dashboard/upcoming-payments?days=7
async function upcomingPayments(req, res) {
  const { salonId } = req.user;
  const days = clampInt(req.query.days, 7, 1, 60);
  const take = clampInt(req.query.take, 10, 1, 50);

  const upcoming = await getUpcomingPayments({ salonId, days, take });

  return res.json({
    meta: {
      days,
      now: upcoming.now.toISOString(),
      end: upcoming.end.toISOString(),
      take,
    },
    items: upcoming.items,
  });
}

// GET /api/dashboard/week-summary?weekStart=YYYY-MM-DD
async function weekSummary(req, res) {
  const { salonId } = req.user;

  const now = new Date();
  const weekStart = parseISOorNull(req.query.weekStart) || startOfWeekLocal(now);
  const weekEnd = endOfDay(addDays(weekStart, 6));

  const summary = await buildWeekSummary({ salonId, weekStart, weekEnd });

  return res.json(summary);
}

module.exports = {
  overview,
  upcomingPayments,
  weekSummary,
};