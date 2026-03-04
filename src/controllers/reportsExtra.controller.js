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
  };
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

function drawRow(doc, label, value, xL, xR, y, options = {}) {
  const { bold = false } = options;
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11).fillColor("#0f172a").text(label, xL, y, { width: 280 });
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11).fillColor("#0f172a").text(value, xR - 180, y, { width: 180, align: "right" });
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

  // headers
  const filename = `Relatorio_${month}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(res);

  const pageW = doc.page.width;
  const margin = doc.page.margins.left;

  // Header
  doc.rect(0, 0, pageW, 90).fill("#0866ff");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(20).text("Relatório Financeiro", margin, 28, { width: pageW - margin * 2 });
  doc.fillColor("#dbeafe").font("Helvetica").fontSize(11).text(
    `Período: ${month} • Base DRE: ${basis === "paid" ? "REAL (pagamento)" : "PROJETADO (vencimento)"}`,
    margin,
    56,
    { width: pageW - margin * 2 }
  );

  doc.fillColor("#0f172a");
  let y = 110;

  // Resumo
  doc.font("Helvetica-Bold").fontSize(14).text("Resumo do período", margin, y);
  y += 14;
  doc.font("Helvetica").fontSize(10).fillColor("#64748b").text("Receitas e despesas (base REAL - paidAt) + saldo líquido.", margin, y);
  doc.fillColor("#0f172a");
  y += 18;

  // Cards (simples)
  const cardW = (pageW - margin * 2 - 16) / 3;
  const cardH = 56;
  const cardY = y;

  const cards = [
    { t: "Receitas", v: moneyBRL(pack.summary.revenueCents) },
    { t: "Despesas", v: moneyBRL(pack.summary.expensesCents) },
    { t: "Saldo líquido", v: moneyBRL(pack.summary.netCents) },
  ];

  cards.forEach((c, i) => {
    const x = margin + i * (cardW + 8);
    doc.roundedRect(x, cardY, cardW, cardH, 10).fillAndStroke("#f8fafc", "#e6eaf2");
    doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(10).text(c.t, x + 12, cardY + 10, { width: cardW - 24 });
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text(c.v, x + 12, cardY + 28, { width: cardW - 24 });
  });

  y += cardH + 18;

  // DRE
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(14).text("DRE (Demonstrativo de Resultado)", margin, y);
  y += 18;

  doc.roundedRect(margin, y, pageW - margin * 2, 150, 10).stroke("#e6eaf2");
  y += 10;

  const xL = margin + 12;
  const xR = pageW - margin - 12;

  drawRow(doc, "Receita do período", moneyBRL(pack.dre.revenueCents), xL, xR, y);
  y += 16;
  drawRow(doc, "CMV / Custos variáveis (Pagáveis + Variáveis)", moneyBRL(pack.dre.variableCostsCents), xL, xR, y);
  y += 16;
  drawRow(doc, "Lucro bruto", moneyBRL(pack.dre.grossProfitCents), xL, xR, y, { bold: true });
  y += 16;
  drawRow(doc, "Custos fixos", moneyBRL(pack.dre.fixedCostsCents), xL, xR, y);
  y += 16;
  drawRow(doc, "Lucro operacional", moneyBRL(pack.dre.operatingProfitCents), xL, xR, y, { bold: true });
  y += 16;
  drawRow(doc, "Margem", `${Number(pack.dre.marginPct || 0).toFixed(2)}%`, xL, xR, y, { bold: true });

  y += 28;

  // DFC
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(14).text("DFC (Fluxo de Caixa)", margin, y);
  y += 18;

  const boxW = (pageW - margin * 2 - 10) / 2;
  const boxH = 95;

  const dfcBoxes = [
    { title: "Real (paidAt)", data: pack.dfc.real },
    { title: "Projetado (dueDate)", data: pack.dfc.projected },
  ];

  dfcBoxes.forEach((b, i) => {
    const x = margin + i * (boxW + 10);
    doc.roundedRect(x, y, boxW, boxH, 10).fillAndStroke("#ffffff", "#e6eaf2");
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(11).text(b.title, x + 12, y + 10);
    doc.fillColor("#64748b").font("Helvetica").fontSize(10).text(`Saldo inicial: ${moneyBRL(b.data.initialBalanceCents)}`, x + 12, y + 30);
    doc.text(`Entradas: ${moneyBRL(b.data.inCents)}`, x + 12, y + 45);
    doc.text(`Saídas: ${moneyBRL(b.data.outCents)}`, x + 12, y + 60);
    doc.fillColor("#0f172a").font("Helvetica-Bold").text(`Saldo final: ${moneyBRL(b.data.finalBalanceCents)}`, x + 12, y + 76);
  });

  y += boxH + 18;

  // Próximos 7/15/30
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Próximos vencimentos (resumo)", margin, y);
  y += 14;

  const up = [
    { d: "7 dias", v: pack.upcoming.d7 },
    { d: "15 dias", v: pack.upcoming.d15 },
    { d: "30 dias", v: pack.upcoming.d30 },
  ];

  up.forEach((u) => {
    doc.fillColor("#64748b").font("Helvetica").fontSize(10).text(
      `${u.d}: A receber ${moneyBRL(u.v.toReceiveCents)} • A pagar ${moneyBRL(u.v.toPayCents)}`,
      margin,
      y
    );
    y += 12;
  });

  y += 10;

  // Vencidos + Últimas transações (pode quebrar de página)
  const ensureSpace = (needed) => {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (y + needed > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  };

  ensureSpace(180);
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Movimentos vencidos (em aberto)", margin, y);
  y += 14;

  const venc = (pack.overdue.items || []).slice(0, 10);
  if (!venc.length) {
    doc.fillColor("#64748b").font("Helvetica").fontSize(10).text("Nenhum movimento vencido encontrado.", margin, y);
    y += 14;
  } else {
    venc.forEach((it) => {
      doc.fillColor("#0f172a").font("Helvetica").fontSize(10).text(
        `${fmtBR(it.dueDate)} • ${it.kind} • ${it.subtitle} • ${moneyBRL(it.amountCents)}`,
        margin,
        y,
        { width: pageW - margin * 2 }
      );
      y += 12;
    });
  }

  y += 10;
  ensureSpace(200);

  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Últimas transações do período", margin, y);
  y += 14;

  const tx = (pack.lastTransactions || []).slice(0, 12);
  if (!tx.length) {
    doc.fillColor("#64748b").font("Helvetica").fontSize(10).text("Sem transações no período.", margin, y);
    y += 14;
  } else {
    tx.forEach((t) => {
      const sign = t.type === "IN" ? "+" : "-";
      doc.fillColor("#0f172a").font("Helvetica").fontSize(10).text(
        `${fmtBR(t.occurredAt)} • ${t.source} • ${t.name} • ${sign}${moneyBRL(t.amountCents)}`,
        margin,
        y,
        { width: pageW - margin * 2 }
      );
      y += 12;
    });
  }

  // Footer
  ensureSpace(40);
  doc.fillColor("#94a3b8").font("Helvetica").fontSize(9).text(
    `Gerado em ${fmtBR(pack.meta.generatedAt)} • Marcenaria SaaS`,
    margin,
    doc.page.height - doc.page.margins.bottom - 12,
    { width: pageW - margin * 2, align: "center" }
  );

  doc.end();
}

module.exports = {
  reportPack,
  reportPackPdf,
};