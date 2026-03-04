const { prisma } = require("../lib/prisma");

// --------------------
// Helpers de período / datas
// --------------------
function parseISO(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateOnlySP(v) {
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
  if (q.month) {
    const month = String(q.month).trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, message: "month inválido. Use YYYY-MM" };
    const r = monthRangeUTC(month);
    if (!r) return { ok: false, message: "month inválido. Use YYYY-MM" };
    return { ok: true, mode: "month", month, from: r.from, to: r.to };
  }

  if (q.dateFrom || q.dateTo) {
    const df = parseDateOnlySP(q.dateFrom);
    const dt0 = parseDateOnlySP(q.dateTo);
    if (!df || !dt0) return { ok: false, message: "dateFrom/dateTo inválidos. Use YYYY-MM-DD" };

    const to = new Date(dt0.getTime() + 24 * 60 * 60 * 1000);
    if (df >= to) return { ok: false, message: "Intervalo inválido: dateFrom precisa ser menor que dateTo" };

    return { ok: true, mode: "range", dateFrom: String(q.dateFrom), dateTo: String(q.dateTo), from: df, to };
  }

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
  const end = new Date(toExclusive.getTime() - 1);
  const startYm = monthKeyFromDateSP(from);
  const endYm = monthKeyFromDateSP(end);

  const a = ymToIndex(startYm);
  const b = ymToIndex(endYm);

  const out = [];
  for (let i = a; i <= b; i++) out.push(indexToYm(i));
  return out;
}

function getCurrentYmSP() {
  return monthKeyFromDateSP(new Date());
}

function parseBasis(q) {
  const basis = String(q.basis || "due").toLowerCase();
  if (!["paid", "due"].includes(basis)) return { ok: false, message: "basis inválido. Use paid ou due" };
  return { ok: true, basis };
}

function pct(n, d) {
  if (!d || d <= 0) return 0;
  return Math.round((n / d) * 10000) / 100;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(Math.max(x, min), max);
}

// --------------------
// Excluir custos de estoque
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
// Recorrência de custos (garante custos recorrentes no(s) mês(es))
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

async function ensureRecurringForMonths(salonId, months) {
  for (const m of months) await ensureRecurringMonth(salonId, m);
}

// --------------------
// Cálculos base (Real/Projetado)
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
      select: { dueDate: true, paidAt: true, amountCents: true },
    }),

    prisma.payableInstallment.findMany({
      where:
        basis === "paid"
          ? { payable: { salonId }, status: "PAGO", paidAt: { gte: from, lt: to } }
          : { payable: { salonId }, dueDate: { gte: from, lt: to }, status: { not: "CANCELADO" } },
      select: { dueDate: true, paidAt: true, amountCents: true },
    }),

    prisma.cost.findMany({
      where: { salonId, occurredAt: { gte: from, lt: to }, ...nonStockCostsWhere() },
      select: { occurredAt: true, amountCents: true },
    }),
  ]);

  const map = new Map();

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
    if (String(t.type).toUpperCase() === "INCOME") addIn(day, t.amount || 0);
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
// DRE
// --------------------
async function sumMaterialsPurchases({ salonId, from, to }) {
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

async function sumCostsByType({ salonId, from, to, type }) {
  const agg = await prisma.cost.aggregate({
    where: { salonId, type, occurredAt: { gte: from, lt: to }, ...nonStockCostsWhere() },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function calcDre({ salonId, from, to, basis }) {
  await ensureRecurringForRange(salonId, from, to);

  const revenueCents = await sumReceivables({ salonId, from, to, basis });

  const materialsCents = await sumMaterialsPurchases({ salonId, from, to });
  const variableCostsCents = await sumCostsByType({ salonId, from, to, type: "VARIAVEL" });
  const fixedCostsCents = await sumCostsByType({ salonId, from, to, type: "FIXO" });

  const cmvCents = materialsCents + variableCostsCents;

  const grossProfitCents = revenueCents - cmvCents;
  const operatingProfitCents = grossProfitCents - fixedCostsCents;

  return {
    basis,
    revenueCents,
    materialsCents,
    variableCostsCents,
    fixedCostsCents,
    cmvCents,
    grossProfitCents,
    operatingProfitCents,
    grossMarginPct: pct(grossProfitCents, revenueCents),
    operatingMarginPct: pct(operatingProfitCents, revenueCents),
  };
}

async function reportsDre(req, res) {
  const { salonId } = req.user;

  const pr = periodFromQuery(req.query);
  if (!pr.ok) return res.status(400).json({ message: pr.message });

  const b = parseBasis(req.query);
  if (!b.ok) return res.status(400).json({ message: b.message });

  const { from, to } = pr;

  const dre = await calcDre({ salonId, from, to, basis: b.basis });

  return res.json({
    range: {
      mode: pr.mode,
      month: pr.month || null,
      dateFrom: pr.dateFrom || null,
      dateTo: pr.dateTo || null,
      from,
      to,
    },
    dre,
  });
}

async function reportsDreSeries(req, res) {
  const { salonId } = req.user;

  const b = parseBasis(req.query);
  if (!b.ok) return res.status(400).json({ message: b.message });

  const months = clamp(req.query.months || 6, 1, 24);

  let endMonth = req.query.endMonth ? String(req.query.endMonth).trim() : null;
  if (endMonth && !/^\d{4}-\d{2}$/.test(endMonth)) {
    return res.status(400).json({ message: "endMonth inválido. Use YYYY-MM" });
  }
  if (!endMonth) endMonth = getCurrentYmSP();

  const endIdx = ymToIndex(endMonth);
  const items = [];

  for (let i = months - 1; i >= 0; i--) {
    const ym = indexToYm(endIdx - i);
    const r = monthRangeUTC(ym);
    if (!r) continue;

    const dre = await calcDre({ salonId, from: r.from, to: r.to, basis: b.basis });

    items.push({
      month: ym,
      revenueCents: dre.revenueCents,
      profitCents: dre.operatingProfitCents,
      marginPct: dre.operatingMarginPct,
      fixedCostsCents: dre.fixedCostsCents,
      variableCostsCents: dre.variableCostsCents,
      materialsCents: dre.materialsCents,
    });
  }

  return res.json({
    basis: b.basis,
    endMonth,
    months: items.length,
    items,
  });
}

// --------------------
// DFC (Real + Projetado)
// --------------------
async function reportsDfc(req, res) {
  const { salonId } = req.user;

  const pr = periodFromQuery(req.query);
  if (!pr.ok) return res.status(400).json({ message: pr.message });

  const { from, to } = pr;

  await ensureRecurringForRange(salonId, from, to);

  const epoch = new Date(0);

  const prevReal = await calcCashTotals({ salonId, from: epoch, to: from, basis: "paid" });

  const realTotals = await calcCashTotals({ salonId, from, to, basis: "paid" });
  const realSeries = await calcCashSeries({ salonId, from, to, basis: "paid" });

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
// Upcoming (7/15/30)
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
  return uniq.filter((n) => n <= 365);
}

async function reportsUpcoming(req, res) {
  const { salonId } = req.user;

  const daysList = parseDaysParam(req.query.days);
  const limit = clamp(req.query.limit || 50, 1, 200);

  const start = startOfDaySP(new Date());
  const maxDays = daysList.length ? daysList[daysList.length - 1] : 30;
  const maxTo = new Date(start.getTime() + maxDays * 24 * 60 * 60 * 1000);

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
        where: { salonId, occurredAt: { gte: from, lt: to }, ...nonStockCostsWhere() },
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
            select: { order: { select: { id: true, client: { select: { id: true, name: true } } } } },
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
            select: { id: true, description: true, supplier: { select: { id: true, name: true } } },
          },
        },
      }),

      prisma.cost.findMany({
        where: { salonId, occurredAt: { gte: from, lt: to }, ...nonStockCostsWhere() },
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
        meta: { orderId: r.receivable?.order?.id || null, installment: r.number },
      })),
      ...payItems.map((p) => ({
        kind: "PAYABLE",
        id: p.id,
        dueDate: p.dueDate,
        amountCents: p.amountCents,
        status: p.status,
        label: `A pagar - ${p.payable?.description || "Conta a pagar"}`,
        meta: { supplierName: p.payable?.supplier?.name || null, installment: p.number },
      })),
      ...costItems.map((c) => ({
        kind: "COST",
        id: c.id,
        dueDate: c.occurredAt,
        amountCents: c.amountCents,
        status: "PENDENTE",
        label: `Custo - ${c.name}`,
        meta: { type: c.type, category: c.category || null, supplierName: c.supplier?.name || null },
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

  return res.json({ asOf: new Date(), start, windows });
}

// --------------------
// PROJEÇÕES (novo)
// GET /api/reports/projections?months=3&startMonth=YYYY-MM
// --------------------
async function sumReceivablesOpenByDue({ salonId, from, to }) {
  const agg = await prisma.receivableInstallment.aggregate({
    where: {
      receivable: { salonId },
      dueDate: { gte: from, lt: to },
      status: { notIn: ["PAGO", "CANCELADO"] },
    },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function sumPayablesOpenByDue({ salonId, from, to }) {
  const agg = await prisma.payableInstallment.aggregate({
    where: {
      payable: { salonId },
      dueDate: { gte: from, lt: to },
      status: { notIn: ["PAGO", "CANCELADO"] },
    },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function sumFixedCostsInRange({ salonId, from, to }) {
  const agg = await prisma.cost.aggregate({
    where: {
      salonId,
      type: "FIXO",
      occurredAt: { gte: from, lt: to },
      ...nonStockCostsWhere(),
    },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function reportsProjections(req, res) {
  const { salonId } = req.user;

  const months = clamp(req.query.months || 3, 1, 12);
  let startMonth = req.query.startMonth ? String(req.query.startMonth).trim() : null;
  if (startMonth && !/^\d{4}-\d{2}$/.test(startMonth)) {
    return res.status(400).json({ message: "startMonth inválido. Use YYYY-MM" });
  }
  if (!startMonth) startMonth = getCurrentYmSP();

  const startIdx = ymToIndex(startMonth);
  const monthsList = [];
  for (let i = 0; i < months; i++) monthsList.push(indexToYm(startIdx + i));

  // garante recorrentes para todos os meses projetados
  await ensureRecurringForMonths(salonId, monthsList);

  const items = [];
  for (const ym of monthsList) {
    const r = monthRangeUTC(ym);
    if (!r) continue;

    const receivablesOpenCents = await sumReceivablesOpenByDue({ salonId, from: r.from, to: r.to });
    const payablesOpenCents = await sumPayablesOpenByDue({ salonId, from: r.from, to: r.to });
    const fixedCostsCents = await sumFixedCostsInRange({ salonId, from: r.from, to: r.to });

    const expectedInCents = receivablesOpenCents;
    const expectedOutCents = payablesOpenCents + fixedCostsCents;

    items.push({
      month: ym,
      expectedInCents,
      expectedOutCents,
      netCents: expectedInCents - expectedOutCents,
      breakdown: {
        receivablesOpenCents,
        payablesOpenCents,
        fixedCostsCents,
      },
    });
  }

  const first = items[0] || null;
  const breakevenGapCents = first
    ? Math.max(0, (first.breakdown?.fixedCostsCents || 0) - (first.breakdown?.receivablesOpenCents || 0))
    : 0;

  return res.json({
    startMonth,
    months: items.length,
    items,
    kpis: {
      breakevenGapCents,
    },
  });
}

module.exports = {
  reportsDfc,
  reportsUpcoming,
  reportsDre,
  reportsDreSeries,
  reportsProjections,
};