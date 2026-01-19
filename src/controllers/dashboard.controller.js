const { prisma } = require("../lib/prisma");

// helpers
function startOfWeekLocal(d = new Date()) {
  const x = new Date(d);
  const day = x.getDay(); // 0 domingo
  const diff = (day === 0 ? -6 : 1 - day); // segunda como início
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

async function overview(req, res) {
  const { salonId } = req.user;

  // período do mês (para vendas do mês)
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);

  // semana (para gráficos)
  const weekStart = parseISOorNull(req.query.weekStart) || startOfWeekLocal(now);
  const weekEnd = addDays(weekStart, 6);
  weekEnd.setHours(23, 59, 59, 999);


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

  // 3) próximas entregas (status em andamento + expectedDeliveryAt)
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

  // 4) recebimentos semana (parcelas pagas por dia)
  const recWeek = await prisma.receivableInstallment.findMany({
  where: {
    receivable: { salonId },
    dueDate: { gte: weekStart, lte: weekEnd },
  },
  select: { amountCents: true, dueDate: true },
});


  // 5) pagamentos semana (parcelas pagas por dia)
  const payWeek = await prisma.payableInstallment.findMany({
  where: {
    payable: { salonId },
    dueDate: { gte: weekStart, lte: weekEnd },
  },
  select: { amountCents: true, dueDate: true },
});


  // monta série diária (segunda..domingo)
  const labels = [];
  const receivablesSeries = [];
  const payablesSeries = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    labels.push(String(day.getDate()).padStart(2, "0"));

    const dayStart = new Date(day); dayStart.setHours(0,0,0,0);
    const dayEnd = new Date(day); dayEnd.setHours(23,59,59,999);

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
    },
    upcomingDeliveries,
    charts: {
      labels,
      receivablesCents: receivablesSeries,
      payablesCents: payablesSeries,
    },
  });
}

module.exports = { overview };
