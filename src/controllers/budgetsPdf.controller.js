const PDFDocument = require("pdfkit");
const http = require("http");
const https = require("https");
const { prisma } = require("../lib/prisma");

function moneyBRL(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtDate(d) {
  if (!d) return "-";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleDateString("pt-BR");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function clipText(s, max = 140) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max - 1).trim() + "…" : t;
}

function clientNotes(raw) {
  if (!raw) return "";
  let s = String(raw);

  const sep = s.indexOf("\n—");
  if (sep !== -1) s = s.slice(0, sep);

  const markers = ["RESUMO DO ORÇAMENTO", "MATERIAIS (por item):", "MATERIAIS:"];
  for (const m of markers) {
    const idx = s.indexOf(m);
    if (idx !== -1) s = s.slice(0, idx);
  }

  return s.trim();
}

function buildClientAddress(c) {
  const line1 = [
    c?.logradouro ? String(c.logradouro).trim() : "",
    c?.numero ? `nº ${String(c.numero).trim()}` : "",
    c?.complemento ? String(c.complemento).trim() : "",
  ]
    .filter(Boolean)
    .join(", ");

  const cityUF = [c?.cidade, c?.estado].filter(Boolean).join(" - ");

  const line2 = [
    c?.bairro ? String(c.bairro).trim() : "",
    cityUF ? cityUF : "",
    c?.cep ? `CEP ${onlyDigits(c.cep)}` : "",
  ]
    .filter(Boolean)
    .join(" - ");

  const oneLine = [line1, line2].filter(Boolean).join(" - ");
  return oneLine || "-";
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const isHttps = /^https:/i.test(url);
    const lib = isHttps ? https : http;

    lib
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

function drawBar(doc, x, y, w, h, text, color) {
  doc.save();
  doc.roundedRect(x, y, w, h, 6).fill(color);
  doc
    .fillColor("#ffffff")
    .fontSize(10)
    .font("Helvetica-Bold")
    .text(text, x, y + 4, {
      width: w,
      align: "center",
    });
  doc.restore();
}

function drawField(doc, x, y, w, label, value, opts = {}) {
  const { align = "left", valueFontSize = 9 } = opts;

  doc.save();

  doc.fillColor("#64748b").fontSize(7).font("Helvetica-Bold").text(label, x, y);

  const boxY = y + 10;
  const boxH = 18;

  doc
    .lineWidth(0.8)
    .strokeColor("#e6eaf2")
    .fillColor("#f8fafc")
    .roundedRect(x, boxY, w, boxH, 5)
    .fillAndStroke();

  doc.fillColor("#0f172a").font("Helvetica").fontSize(valueFontSize);

  if (align === "center") {
    doc.text(String(value ?? "-"), x, boxY + 4, { width: w, align: "center" });
  } else if (align === "right") {
    doc.text(String(value ?? "-"), x, boxY + 4, {
      width: w - 6,
      align: "right",
    });
  } else {
    doc.text(String(value ?? "-"), x + 6, boxY + 4, {
      width: w - 12,
      align: "left",
    });
  }

  doc.restore();
}

async function budgetPdf(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const budget = await prisma.budget.findFirst({
    where: { id, salonId },
    include: {
      salon: { select: { name: true, phone: true, address: true, logoUrl: true } },
      client: {
        select: {
          name: true,
          cpf: true,
          email: true,
          phone: true,
          instagram: true,
          cep: true,
          logradouro: true,
          numero: true,
          complemento: true,
          bairro: true,
          cidade: true,
          estado: true,
        },
      },
      items: { orderBy: { createdAt: "asc" } },
      installments: { orderBy: { number: "asc" } },
    },
  });

  if (!budget) {
    return res.status(404).json({ message: "Orçamento não encontrado." });
  }

  const download = String(req.query.download || "") === "1";
  const filename = `orcamento-${budget.id}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${filename}"`
  );

  const doc = new PDFDocument({ size: "A4", margin: 0 });
  doc.pipe(res);

  const BLUE = "#0866ff";
  const BORDER = "#e6eaf2";
  const SOFT = "#f8fafc";
  const TEXT = "#0f172a";
  const MUTED = "#64748b";

  const x0 = 40;
  const y0 = 30;
  const w0 = 515;
  const h0 = 780;
  const pageBottom = y0 + h0;

  doc.roundedRect(x0, y0, w0, h0, 10).fillAndStroke("#ffffff", BORDER);

  const salon = budget.salon || {};
  const client = budget.client || {};

  const headerH = 95;
  const headerY = y0;

  doc.roundedRect(x0, headerY, w0, 74, 10).fill(BLUE);

  const logoX = x0 + 12;
  const logoY = headerY + 10;
  const logoSize = 54;

  if (salon.logoUrl && /^https?:\/\//i.test(salon.logoUrl)) {
    try {
      const buf = await fetchBuffer(salon.logoUrl);
      doc.image(buf, logoX, logoY, { fit: [logoSize, logoSize] });
    } catch {
      // ignora
    }
  }

  const ref = String(budget.id).slice(-4).toUpperCase();
  const boxW = 92;
  const boxH = 38;
  const boxX = x0 + w0 - boxW - 12;
  const boxY = headerY + 12;

  doc.roundedRect(boxX, boxY, boxW, boxH, 8).fillAndStroke("#ffffff", "#dbeafe");
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(7)
    .text("N° Orçamento", boxX, boxY + 7, { width: boxW, align: "center" });
  doc
    .fillColor(TEXT)
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(ref, boxX, boxY + 18, { width: boxW, align: "center" });

  const titleLeft = x0 + 82;
  const titleRight = boxX - 10;
  const titleW = Math.max(200, titleRight - titleLeft);

  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(String(salon.name || "MARCENARIA").toUpperCase(), titleLeft, headerY + 16, {
      width: titleW,
      align: "center",
    });

  doc
    .fillColor("#dbeafe")
    .font("Helvetica")
    .fontSize(10)
    .text("Orçamento comercial", titleLeft, headerY + 38, {
      width: titleW,
      align: "center",
    });

  const hfY1 = headerY + 84;
  const gap = 10;

  const rowX = x0 + 8;
  const rowRight = x0 + w0 - 8;
  const rowW = rowRight - rowX;

  const wTel = 180;
  const wData = 140;
  const wPrev = rowW - wTel - wData - gap * 2;

  drawField(doc, rowX, hfY1, wTel, "Telefone", salon.phone || "-", { align: "center" });
  drawField(doc, rowX + wTel + gap, hfY1, wData, "Data orçamento", fmtDate(budget.createdAt), {
    align: "center",
  });
  drawField(
    doc,
    rowX + wTel + gap + wData + gap,
    hfY1,
    wPrev,
    "Previsão entrega",
    fmtDate(budget.expectedDeliveryAt),
    { align: "center" }
  );

  drawField(doc, rowX, hfY1 + 32, rowW, "Endereço", salon.address || "-", {
    align: "center",
    valueFontSize: 8,
  });

  const clientBarY = headerY + headerH + 22;
  drawBar(doc, x0 + 8, clientBarY, w0 - 16, 20, "CLIENTE", BLUE);

  const cY = clientBarY + 30;

  const wNome = 250;
  const wCpf = 120;
  const wTel2 = w0 - wNome - wCpf - gap * 2 - 16;

  drawField(doc, x0 + 8, cY, wNome, "Nome", client.name || "-", { align: "left" });
  drawField(doc, x0 + 8 + wNome + gap, cY, wCpf, "CPF/CNPJ", client.cpf || "-", {
    align: "center",
  });
  drawField(
    doc,
    x0 + 8 + wNome + gap + wCpf + gap,
    cY,
    wTel2,
    "Telefone",
    client.phone || "-",
    { align: "center" }
  );

  const cY2 = cY + 40;
  const wAddr = 336;
  const wEmail = w0 - wAddr - gap - 16;

  drawField(doc, x0 + 8, cY2, wAddr, "Endereço", clipText(buildClientAddress(client), 72), {
    align: "left",
    valueFontSize: 8,
  });

  drawField(
    doc,
    x0 + 8 + wAddr + gap,
    cY2,
    wEmail,
    "E-mail",
    clipText(client.email || "-", 34),
    { align: "center", valueFontSize: 8 }
  );

  const budgetBarY = cY2 + 54;
  drawBar(doc, x0 + 8, budgetBarY, w0 - 16, 20, "ORÇAMENTO", BLUE);

  const tableY = budgetBarY + 30;
  const tableInnerX = x0 + 8;
  const tableInnerW = w0 - 16;

  const cols = {
    n: 30,
    desc: 210,
    unit: 100,
    qty: 64,
    total: tableInnerW - (30 + 210 + 100 + 64),
  };

  const xN = tableInnerX;
  const xDesc = xN + cols.n;
  const xUnit = xDesc + cols.desc;
  const xQty = xUnit + cols.unit;
  const xTotal = xQty + cols.qty;

  doc.roundedRect(tableInnerX, tableY, tableInnerW, 22, 6).fillAndStroke(SOFT, BORDER);

  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9);
  doc.text("N°", xN + 6, tableY + 7, { width: cols.n - 8, align: "left" });
  doc.text("Descrição", xDesc + 6, tableY + 7, { width: cols.desc - 12, align: "left" });
  doc.text("Valor unitário", xUnit, tableY + 7, { width: cols.unit - 6, align: "right" });
  doc.text("Quantidade", xQty, tableY + 7, { width: cols.qty - 6, align: "right" });
  doc.text("Total do item", xTotal, tableY + 7, { width: cols.total - 6, align: "right" });

  let y = tableY + 28;
  const rowH = 19;

  const reserveBottom = 170;
  const maxTableY = pageBottom - reserveBottom;

  const items = Array.isArray(budget.items) ? budget.items : [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (y + rowH > maxTableY) break;

    doc
      .lineWidth(0.5)
      .strokeColor("#eef2f7")
      .moveTo(tableInnerX, y + 15)
      .lineTo(tableInnerX + tableInnerW, y + 15)
      .stroke();

    const desc = it.description ? `${it.name} — ${it.description}` : it.name;

    doc.fillColor(TEXT).font("Helvetica").fontSize(9);
    doc.text(String(i + 1), xN + 6, y, {
      width: cols.n - 8,
      align: "left",
    });
    doc.text(clipText(desc, 52), xDesc + 6, y, {
      width: cols.desc - 12,
      align: "left",
    });
    doc.text(moneyBRL(it.unitPriceCents), xUnit, y, {
      width: cols.unit - 6,
      align: "right",
    });
    doc.text(String(it.quantity || 1), xQty, y, {
      width: cols.qty - 6,
      align: "right",
    });
    doc.text(moneyBRL(it.totalCents), xTotal, y, {
      width: cols.total - 6,
      align: "right",
    });

    y += rowH;
  }

  const bottomY = Math.max(y + 14, maxTableY + 10);

  const obsW = 330;
  const valW = 175;
  const gap2 = 10;

  const obsX = x0 + 8;
  const valX = obsX + obsW + gap2;

  const bottomH = pageBottom - bottomY - 18;

  doc.roundedRect(obsX, bottomY, obsW, bottomH, 8).fillAndStroke("#ffffff", BORDER);
  doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(11).text("Observações", obsX + 12, bottomY + 12);

  const notesUser = clientNotes(budget.notes);
  const discountCents = Number(budget.discountCents || 0);
  const baseTotal = Number(budget.subtotalCents || 0);
  const totalCents = Number(budget.totalCents || 0);

  const autoObs = [
    notesUser ? notesUser : "—",
    "",
    "• Validade sugerida: 7 dias.",
    "• Valores sujeitos a reajuste após esse período.",
  ]
    .filter(Boolean)
    .join("\n");

  doc.fillColor(TEXT).font("Helvetica").fontSize(9).text(autoObs, obsX + 10, bottomY + 28, {
    width: obsW - 20,
    height: bottomH - 38,
  });

  doc.roundedRect(valX, bottomY, valW, bottomH, 8).fillAndStroke("#ffffff", BORDER);
  drawBar(doc, valX, bottomY, valW, 20, "VALORES", BLUE);

 const grossTotalCents = Number(
  budget.grossTotalCents || budget.subtotalCents || budget.totalBeforeDiscountCents || 0
);

const cashTotalCents = Number(
  budget.cashTotalCents || budget.totalCents || Math.max(0, grossTotalCents - discountCents)
);

const installmentsCount = Math.max(2, Number(budget.installmentsCount || 2));

const installmentTotalCents = Number(
  budget.installmentTotalCents ||
    (budget.cardFeeCents ? grossTotalCents + Number(budget.cardFeeCents || 0) : budget.totalCents || 0)
);

let perInstallmentCents = Number(
  budget.installmentAmountCents || 0
);

if (perInstallmentCents <= 0) {
  if (Array.isArray(budget.installments) && budget.installments.length) {
    perInstallmentCents = Number(budget.installments[0].amountCents || 0);
  } else {
    perInstallmentCents = Math.round(installmentTotalCents / installmentsCount);
  }
}

const showRef12x = installmentsCount < 12;
const ref12xCents = showRef12x
  ? Math.round(installmentTotalCents / 12)
  : 0;

const valueRows = [
  { label: "Valor bruto", value: moneyBRL(grossTotalCents) },
  { label: "À vista", value: moneyBRL(cashTotalCents), strong: true },
  { label: "Parcelado total", value: moneyBRL(installmentTotalCents), strong: true },
  { label: "Parcelas", value: `${installmentsCount}x de ${moneyBRL(perInstallmentCents)}` },
  ...(showRef12x
    ? [{ label: "Referência em 12x", value: moneyBRL(ref12xCents) }]
    : []),
];

  const rowsTop = bottomY + 30;
  const rowsLeft = valX + 10;
  const rowsWidth = valW - 20;
  const rowHeight = 28;

  valueRows.forEach((row, idx) => {
    const yy = rowsTop + idx * rowHeight;

    if (idx > 0) {
      doc
        .strokeColor("#eef2f7")
        .lineWidth(0.8)
        .moveTo(rowsLeft, yy - 6)
        .lineTo(rowsLeft + rowsWidth, yy - 6)
        .stroke();
    }

    doc
      .fillColor(TEXT)
      .font("Helvetica")
      .fontSize(9)
      .text(`${row.label}:`, rowsLeft, yy, {
        width: rowsWidth * 0.54,
        align: "left",
      });

    doc
      .fillColor(TEXT)
      .font(row.strong ? "Helvetica-Bold" : "Helvetica-Bold")
      .fontSize(row.strong ? 10 : 9)
      .text(String(row.value || "—"), rowsLeft + rowsWidth * 0.46, yy, {
        width: rowsWidth * 0.54,
        align: "right",
      });
  });

  const footerY = pageBottom - 10;
  doc.fillColor(MUTED).font("Helvetica").fontSize(8);
  doc.text(`Gerado em ${fmtDate(new Date())} • Marcenaria SaaS`, x0, footerY, {
    width: w0,
    align: "center",
  });

  doc.end();
}

module.exports = { budgetPdf };