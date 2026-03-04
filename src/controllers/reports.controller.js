const { prisma } = require("../lib/prisma");

// --------------------
// Helpers de período / datas
// --------------------
function parseISO(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateOnlySP(v) {
  // aceita YYYY-MM-DD e cria 00:00 no fuso -03 (compatível com seu front de <input type="date">)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ""))) return null;
  return new Date(`${v}T00:00:00-03:00`);
}

function monthRangeUTC(monthStr) {
  const [y, m] = String(monthStr || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { from, to };
}

function periodFromQuery(q) {
  // 1) month=YYYY-MM
  if (q.month) {
    const month = String(q.month).trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, message: "month inválido. Use YYYY-MM" };
    const r = monthRangeUTC(month);
    if (!r) return { ok: false, message: "month inválido. Use YYYY-MM" };
    return { ok: true, mode: "month", month, from: r.from, to: r.to };
  }

  // 2) dateFrom/dateTo (YYYY-MM-DD)
  if (q.dateFrom || q.dateTo) {
    const df = parseDateOnlySP(q.dateFrom);
    const dt0 = parseDateOnlySP(q.dateTo);
    if (!df || !dt0) return { ok: false, message: "dateFrom/dateTo inválidos. Use YYYY-MM-DD" };

    // dateTo inclusivo -> transforma em exclusivo (+1 dia)
    const to = new Date(dt0.getTime() + 24 * 60 * 60 * 1000);
    if (df >= to) return { ok: false, message: "Intervalo inválido: dateFrom precisa ser menor que dateTo" };

    return { ok: true, mode: "range", dateFrom: String(q.dateFrom), dateTo: String(q.dateTo), from: df, to };
  }

  // 3) compat: from/to ISO (igual finance)
  if (q.from || q.to) {
    const from = q.from ? parseISO(q.from) : null;
    const to = q.to ? parseISO(q.to) : null;
    if (!from || !to) return { ok: false, message: "Informe from e to em ISO." };
    if (from >= to) return { ok: false, message: "Intervalo inválido: from precisa ser menor que to." };
    return { ok: true, mode: "iso", from, to };
  }

  return { ok: false, message: "Informe month=YYYY-MM ou dateFrom/dateTo ou from/to." };
}

function dayKeyUTC(dt) {
  return new Date(dt).toISOString().slice(0, 10);
}

function monthKeyFromDateSP(d) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(d));

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}`;
}

function ymToIndex(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  return y * 12 + (m - 1);
}
function indexToYm(idx) {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function monthsCoveredSP(from, toExclusive) {
  const end = new Date(toExclusive.getTime() - 1); // último instante dentro do range
  const startYm = monthKeyFromDateSP(from);
  const endYm = monthKeyFromDateSP(end);

  const a = ymToIndex(startYm);
  const b = ymToIndex(endYm);

  const out = [];
  for (let i = a; i <= b; i++) out.push(indexToYm(i));
  return out;
}

// --------------------
// Filtro: excluir custos de estoque (igual finance.controller)
// --------------------
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

// --------------------
// Recorrência de custos (copiado da lógica do costs.controller)
// -> garante custos recorrentes no(s) mês(es) consultados
// --------------------
function monthRange(monthStr) {
  const [y, m] = String(monthStr || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { from, to };
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
    const history = await tx.cost.findMany({
      where: {
        salonId,
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
        isRecurring: true,
      },
    });

    const lastByGroup = new Map();
    for (const c of history) {
      const g = c.recurringGroupId;
      if (!g) continue;
      if (!lastByGroup.has(g)) lastByGroup.set(g, c);
    }

    const groups = [];
    for (const [g, base] of lastByGroup.entries()) {
      if (base?.isRecurring) groups.push(g);
    }
    if (!groups.length) return;

    const existingThisMonth = await tx.cost.findMany({
      where: { salonId, yearMonth: month, recurringGroupId: { in: groups } },
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

    if (toCreate.length) {
      await tx.cost.createMany({ data: toCreate });
    }
  });
}

async function ensureRecurringForRange(salonId, from, toExclusive) {
  const months = monthsCoveredSP(from, toExclusive);
  for (const m of months) {
    await ensureRecurringMonth(salonId, m);
  }
}

// --------------------
// Cálculos base de caixa (Real vs Projetado)
// --------------------
async function sumLegacyAutoInAppointments({ salonId, from, to }) {
  const appts = await prisma.appointment.findMany({
    where: { salonId, status: "FINALIZADO", startAt: { gte: from, lt: to } },
    select: { service: { select: { price: true } } },
  });
  return appts.reduce((acc, a) => acc + (a.service?.price || 0), 0);
}

async function sumManualTx({ salonId, from, to }) {
  const grouped = await prisma.cashTransaction.groupBy({
    by: ["type"],
    where: { salonId, occurredAt: { gte: from, lt: to }, source: "MANUAL" },
    _sum: { amount: true },
  });

  const manualIn = grouped.find((g) => g.type === "INCOME")?._sum?.amount || 0;
  const manualOut = grouped.find((g) => g.type === "EXPENSE")?._sum?.amount || 0;
  return { manualIn, manualOut };
}

async function sumReceivables({ salonId, from, to, basis }) {
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

async function sumPayables({ salonId, from, to, basis }) {
  if (basis === "paid") {
    const agg = await prisma.payableInstallment.aggregate({
      where: {
        payable: { salonId },
        status: "PAGO",
        paidAt: { gte: from, lt: to },
      },
      _sum: { amountCents: true },
    });
    return agg._sum.amountCents || 0;
  }

  const agg = await prisma.payableInstallment.aggregate({
    where: {
      payable: { salonId },
      dueDate: { gte: from, lt: to },
      status: { not: "CANCELADO" },
    },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function sumCosts({ salonId, from, to }) {
  const agg = await prisma.cost.aggregate({
    where: {
      salonId,
      occurredAt: { gte: from, lt: to },
      ...nonStockCostsWhere(),
    },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function calcCashTotals({ salonId, from, to, basis }) {
  const legacyAutoIn = await sumLegacyAutoInAppointments({ salonId, from, to });
  const { manualIn, manualOut } = await sumManualTx({ salonId, from, to });
  const receivablesIn = await sumReceivables({ salonId, from, to, basis });
  const payablesOut = await sumPayables({ salonId, from, to, basis });
  const costsOut = await sumCosts({ salonId, from, to });

  const inCents = legacyAutoIn + receivablesIn + manualIn;
  const outCents = manualOut + payablesOut + costsOut;

  return {
    basis,
    inCents,
    outCents,
    netCents: inCents - outCents,
    breakdown: {
      legacyAutoInCents: legacyAutoIn,
      receivablesInCents: receivablesIn,
      manualInCents: manualIn,
      manualOutCents: manualOut,
      payablesOutCents: payablesOut,
      costsOutCents: costsOut,
    },
  };
}

async function calcCashSeries({ salonId, from, to, basis }) {
  const [appts, manual, recv, pay, costs] = await Promise.all([
    prisma.appointment.findMany({
      where: { salonId, status: "FINALIZADO", startAt: { gte: from, lt: to } },
      select: { startAt: true, service: { select: { price: true } } },
    }),

    prisma.cashTransaction.findMany({
      where: { salonId, source: "MANUAL", occurredAt: { gte: from, lt: to } },
      select: { occurredAt: true, type: true, amount: true },
    }),

    prisma.receivableInstallment.findMany({
      where:
        basis === "paid"
          ? { receivable: { salonId }, status: "PAGO", paidAt: { gte: from, lt: to } }
          : { receivable: { salonId }, dueDate: { gte: from, lt: to }, status: { not: "CANCELADO" } },
      select: { dueDate: true, paidAt: true, amountCents: true, status: true },
    }),

    prisma.payableInstallment.findMany({
      where:
        basis === "paid"
          ? { payable: { salonId }, status: "PAGO", paidAt: { gte: from, lt: to } }
          : { payable: { salonId }, dueDate: { gte: from, lt: to }, status: { not: "CANCELADO" } },
      select: { dueDate: true, paidAt: true, amountCents: true, status: true },
    }),

    prisma.cost.findMany({
      where: { salonId, occurredAt: { gte: from, lt: to }, ...nonStockCostsWhere() },
      select: { occurredAt: true, amountCents: true },
    }),
  ]);

  const map = new Map(); // day -> { day, inCents, outCents, netCents }

  function addIn(day, cents) {
    const cur = map.get(day) || { day, inCents: 0, outCents: 0, netCents: 0 };
    cur.inCents += cents;
    cur.netCents += cents;
    map.set(day, cur);
  }
  function addOut(day, cents) {
    const cur = map.get(day) || { day, inCents: 0, outCents: 0, netCents: 0 };
    cur.outCents += cents;
    cur.netCents -= cents;
    map.set(day, cur);
  }

  for (const a of appts) addIn(dayKeyUTC(a.startAt), a.service?.price || 0);

  for (const t of manual) {
    const day = dayKeyUTC(t.occurredAt);
    if (t.type === "INCOME") addIn(day, t.amount || 0);
    else addOut(day, t.amount || 0);
  }

  for (const r of recv) {
    const dt = basis === "paid" ? r.paidAt : r.dueDate;
    if (!dt) continue;
    addIn(dayKeyUTC(dt), r.amountCents || 0);
  }

  for (const p of pay) {
    const dt = basis === "paid" ? p.paidAt : p.dueDate;
    if (!dt) continue;
    addOut(dayKeyUTC(dt), p.amountCents || 0);
  }

  for (const c of costs) addOut(dayKeyUTC(c.occurredAt), c.amountCents || 0);

  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

// --------------------
// 1) DFC (Real + Projetado)
// GET /api/reports/dfc?month=YYYY-MM
// GET /api/reports/dfc?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
// --------------------
async function reportsDfc(req, res) {
  const { salonId } = req.user;

  const pr = periodFromQuery(req.query);
  if (!pr.ok) return res.status(400).json({ message: pr.message });

  const { from, to } = pr;

  // garante custos recorrentes nos meses do range
  await ensureRecurringForRange(salonId, from, to);

  const epoch = new Date(0);

  // saldo inicial REAL (caixa): sempre baseado em paid
  const prevReal = await calcCashTotals({ salonId, from: epoch, to: from, basis: "paid" });

  // período REAL (paidAt)
  const realTotals = await calcCashTotals({ salonId, from, to, basis: "paid" });
  const realSeries = await calcCashSeries({ salonId, from, to, basis: "paid" });

  // período PROJETADO (dueDate) — mas começa do saldo real inicial
  const projTotals = await calcCashTotals({ salonId, from, to, basis: "due" });
  const projSeries = await calcCashSeries({ salonId, from, to, basis: "due" });

  const real = {
    basis: "paid",
    previousBalanceCents: prevReal.netCents,
    inCents: realTotals.inCents,
    outCents: realTotals.outCents,
    netCents: realTotals.netCents,
    finalBalanceCents: prevReal.netCents + realTotals.netCents,
    breakdown: realTotals.breakdown,
    series: realSeries,
  };

  const projected = {
    basis: "due",
    previousBalanceCents: prevReal.netCents,
    inCents: projTotals.inCents,
    outCents: projTotals.outCents,
    netCents: projTotals.netCents,
    finalBalanceCents: prevReal.netCents + projTotals.netCents,
    breakdown: projTotals.breakdown,
    series: projSeries,
  };

  return res.json({
    range: {
      mode: pr.mode,
      month: pr.month || null,
      dateFrom: pr.dateFrom || null,
      dateTo: pr.dateTo || null,
      from,
      to,
    },
    real,
    projected,
  });
}

// --------------------
// 2) Upcoming (7/15/30) — a receber/a pagar
// GET /api/reports/upcoming?days=7,15,30&limit=50
// --------------------
function startOfDaySP(date = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  return new Date(`${ymd}T00:00:00-03:00`);
}

function parseDaysParam(v) {
  const raw = String(v || "7,15,30")
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const uniq = Array.from(new Set(raw));
  uniq.sort((a, b) => a - b);

  // evita coisas absurdas
  return uniq.filter((n) => n <= 365);
}

async function reportsUpcoming(req, res) {
  const { salonId } = req.user;

  const daysList = parseDaysParam(req.query.days);
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);

  const start = startOfDaySP(new Date());
  const maxDays = daysList.length ? daysList[daysList.length - 1] : 30;
  const maxTo = new Date(start.getTime() + maxDays * 24 * 60 * 60 * 1000);

  // garante recorrentes nos meses cobertos
  await ensureRecurringForRange(salonId, start, maxTo);

  const windows = [];
  for (const days of daysList) {
    const from = start;
    const to = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

    const [recvAgg, payAgg, costsAgg] = await Promise.all([
      prisma.receivableInstallment.aggregate({
        where: {
          receivable: { salonId },
          dueDate: { gte: from, lt: to },
          status: { notIn: ["PAGO", "CANCELADO"] },
        },
        _sum: { amountCents: true },
      }),

      prisma.payableInstallment.aggregate({
        where: {
          payable: { salonId },
          dueDate: { gte: from, lt: to },
          status: { notIn: ["PAGO", "CANCELADO"] },
        },
        _sum: { amountCents: true },
      }),

      prisma.cost.aggregate({
        where: {
          salonId,
          occurredAt: { gte: from, lt: to },
          ...nonStockCostsWhere(),
        },
        _sum: { amountCents: true },
      }),
    ]);

    const receivableOpenCents = recvAgg._sum.amountCents || 0;
    const payableOpenCents = payAgg._sum.amountCents || 0;
    const costsCents = costsAgg._sum.amountCents || 0;

    // itens (limitados)
    const [recvItems, payItems, costItems] = await Promise.all([
      prisma.receivableInstallment.findMany({
        where: {
          receivable: { salonId },
          dueDate: { gte: from, lt: to },
          status: { notIn: ["PAGO", "CANCELADO"] },
        },
        orderBy: [{ dueDate: "asc" }, { number: "asc" }],
        take: Math.floor(limit / 2),
        select: {
          id: true,
          number: true,
          dueDate: true,
          amountCents: true,
          status: true,
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
          dueDate: { gte: from, lt: to },
          status: { notIn: ["PAGO", "CANCELADO"] },
        },
        orderBy: [{ dueDate: "asc" }, { number: "asc" }],
        take: Math.floor(limit / 2),
        select: {
          id: true,
          number: true,
          dueDate: true,
          amountCents: true,
          status: true,
          payable: {
            select: {
              id: true,
              description: true,
              supplier: { select: { id: true, name: true } },
            },
          },
        },
      }),

      prisma.cost.findMany({
        where: {
          salonId,
          occurredAt: { gte: from, lt: to },
          ...nonStockCostsWhere(),
        },
        orderBy: { occurredAt: "asc" },
        take: Math.floor(limit / 2),
        select: {
          id: true,
          name: true,
          amountCents: true,
          occurredAt: true,
          type: true,
          category: true,
          supplier: { select: { id: true, name: true } },
        },
      }),
    ]);

    const items = [
      ...recvItems.map((r) => ({
        kind: "RECEIVABLE",
        id: r.id,
        dueDate: r.dueDate,
        amountCents: r.amountCents,
        status: r.status,
        label: `A receber - ${r.receivable?.order?.client?.name || "-"}`,
        meta: {
          orderId: r.receivable?.order?.id || null,
          installment: r.number,
        },
      })),
      ...payItems.map((p) => ({
        kind: "PAYABLE",
        id: p.id,
        dueDate: p.dueDate,
        amountCents: p.amountCents,
        status: p.status,
        label: `A pagar - ${p.payable?.description || "Conta a pagar"}`,
        meta: {
          supplierName: p.payable?.supplier?.name || null,
          installment: p.number,
        },
      })),
      ...costItems.map((c) => ({
        kind: "COST",
        id: c.id,
        dueDate: c.occurredAt,
        amountCents: c.amountCents,
        status: "PENDENTE",
        label: `Custo - ${c.name}`,
        meta: {
          type: c.type,
          category: c.category || null,
          supplierName: c.supplier?.name || null,
        },
      })),
    ]
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
      .slice(0, limit);

    windows.push({
      days,
      from,
      to,
      receivableOpenCents,
      payableOpenCents,
      costsCents,
      toPayCents: payableOpenCents + costsCents,
      netCents: receivableOpenCents - (payableOpenCents + costsCents),
      items,
    });
  }

  return res.json({
    asOf: new Date(),
    start,
    windows,
  });
}

module.exports = {
  reportsDfc,
  reportsUpcoming,
};