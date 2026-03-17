// src/controllers/reportsExtra.controller.js
const PDFDocument = require("pdfkit");
const { prisma } = require("../lib/prisma");

// --------------------
// Helpers (iguais ao padrão do projeto)
// --------------------
function parseISO(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthRange(monthStr) {
  const [y, m] = String(monthStr || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { from, to };
}

function nonStockCostsWhere() {
  // Mantém o mesmo critério do finance.controller (não deixar “compra de estoque” virar custo geral)
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

const moneyBRL = (cents) =>
  (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const pad = (n) => String(n).padStart(2, "0");
function fmtBR(date) {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function clipPdfText(value, max = 28) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "—";
  return s.length > max ? `${s.slice(0, max - 1).trim()}…` : s;
}

function orderStatusLabelPdf(status) {
  const map = {
    ORCAMENTO: "Orçamento",
    PEDIDO: "Pedido",
    EM_PRODUCAO: "Em produção",
    PRONTO: "Pronto",
    ENTREGUE: "Entregue",
    CANCELADO: "Cancelado",
  };
  return map[String(status || "").toUpperCase()] || String(status || "—");
}

function paymentLabelPdf(paymentMode, paymentMethod) {
  const modeMap = {
    AVISTA: "À vista",
    PARCELADO: "Parcelado",
  };

  const methodMap = {
    PIX: "Pix",
    CARTAO: "Cartão",
    DINHEIRO: "Dinheiro",
    BOLETO: "Boleto",
    TRANSFERENCIA: "Transferência",
    OUTRO: "Outro",
  };

  const mode = modeMap[String(paymentMode || "").toUpperCase()] || String(paymentMode || "");
  const method = methodMap[String(paymentMethod || "").toUpperCase()] || String(paymentMethod || "");

  return [mode, method].filter(Boolean).join(" / ") || "—";
}

async function sumLegacyAutoInAppointments({ salonId, from, to }) {
  const appts = await prisma.appointment.findMany({
    where: { salonId, status: "FINALIZADO", startAt: { gte: from, lt: to } },
    select: { service: { select: { price: true } } },
  });
  return appts.reduce((acc, a) => acc + (a.service?.price || 0), 0);
}

async function sumManualTx({ salonId, from, to }) {
  const tx = await prisma.cashTransaction.findMany({
    where: { salonId, occurredAt: { gte: from, lt: to }, source: "MANUAL" },
    select: { type: true, amount: true },
  });

  // No DB: INCOME/EXPENSE
  const manualIn = tx.filter((t) => String(t.type).toUpperCase() === "INCOME").reduce((a, t) => a + (t.amount || 0), 0);
  const manualOut = tx.filter((t) => String(t.type).toUpperCase() === "EXPENSE").reduce((a, t) => a + (t.amount || 0), 0);

  return { manualIn, manualOut };
}

async function sumReceivablesPaid({ salonId, from, to }) {
  const agg = await prisma.receivableInstallment.aggregate({
    where: { receivable: { salonId }, status: "PAGO", paidAt: { gte: from, lt: to } },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function sumReceivablesDue({ salonId, from, to }) {
  const agg = await prisma.receivableInstallment.aggregate({
    where: { receivable: { salonId }, dueDate: { gte: from, lt: to }, status: { not: "CANCELADO" } },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function sumPayablesPaid({ salonId, from, to }) {
  const agg = await prisma.payableInstallment.aggregate({
    where: { payable: { salonId }, status: "PAGO", paidAt: { gte: from, lt: to } },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function sumPayablesDue({ salonId, from, to }) {
  const agg = await prisma.payableInstallment.aggregate({
    where: { payable: { salonId }, dueDate: { gte: from, lt: to }, status: { not: "CANCELADO" } },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function sumCostsByType({ salonId, from, to, type }) {
  const agg = await prisma.cost.aggregate({
    where: {
      salonId,
      occurredAt: { gte: from, lt: to },
      type, // FIXO | VARIAVEL
      ...nonStockCostsWhere(),
    },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents || 0;
}

async function calcCashflow({ salonId, from, to, basis = "paid" }) {
  const legacyAutoIn = await sumLegacyAutoInAppointments({ salonId, from, to });
  const { manualIn, manualOut } = await sumManualTx({ salonId, from, to });

  const receivablesIn =
    basis === "due"
      ? await sumReceivablesDue({ salonId, from, to })
      : await sumReceivablesPaid({ salonId, from, to });

  const payablesOut =
    basis === "due"
      ? await sumPayablesDue({ salonId, from, to })
      : await sumPayablesPaid({ salonId, from, to });

  const costsAgg = await prisma.cost.aggregate({
    where: { salonId, occurredAt: { gte: from, lt: to }, ...nonStockCostsWhere() },
    _sum: { amountCents: true },
  });
  const costsOut = costsAgg._sum.amountCents || 0;

  const inCents = legacyAutoIn + receivablesIn + manualIn;
  const outCents = manualOut + payablesOut + costsOut;
  const netCents = inCents - outCents;

  return {
    inCents,
    outCents,
    netCents,
    breakdown: {
      basis,
      legacyAutoInCents: legacyAutoIn,
      receivablesInCents: receivablesIn,
      manualInCents: manualIn,
      manualOutCents: manualOut,
      payablesOutCents: payablesOut,
      costsOutCents: costsOut,
    },
  };
}

async function upcomingTotals({ salonId, days }) {
  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  const to = new Date(from);
  to.setDate(to.getDate() + days);
  to.setHours(23, 59, 59, 999);

  const [recv, pay, costs] = await Promise.all([
    prisma.receivableInstallment.aggregate({
      where: {
        receivable: { salonId },
        dueDate: { gte: from, lte: to },
        status: { notIn: ["PAGO", "CANCELADO"] },
      },
      _sum: { amountCents: true },
    }),
    prisma.payableInstallment.aggregate({
      where: {
        payable: { salonId },
        dueDate: { gte: from, lte: to },
        status: { notIn: ["PAGO", "CANCELADO"] },
      },
      _sum: { amountCents: true },
    }),
    prisma.cost.aggregate({
      where: {
        salonId,
        occurredAt: { gte: from, lte: to },
        ...nonStockCostsWhere(),
      },
      _sum: { amountCents: true },
    }),
  ]);

  return {
    toReceiveCents: recv._sum.amountCents || 0,
    toPayCents: (pay._sum.amountCents || 0) + (costs._sum.amountCents || 0),
  };
}

async function getOverdueItems({ salonId, take = 20 }) {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const [recv, pay, costs] = await Promise.all([
    prisma.receivableInstallment.findMany({
      where: {
        receivable: { salonId },
        dueDate: { lt: end },
        status: { notIn: ["PAGO", "CANCELADO"] },
      },
      orderBy: { dueDate: "desc" },
      take,
      select: {
        id: true,
        dueDate: true,
        amountCents: true,
        status: true,
        receivable: {
          select: {
            order: { select: { id: true, client: { select: { name: true } } } },
          },
        },
      },
    }),
    prisma.payableInstallment.findMany({
      where: {
        payable: { salonId },
        dueDate: { lt: end },
        status: { notIn: ["PAGO", "CANCELADO"] },
      },
      orderBy: { dueDate: "desc" },
      take,
      select: {
        id: true,
        dueDate: true,
        amountCents: true,
        status: true,
        payable: { select: { description: true, supplier: { select: { name: true } } } },
      },
    }),
    prisma.cost.findMany({
      where: { salonId, occurredAt: { lt: end }, ...nonStockCostsWhere() },
      orderBy: { occurredAt: "desc" },
      take,
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

  const items = [
    ...recv.map((r) => ({
      kind: "RECEIVABLE",
      dueDate: r.dueDate,
      title: `A receber`,
      subtitle: r.receivable?.order?.client?.name ? `Cliente: ${r.receivable.order.client.name}` : "—",
      amountCents: r.amountCents || 0,
      status: r.status || "PENDENTE",
    })),
    ...pay.map((p) => ({
      kind: "PAYABLE",
      dueDate: p.dueDate,
      title: `A pagar`,
      subtitle: p.payable?.supplier?.name ? `Fornecedor: ${p.payable.supplier.name}` : (p.payable?.description || "—"),
      amountCents: p.amountCents || 0,
      status: p.status || "PENDENTE",
    })),
    ...costs.map((c) => ({
      kind: "COST",
      dueDate: c.occurredAt,
      title: `Custo (${c.type || "—"})`,
      subtitle: c.name || "—",
      amountCents: c.amountCents || 0,
      status: "PENDENTE",
    })),
  ].sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate));

  const toReceiveCents = items.filter((x) => x.kind === "RECEIVABLE").reduce((a, x) => a + x.amountCents, 0);
  const toPayCents = items.filter((x) => x.kind !== "RECEIVABLE").reduce((a, x) => a + x.amountCents, 0);

  return { items, totals: { toReceiveCents, toPayCents } };
}

async function getLastTransactions({ salonId, from, to, take = 15 }) {
  const [manual, recvPaid, payPaid, costs] = await Promise.all([
    prisma.cashTransaction.findMany({
      where: { salonId, occurredAt: { gte: from, lt: to }, source: "MANUAL" },
      orderBy: { occurredAt: "desc" },
      take,
      select: {
        id: true,
        type: true,
        description: true,
        occurredAt: true,
        amount: true,
        category: { select: { name: true } },
      },
    }),
    prisma.receivableInstallment.findMany({
      where: { receivable: { salonId }, status: "PAGO", paidAt: { gte: from, lt: to } },
      orderBy: { paidAt: "desc" },
      take,
      select: {
        id: true,
        paidAt: true,
        amountCents: true,
        receivable: { select: { order: { select: { id: true, client: { select: { name: true } } } } } },
      },
    }),
    prisma.payableInstallment.findMany({
      where: { payable: { salonId }, status: "PAGO", paidAt: { gte: from, lt: to } },
      orderBy: { paidAt: "desc" },
      take,
      select: {
        id: true,
        paidAt: true,
        amountCents: true,
        payable: { select: { description: true, supplier: { select: { name: true } } } },
      },
    }),
    prisma.cost.findMany({
      where: { salonId, occurredAt: { gte: from, lt: to }, ...nonStockCostsWhere() },
      orderBy: { occurredAt: "desc" },
      take,
      select: { id: true, occurredAt: true, amountCents: true, name: true, type: true },
    }),
  ]);

  const merged = [
    ...manual.map((t) => ({
      source: "MANUAL",
      type: String(t.type).toUpperCase() === "INCOME" ? "IN" : "OUT",
      name: t.description,
      category: t.category?.name || null,
      occurredAt: t.occurredAt,
      amountCents: t.amount || 0,
    })),
    ...recvPaid.map((r) => ({
      source: "RECEIVABLE",
      type: "IN",
      name: `Recebimento - ${r.receivable?.order?.client?.name || "-"}`,
      category: null,
      occurredAt: r.paidAt,
      amountCents: r.amountCents || 0,
    })),
    ...payPaid.map((p) => ({
      source: "PAYABLE",
      type: "OUT",
      name: p.payable?.description || "Pagamento",
      category: p.payable?.supplier?.name ? `Fornecedor: ${p.payable.supplier.name}` : null,
      occurredAt: p.paidAt,
      amountCents: p.amountCents || 0,
    })),
    ...costs.map((c) => ({
      source: "COST",
      type: "OUT",
      name: c.name || "Custo",
      category: c.type || null,
      occurredAt: c.occurredAt,
      amountCents: c.amountCents || 0,
    })),
  ].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

  return merged.slice(0, take);
}
async function getDeliveredSalesForPack({ salonId, month }) {
  const range = monthRange(month);
  if (!range) {
    const err = new Error("month inválido. Use YYYY-MM");
    err.status = 400;
    throw err;
  }

  const { from, to } = range;

  const rows = await prisma.order.findMany({
    where: {
      salonId,
      status: "ENTREGUE",
      OR: [
        { deliveredAt: { gte: from, lt: to } },
        {
          AND: [
            { deliveredAt: null },
            { expectedDeliveryAt: { gte: from, lt: to } },
          ],
        },
        {
          AND: [
            { deliveredAt: null },
            { expectedDeliveryAt: null },
            { createdAt: { gte: from, lt: to } },
          ],
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      totalCents: true,
      paymentMode: true,
      paymentMethod: true,
      client: { select: { name: true } },
    },
  });

  const sorted = [...rows].sort((a, b) => {
    const aDate = parseISO(a.deliveredAt) || parseISO(a.createdAt) || new Date(0);
    const bDate = parseISO(b.deliveredAt) || parseISO(b.createdAt) || new Date(0);
    return bDate - aDate;
  });

  return {
    count: sorted.length,
    totalCents: sorted.reduce((acc, row) => acc + (Number(row.totalCents) || 0), 0),
    rows: sorted,
  };
}


  const SALES_HISTORY_STATUS = new Set([
  "ALL",
  "ORCAMENTO",
  "PEDIDO",
  "EM_PRODUCAO",
  "PRONTO",
  "ENTREGUE",
  "CANCELADO",
]);

function normalizeSalesHistoryStatus(v) {
  const s = String(v || "ALL").trim().toUpperCase();
  return SALES_HISTORY_STATUS.has(s) ? s : null;
}

function yearMonthInSaoPaulo(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;

  return year && month ? `${year}-${month}` : null;
}

function isInMonthSalesHistory(value, month) {
  if (!value || !month) return false;
  return yearMonthInSaoPaulo(value) === month;
}

async function getSalesHistoryRows({ salonId, month, status }) {
  const range = monthRange(month);
  if (!range) {
    const err = new Error("month inválido. Use YYYY-MM");
    err.status = 400;
    throw err;
  }

  const statusNorm = normalizeSalesHistoryStatus(status);
  if (!statusNorm) {
    const err = new Error("status inválido.");
    err.status = 400;
    throw err;
  }

  const rows = await prisma.order.findMany({
    where: { salonId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      totalCents: true,
      paymentMode: true,
      paymentMethod: true,
      client: { select: { name: true } },
    },
  });

  const filtered = rows
    .filter((order) => {
      return (
        isInMonthSalesHistory(order.createdAt, month) ||
        isInMonthSalesHistory(order.expectedDeliveryAt || null, month)
      );
    })
    .filter((order) => (statusNorm === "ALL" ? true : order.status === statusNorm))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return {
    count: filtered.length,
    totalCents: filtered.reduce((acc, order) => acc + (Number(order.totalCents) || 0), 0),
    rows: filtered,
    appliedStatus: statusNorm,
  };
}

async function buildPack({ salonId, month, basis }) {

  const range = monthRange(month);
  if (!range) {
    const err = new Error("month inválido. Use YYYY-MM");
    err.status = 400;
    throw err;
  }

  const from = range.from;
  const to = range.to;

  // DFC (real + projetado)
  const epoch = new Date(0);

  const prevReal = await calcCashflow({ salonId, from: epoch, to: from, basis: "paid" });
  const curReal = await calcCashflow({ salonId, from, to, basis: "paid" });

  const prevProj = await calcCashflow({ salonId, from: epoch, to: from, basis: "due" });
  const curProj = await calcCashflow({ salonId, from, to, basis: "due" });

  const dfc = {
    real: {
      initialBalanceCents: prevReal.netCents,
      inCents: curReal.inCents,
      outCents: curReal.outCents,
      netCents: curReal.netCents,
      finalBalanceCents: prevReal.netCents + curReal.netCents,
    },
    projected: {
      initialBalanceCents: prevProj.netCents,
      inCents: curProj.inCents,
      outCents: curProj.outCents,
      netCents: curProj.netCents,
      finalBalanceCents: prevProj.netCents + curProj.netCents,
    },
  };

  // Resumo (com base REAL — dinheiro que entrou/ saiu de verdade)
  const summary = {
    revenueCents: dfc.real.inCents,
    expensesCents: dfc.real.outCents,
    netCents: dfc.real.netCents,
  };

  // DRE (base escolhida: due/paid)
  const revenueSalesCents =
    basis === "paid"
      ? (await sumLegacyAutoInAppointments({ salonId, from, to })) + (await sumReceivablesPaid({ salonId, from, to }))
      : (await sumLegacyAutoInAppointments({ salonId, from, to })) + (await sumReceivablesDue({ salonId, from, to }));

  const payablesCents =
    basis === "paid"
      ? await sumPayablesPaid({ salonId, from, to })
      : await sumPayablesDue({ salonId, from, to });

  const variableCostsCents =
    (await sumCostsByType({ salonId, from, to, type: "VARIAVEL" })) + payablesCents;

  const fixedCostsCents = await sumCostsByType({ salonId, from, to, type: "FIXO" });

  const grossProfitCents = revenueSalesCents - variableCostsCents;
  const operatingProfitCents = grossProfitCents - fixedCostsCents;
  const marginPct = revenueSalesCents > 0 ? (operatingProfitCents / revenueSalesCents) * 100 : 0;

  const dre = {
    month,
    basis,
    revenueCents: revenueSalesCents,
    variableCostsCents,
    fixedCostsCents,
    grossProfitCents,
    operatingProfitCents,
    marginPct,
  };

  // Próximos 7/15/30
  const next7 = await upcomingTotals({ salonId, days: 7 });
  const next15 = await upcomingTotals({ salonId, days: 15 });
  const next30 = await upcomingTotals({ salonId, days: 30 });

  // Vencidos (em aberto)
  const overdue = await getOverdueItems({ salonId, take: 25 });

  // Últimas transações do mês
  const lastTransactions = await getLastTransactions({ salonId, from, to, take: 18 });

  const salesDelivered = await getDeliveredSalesForPack({ salonId, month });

  return {
    meta: {
      month,
      basis,
      period: { from: from.toISOString(), to: to.toISOString() },
      generatedAt: new Date().toISOString(),
    },
    summary,
    dre,
    dfc,
     upcoming: { d7: next7, d15: next15, d30: next30 },
    overdue,
    lastTransactions,
    salesDelivered,
  };
}

async function reportSalesHistoryPdf(req, res) {
  const { salonId } = req.user;

  const month = String(req.query.month || "").trim();
  const statusRaw = String(req.query.status || "ALL").trim().toUpperCase();
  const status = normalizeSalesHistoryStatus(statusRaw);

  if (!status) {
    return res.status(400).json({ message: "status inválido." });
  }

  let data;
  try {
    data = await getSalesHistoryRows({ salonId, month, status });
  } catch (e) {
    const code = e.status || 500;
    return res.status(code).json({ message: e.message || "Erro ao gerar PDF do histórico." });
  }

  const statusLabelMap = {
    ALL: "Todos",
    ORCAMENTO: "Orçamento",
    PEDIDO: "Pedido",
    EM_PRODUCAO: "Em produção",
    PRONTO: "Pronto",
    ENTREGUE: "Entregue",
    CANCELADO: "Cancelado",
  };

  const statusLabel = statusLabelMap[data.appliedStatus] || data.appliedStatus;
  const filenameStatus = data.appliedStatus === "ALL" ? "TODOS" : data.appliedStatus;
  const filename = `Historico_Vendas_${month}_${filenameStatus}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(res);

  const pageW = doc.page.width;
  const margin = doc.page.margins.left;
  const ctx = { month, basisLabel: "Histórico de vendas" };

  function drawHistoryMiniHeader() {
    doc.rect(0, 0, pageW, 46).fill("#0b1220");
    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(`Histórico de vendas • ${month}`, margin, 14, { width: pageW - margin * 2 });

    doc
      .fillColor("#cbd5e1")
      .font("Helvetica")
      .fontSize(9)
      .text(`Filtro: ${statusLabel}`, margin, 30, { width: pageW - margin * 2 });

    return 60;
  }

  // Header principal
  doc.rect(0, 0, pageW, 92).fill("#0866ff");
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(20)
    .text("Histórico de vendas", margin, 28, { width: pageW - margin * 2 });

  doc
    .fillColor("#dbeafe")
    .font("Helvetica")
    .fontSize(11)
    .text(`Período: ${month} • Filtro: ${statusLabel}`, margin, 58, {
      width: pageW - margin * 2,
    });

  doc.fillColor("#0f172a");
  let y = 110;

  // Resumo
  y = ensureSpace(doc, y, 120, ctx, false);

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(14).text("Resumo do histórico", margin, y);
  y += 16;

  doc
    .fillColor("#64748b")
    .font("Helvetica")
    .fontSize(10)
    .text("Esse PDF reflete exatamente o filtro aplicado na aba Histórico de vendas.", margin, y);

  y += 16;

  y = drawCardsRow(doc, y, [
    { title: "Registros", value: String(data.count || 0) },
    { title: "Total visível", value: moneyBRL(data.totalCents || 0) },
    { title: "Status aplicado", value: statusLabel, foot: `Período: ${month}` },
  ]);

  // Tabela
  y = ensureSpace(doc, y, 110, ctx, false);

 doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Pedidos filtrados", margin, y);
  y += 16;

  const cols = ["Criado", "Cliente", "Status", "Entrega", "Pgto", "Valor"];
  const colW = [78, 141, 74, 82, 60, 80];

  let ty = drawTableHeader(doc, margin, y, cols, colW);

  const rows = (data.rows || []).slice(0, 200);

  if (!rows.length) {
    ty = drawTableRow(
      doc,
      margin,
      ty,
      ["—", "—", "—", "—", "Nenhum pedido", moneyBRL(0)],
      colW,
      22,
      [5]
    );
  } else {
    for (const order of rows) {
      ty = ensureSpace(doc, ty, 30, ctx, true);

      if (ty === 60) {
        drawHistoryMiniHeader();
        doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Pedidos filtrados", margin, 74);
        ty = drawTableHeader(doc, margin, 98, cols, colW);
      }

      ty = drawTableRow(
        doc,
        margin,
        ty,
        [
          fmtBR(order.createdAt),
          clipPdfText(order.client?.name || "—", 26),
          orderStatusLabelPdf(order.status),
          fmtBR(order.expectedDeliveryAt),
          clipPdfText(paymentLabelPdf(order.paymentMode, order.paymentMethod), 13),
          moneyBRL(order.totalCents || 0),
        ],
        colW,
        22,
        [5]
      );
    }
  }

  // Footer
  const footerY = doc.page.height - doc.page.margins.bottom - 12;
  doc.fillColor("#94a3b8").font("Helvetica").fontSize(9).text(
    `Gerado em ${fmtBR(new Date())} • Marcenaria SaaS`,
    margin,
    footerY,
    { width: pageW - margin * 2, align: "center" }
  );

  doc.end();
}

// --------------------
// Controllers
// --------------------
async function reportPack(req, res) {
  const { salonId } = req.user;

  const month = String(req.query.month || "").trim();
  const basisRaw = String(req.query.basis || "due").toLowerCase();
  const basis = basisRaw === "paid" ? "paid" : "due";

  try {
    const pack = await buildPack({ salonId, month, basis });
    return res.json(pack);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ message: e.message || "Erro ao gerar relatório." });
  }
}

function drawMiniHeader(doc, ctx) {
  const pageW = doc.page.width;
  const margin = doc.page.margins.left;

  doc.rect(0, 0, pageW, 46).fill("#0b1220");
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(`Relatório Financeiro • ${ctx.month}`, margin, 14, { width: pageW - margin * 2 });

  doc
    .fillColor("#cbd5e1")
    .font("Helvetica")
    .fontSize(9)
    .text(`Base DRE: ${ctx.basisLabel}`, margin, 30, { width: pageW - margin * 2 });

  return 60; // y inicial recomendado após mini header
}

function ensureSpace(doc, y, needed, ctx, withMiniHeader = true) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (y + needed <= bottom) return y;

  doc.addPage();
  return withMiniHeader ? drawMiniHeader(doc, ctx) : doc.page.margins.top;
}

function sectionBox(doc, x, y, w, h, title) {
  doc.roundedRect(x, y, w, h, 12).fillAndStroke("#ffffff", "#e6eaf2");

  if (title) {
    doc
      .fillColor("#0f172a")
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(title, x + 12, y + 10, { width: w - 24 });
  }

  return { x: x + 12, y: y + (title ? 32 : 12), w: w - 24, h: h - (title ? 44 : 24) };
}

function textEllipsis(doc, text, x, y, w, opts = {}) {
  doc.text(String(text ?? ""), x, y, {
    width: w,
    lineBreak: false,
    ellipsis: true,
    ...opts,
  });
}

function drawCardsRow(doc, y, cards) {
  const pageW = doc.page.width;
  const margin = doc.page.margins.left;

  const gap = 10;
  const cols = 3;
  const w = (pageW - margin * 2 - gap * (cols - 1)) / cols;
  const h = 64;

  cards.forEach((c, i) => {
    const x = margin + i * (w + gap);
    doc.roundedRect(x, y, w, h, 12).fillAndStroke("#f8fafc", "#e6eaf2");

    doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(10);
    textEllipsis(doc, c.title, x + 12, y + 10, w - 24);

    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(14);
    textEllipsis(doc, c.value, x + 12, y + 30, w - 24);

    if (c.foot) {
      doc.fillColor("#94a3b8").font("Helvetica").fontSize(9);
      textEllipsis(doc, c.foot, x + 12, y + 50, w - 24);
    }
  });

  return y + h + 18;
}

function drawKeyValueRows(doc, x, y, w, rows) {
  const rowH = 16;
  rows.forEach((r, idx) => {
    const yy = y + idx * rowH;

    doc.fillColor("#0f172a").font("Helvetica").fontSize(11);
    textEllipsis(doc, r.label, x, yy, w - 190);

    doc.fillColor("#0f172a").font(r.bold ? "Helvetica-Bold" : "Helvetica").fontSize(11);
    doc.text(r.value, x + (w - 180), yy, { width: 180, align: "right", lineBreak: false, ellipsis: true });
  });

  return y + rows.length * rowH;
}

function drawTableHeader(doc, x, y, cols, colW) {
  doc.rect(x, y, colW.reduce((a, b) => a + b, 0), 22).fill("#f8fafc");
  doc.strokeColor("#e6eaf2").lineWidth(1).rect(x, y, colW.reduce((a, b) => a + b, 0), 22).stroke();

  doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(10);

  let xx = x;
  cols.forEach((c, i) => {
    const w = colW[i];
    doc.text(c, xx + 8, y + 6, { width: w - 16, lineBreak: false, ellipsis: true });
    xx += w;
  });

  return y + 22;
}

function drawTableRow(doc, x, y, cells, colW, rowH = 18, rightAlignIdx = []) {

  function orderStatusLabelPdf(status) {
  const map = {
    ORCAMENTO: "Orçamento",
    PEDIDO: "Pedido",
    EM_PRODUCAO: "Em produção",
    PRONTO: "Pronto",
    ENTREGUE: "Entregue",
    CANCELADO: "Cancelado",
  };
  return map[String(status || "").toUpperCase()] || String(status || "—");
}

function paymentLabelPdf(paymentMode, paymentMethod) {
  const modeMap = {
    AVISTA: "À vista",
    PARCELADO: "Parcelado",
  };

  const methodMap = {
    PIX: "Pix",
    CARTAO: "Cartão",
    DINHEIRO: "Dinheiro",
    BOLETO: "Boleto",
    TRANSFERENCIA: "Transferência",
    OUTRO: "Outro",
  };

  const mode = modeMap[String(paymentMode || "").toUpperCase()] || String(paymentMode || "");
  const method = methodMap[String(paymentMethod || "").toUpperCase()] || String(paymentMethod || "");

  return [mode, method].filter(Boolean).join(" / ") || "—";
}

function drawTableRowAuto(doc, x, y, cells, colW, opts = {}) {
  const rightAlignIdx = opts.rightAlignIdx || [];
  const fontSize = opts.fontSize || 9;
  const minRowH = opts.minRowH || 22;
  const padX = opts.padX || 8;
  const padY = opts.padY || 5;

  doc.font("Helvetica").fontSize(fontSize);

  const heights = cells.map((txt, i) => {
    const w = colW[i];
    return doc.heightOfString(String(txt ?? ""), {
      width: w - padX * 2,
      align: rightAlignIdx.includes(i) ? "right" : "left",
      lineGap: 1,
    });
  });

  const contentH = Math.max(...heights, fontSize + 2);
  const rowH = Math.max(minRowH, contentH + padY * 2);

  doc
    .strokeColor("#eef2f7")
    .lineWidth(1)
    .moveTo(x, y + rowH)
    .lineTo(x + colW.reduce((a, b) => a + b, 0), y + rowH)
    .stroke();

  doc.fillColor("#0f172a").font("Helvetica").fontSize(fontSize);

  let xx = x;
  cells.forEach((txt, i) => {
    const w = colW[i];
    const isRight = rightAlignIdx.includes(i);

    doc.text(String(txt ?? ""), xx + padX, y + padY, {
      width: w - padX * 2,
      align: isRight ? "right" : "left",
      lineGap: 1,
    });

    xx += w;
  });

  return y + rowH;
}

  doc.strokeColor("#eef2f7").lineWidth(1).moveTo(x, y + rowH).lineTo(x + colW.reduce((a, b) => a + b, 0), y + rowH).stroke();

  doc.fillColor("#0f172a").font("Helvetica").fontSize(10);

  let xx = x;
  cells.forEach((txt, i) => {
    const w = colW[i];
    const isRight = rightAlignIdx.includes(i);
    doc.text(String(txt ?? ""), xx + 8, y + 4, {
      width: w - 16,
      align: isRight ? "right" : "left",
      lineBreak: false,
      ellipsis: true,
    });
    xx += w;
  });

  return y + rowH;
}

async function reportPackPdf(req, res) {
  const { salonId } = req.user;

  const month = String(req.query.month || "").trim();
  const basisRaw = String(req.query.basis || "due").toLowerCase();
  const basis = basisRaw === "paid" ? "paid" : "due";

  let pack;
  try {
    pack = await buildPack({ salonId, month, basis });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ message: e.message || "Erro ao gerar PDF." });
  }

  const basisLabel = basis === "paid" ? "REAL (pagamento)" : "PROJETADO (vencimento)";
  const ctx = { month, basisLabel };

  const filename = `Relatorio_${month}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(res);

  const pageW = doc.page.width;
  const margin = doc.page.margins.left;

  // Header principal
  doc.rect(0, 0, pageW, 92).fill("#0866ff");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(20).text("Relatório Financeiro", margin, 28, { width: pageW - margin * 2 });
    doc.fillColor("#dbeafe").font("Helvetica").fontSize(11).text(
    `Período: ${month} • Base DRE: ${basisLabel} • Inclui vendas entregues`,
    margin,
    58,
    { width: pageW - margin * 2 }
  );

  doc.fillColor("#0f172a");
  let y = 110;

  // ===== Resumo (cards fixos e alinhados) =====
  y = ensureSpace(doc, y, 120, ctx, false);

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(14).text("Resumo do período", margin, y);
  y += 16;
  doc.fillColor("#64748b").font("Helvetica").fontSize(10).text("Receitas e despesas (base REAL - paidAt) + saldo líquido.", margin, y);
  y += 16;

  y = drawCardsRow(doc, y, [
    { title: "Receitas", value: moneyBRL(pack.summary.revenueCents) },
    { title: "Despesas", value: moneyBRL(pack.summary.expensesCents) },
    { title: "Saldo líquido", value: moneyBRL(pack.summary.netCents) },
  ]);

  // ===== DRE (dentro de box com altura fixa e espaçamento correto) =====
  y = ensureSpace(doc, y, 210, ctx, false);

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(14).text("DRE (Demonstrativo de Resultado)", margin, y);
  y += 14;

  const dreBoxH = 150;
  const dreBox = sectionBox(doc, margin, y, pageW - margin * 2, dreBoxH, null);

  drawKeyValueRows(doc, dreBox.x, dreBox.y, dreBox.w, [
    { label: "Receita do período", value: moneyBRL(pack.dre.revenueCents) },
    { label: "CMV / Custos variáveis", value: moneyBRL(pack.dre.variableCostsCents) },
    { label: "Lucro bruto", value: moneyBRL(pack.dre.grossProfitCents), bold: true },
    { label: "Custos fixos", value: moneyBRL(pack.dre.fixedCostsCents) },
    { label: "Lucro operacional", value: moneyBRL(pack.dre.operatingProfitCents), bold: true },
    { label: "Margem", value: `${Number(pack.dre.marginPct || 0).toFixed(2)}%`, bold: true },
  ]);

  y = y + dreBoxH + 18;

  // ===== DFC (2 boxes alinhados) =====
  y = ensureSpace(doc, y, 160, ctx, false);

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(14).text("DFC (Fluxo de Caixa)", margin, y);
  y += 14;

  const gap = 10;
  const boxW = (pageW - margin * 2 - gap) / 2;
  const boxH = 105;

  const real = pack.dfc.real;
  const proj = pack.dfc.projected;

  const b1 = sectionBox(doc, margin, y, boxW, boxH, "Real (paidAt)");
  drawKeyValueRows(doc, b1.x, b1.y, b1.w, [
    { label: "Saldo inicial", value: moneyBRL(real.initialBalanceCents) },
    { label: "Entradas", value: moneyBRL(real.inCents) },
    { label: "Saídas", value: moneyBRL(real.outCents) },
    { label: "Saldo final", value: moneyBRL(real.finalBalanceCents), bold: true },
  ]);

  const b2 = sectionBox(doc, margin + boxW + gap, y, boxW, boxH, "Projetado (dueDate)");
  drawKeyValueRows(doc, b2.x, b2.y, b2.w, [
    { label: "Saldo inicial", value: moneyBRL(proj.initialBalanceCents) },
    { label: "Entradas", value: moneyBRL(proj.inCents) },
    { label: "Saídas", value: moneyBRL(proj.outCents) },
    { label: "Saldo final", value: moneyBRL(proj.finalBalanceCents), bold: true },
  ]);

  y = y + boxH + 18;

  // ===== Próximos vencimentos (tabela dentro de box) =====
  y = ensureSpace(doc, y, 140, ctx, false);

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Próximos vencimentos (resumo)", margin, y);
  y += 12;

  const upBoxH = 98;
  const upBox = sectionBox(doc, margin, y, pageW - margin * 2, upBoxH, null);

  const cols = ["Janela", "A receber", "A pagar"];
  const colW = [140, (upBox.w - 140) / 2, (upBox.w - 140) / 2];

  let ty = drawTableHeader(doc, upBox.x, upBox.y, cols, colW);
  ty = drawTableRow(doc, upBox.x, ty, ["7 dias", moneyBRL(pack.upcoming.d7.toReceiveCents), moneyBRL(pack.upcoming.d7.toPayCents)], colW, 18, [1, 2]);
  ty = drawTableRow(doc, upBox.x, ty, ["15 dias", moneyBRL(pack.upcoming.d15.toReceiveCents), moneyBRL(pack.upcoming.d15.toPayCents)], colW, 18, [1, 2]);
  drawTableRow(doc, upBox.x, ty, ["30 dias", moneyBRL(pack.upcoming.d30.toReceiveCents), moneyBRL(pack.upcoming.d30.toPayCents)], colW, 18, [1, 2]);

  y = y + upBoxH + 18;

  // ===== Movimentos vencidos (tabela paginada, nada “solto”) =====
  y = ensureSpace(doc, y, 120, ctx, false);

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Movimentos vencidos (em aberto)", margin, y);
  y += 10;

  const overdueCols = ["Venc.", "Tipo", "Descrição", "Valor"];
  const overdueW = [70, 80, (pageW - margin * 2) - (70 + 80 + 110), 110];
  let oy = y;

  oy = ensureSpace(doc, oy, 80, ctx, false);
  oy = drawTableHeader(doc, margin, oy, overdueCols, overdueW);

  const overdueItems = (pack.overdue.items || []).slice(0, 25);
  if (!overdueItems.length) {
    oy = drawTableRow(doc, margin, oy, ["—", "—", "Nenhum vencido encontrado", moneyBRL(0)], overdueW, 18, [3]);
  } else {
    for (const it of overdueItems) {
      oy = ensureSpace(doc, oy, 26, ctx, true);
      if (oy === 60) {
        // nova página: redesenha o cabeçalho da tabela
        doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Movimentos vencidos (em aberto)", margin, 74);
        oy = drawTableHeader(doc, margin, 98, overdueCols, overdueW);
      }

      oy = drawTableRow(
        doc,
        margin,
        oy,
        [fmtBR(it.dueDate), it.kind, it.subtitle || it.title || "—", moneyBRL(it.amountCents || 0)],
        overdueW,
        18,
        [3]
      );
    }
  }

  y = oy + 18;

  // ===== Últimas transações (tabela paginada) =====
  y = ensureSpace(doc, y, 110, ctx, false);

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Últimas transações do período", margin, y);
  y += 10;

  const txCols = ["Data", "Origem", "Nome", "Valor"];
  const txW = [70, 90, (pageW - margin * 2) - (70 + 90 + 110), 110];

  let py = y;
  py = drawTableHeader(doc, margin, py, txCols, txW);

  const txItems = (pack.lastTransactions || []).slice(0, 30);
   if (!txItems.length) {
    py = drawTableRow(doc, margin, py, ["—", "—", "Sem transações no período", moneyBRL(0)], txW, 18, [3]);
  } else {
    for (const t of txItems) {
      py = ensureSpace(doc, py, 26, ctx, true);
      if (py === 60) {
        doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Últimas transações do período", margin, 74);
        py = drawTableHeader(doc, margin, 98, txCols, txW);
      }

      const sign = t.type === "IN" ? "+" : "-";
      py = drawTableRow(
        doc,
        margin,
        py,
        [fmtBR(t.occurredAt), t.source, t.name, `${sign}${moneyBRL(t.amountCents || 0)}`],
        txW,
        18,
        [3]
      );
    }
  }

  y = py + 18;

  // ===== Histórico de vendas entregues (resumo + tabela paginada) =====
  y = ensureSpace(doc, y, 150, ctx, false);

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Histórico de vendas entregues", margin, y);
  y += 10;

  y = drawCardsRow(doc, y, [
    { title: "Qtd. entregues", value: String(pack.salesDelivered?.count || 0) },
    { title: "Total vendido", value: moneyBRL(pack.salesDelivered?.totalCents || 0) },
    { title: "Filtro", value: "Status: ENTREGUE", foot: `Período: ${month}` },
  ]);

  const salesCols = ["Data", "Cliente", "Status", "Entrega", "Pagamento", "Valor"];
  const salesW = [62, 120, 76, 70, (pageW - margin * 2) - (62 + 120 + 76 + 70 + 90), 90];

  let sy = y;
  sy = drawTableHeader(doc, margin, sy, salesCols, salesW);

  const salesItems = (pack.salesDelivered?.rows || []).slice(0, 40);

  if (!salesItems.length) {
    sy = drawTableRow(
      doc,
      margin,
      sy,
      ["—", "—", "—", "—", "Nenhuma venda entregue no período", moneyBRL(0)],
      salesW,
      18,
      [5]
    );
  } else {
    for (const sale of salesItems) {
      sy = ensureSpace(doc, sy, 26, ctx, true);
      if (sy === 60) {
        doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Histórico de vendas entregues", margin, 74);
        sy = drawTableHeader(doc, margin, 98, salesCols, salesW);
      }

      const paymentLabel =
        [sale.paymentMode, sale.paymentMethod]
          .filter(Boolean)
          .join(" • ") || "—";

      const deliveryDate = sale.deliveredAt || sale.expectedDeliveryAt || null;

      sy = drawTableRow(
        doc,
        margin,
        sy,
        [
          fmtBR(sale.createdAt),
          sale.client?.name || "—",
          sale.status || "—",
          fmtBR(deliveryDate),
          paymentLabel,
          moneyBRL(sale.totalCents || 0),
        ],
        salesW,
        18,
        [5]
      );
    }
  }

  y = sy + 18;

  // Footer
  const footerY = doc.page.height - doc.page.margins.bottom - 12;
  doc.fillColor("#94a3b8").font("Helvetica").fontSize(9).text(
    `Gerado em ${fmtBR(pack.meta.generatedAt)} • Marcenaria SaaS`,
    margin,
    footerY,
    { width: pageW - margin * 2, align: "center" }
  );

  doc.end();
}

module.exports = {
  reportPack,
  reportPackPdf,
  reportSalesHistoryPdf,
};