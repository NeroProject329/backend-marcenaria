// controllers/budgetsPdf.controller.js
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
  doc.rect(x, y, w, h).fill(color);
  doc
    .fillColor("#fff")
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

  doc.fillColor("#444").fontSize(7).font("Helvetica").text(label, x, y);

  const boxY = y + 10;
  const boxH = 16;

  doc
    .lineWidth(0.7)
    .strokeColor("#cfcfcf")
    .fillColor("#f2f2f2")
    .rect(x, boxY, w, boxH)
    .fillAndStroke();

  doc.fillColor("#111").font("Helvetica").fontSize(valueFontSize);

  if (align === "center") {
    doc.text(String(value ?? "-"), x, boxY + 3, { width: w, align: "center" });
  } else if (align === "right") {
    doc.text(String(value ?? "-"), x, boxY + 3, { width: w - 6, align: "right" });
  } else {
    doc.text(String(value ?? "-"), x + 6, boxY + 3, { width: w - 12, align: "left" });
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

  const ORANGE = "#d85a2a";
  const BORDER = "#9f9f9f";

  const x0 = 40;
  const y0 = 30;
  const w0 = 515;
  const h0 = 780;
  const pageBottom = y0 + h0;

  doc.lineWidth(1).strokeColor(BORDER).rect(x0, y0, w0, h0).stroke();

  const salon = budget.salon || {};
  const client = budget.client || {};

  const headerH = 95;
  const headerY = y0;

  const logoX = x0 + 10;
  const logoY = headerY + 12;
  const logoSize = 55;

  if (salon.logoUrl && /^https?:\/\//i.test(salon.logoUrl)) {
    try {
      const buf = await fetchBuffer(salon.logoUrl);
      doc.image(buf, logoX, logoY, { fit: [logoSize, logoSize] });
    } catch {
      // ignora
    }
  }

  const ref = String(budget.id).slice(-4).toUpperCase();
  const boxW = 88;
  const boxH = 36;
  const boxX = x0 + w0 - boxW - 8;
  const boxY = headerY + 8;

  doc.lineWidth(0.9).strokeColor(BORDER).rect(boxX, boxY, boxW, boxH).stroke();
  doc
    .fillColor("#333")
    .font("Helvetica")
    .fontSize(7)
    .text("N° Orçamento", boxX, boxY + 6, { width: boxW, align: "center" });
  doc
    .fillColor("#111")
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(ref, boxX, boxY + 16, { width: boxW, align: "center" });

  const titleLeft = x0 + 80;
  const titleRight = boxX - 10;
  const titleW = Math.max(200, titleRight - titleLeft);

  doc
    .fillColor("#111")
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(String(salon.name || "MARCENARIA").toUpperCase(), titleLeft, headerY + 12, {
      width: titleW,
      align: "center",
    });

  const hfY1 = headerY + 50;
  const gap = 10;

  const rowX = titleLeft;
  const rowRight = x0 + w0 - 10;
  const rowW = rowRight - rowX;

  const wTel = 200;
  const wData = 140;
  const wPrev = rowW - wTel - wData - gap * 2;

  drawField(doc, rowX, hfY1, wTel, "Telefone", salon.phone || "-", { align: "center" });
  drawField(
    doc,
    rowX + wTel + gap,
    hfY1,
    wData,
    "Data orçamento",
    fmtDate(budget.createdAt),
    { align: "center" }
  );
  drawField(
    doc,
    rowX + wTel + gap + wData + gap,
    hfY1,
    wPrev,
    "Previsão entrega",
    fmtDate(budget.expectedDeliveryAt),
    { align: "center" }
  );

  drawField(doc, rowX, hfY1 + 30, rowW, "Endereço", salon.address || "-", {
    align: "center",
    valueFontSize: 8,
  });

  const clientBarY = headerY + headerH + 12;
  drawBar(doc, x0, clientBarY, w0, 18, "CLIENTE", ORANGE);

  const cY = clientBarY + 26;

  const wNome = 250;
  const wCpf = 120;
  const wTel2 = w0 - wNome - wCpf - gap * 2;

  drawField(doc, x0, cY, wNome, "Nome", client.name || "-", { align: "left" });
  drawField(doc, x0 + wNome + gap, cY, wCpf, "CPF/CNPJ", client.cpf || "-", {
    align: "center",
  });
  drawField(doc, x0 + wNome + gap + wCpf + gap, cY, wTel2, "Telefone", client.phone || "-", {
    align: "center",
  });

  const cY2 = cY + 38;
  const wAddr = 360;
  const wEmail = w0 - wAddr - gap;

  drawField(doc, x0, cY2, wAddr, "Endereço", clipText(buildClientAddress(client), 72), {
    align: "left",
    valueFontSize: 8,
  });

  drawField(doc, x0 + wAddr + gap, cY2, wEmail, "E-mail", clipText(client.email || "-", 34), {
    align: "center",
    valueFontSize: 8,
  });

  const budgetBarY = cY2 + 52;
  drawBar(doc, x0, budgetBarY, w0, 18, "ORÇAMENTO", ORANGE);

  const tableY = budgetBarY + 28;

  const cols = { n: 30, desc: 245, unit: 95, qty: 70, total: 75 };

  const xN = x0;
  const xDesc = xN + cols.n;
  const xUnit = xDesc + cols.desc;
  const xQty = xUnit + cols.unit;
  const xTotal = xQty + cols.qty;

  doc.fillColor("#efefef").rect(x0, tableY, w0, 20).fill();
  doc.lineWidth(0.8).strokeColor("#d0d0d0").rect(x0, tableY, w0, 20).stroke();

  doc.fillColor("#111").font("Helvetica-Bold").fontSize(9);
  doc.text("N°", xN + 6, tableY + 6, { width: cols.n - 8, align: "left" });
  doc.text("Descrição", xDesc + 6, tableY + 6, { width: cols.desc - 12, align: "left" });
  doc.text("Valor unitário", xUnit, tableY + 6, { width: cols.unit - 6, align: "right" });
  doc.text("Quantidade", xQty, tableY + 6, { width: cols.qty - 6, align: "right" });
  doc.text("Total do item", xTotal, tableY + 6, { width: cols.total - 6, align: "right" });

  let y = tableY + 26;
  const rowH = 18;

  const reserveBottom = 170;
  const maxTableY = pageBottom - reserveBottom;

  const items = Array.isArray(budget.items) ? budget.items : [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (y + rowH > maxTableY) break;

    doc
      .lineWidth(0.5)
      .strokeColor("#e1e1e1")
      .moveTo(x0, y + 14)
      .lineTo(x0 + w0, y + 14)
      .stroke();

    const desc = it.description ? `${it.name} — ${it.description}` : it.name;

    doc.fillColor("#111").font("Helvetica").fontSize(9);
    doc.text(String(i + 1), xN + 6, y, { width: cols.n - 8, align: "left" });
    doc.text(clipText(desc, 60), xDesc + 6, y, { width: cols.desc - 12, align: "left" });
    doc.text(moneyBRL(it.unitPriceCents), xUnit, y, { width: cols.unit - 6, align: "right" });
    doc.text(String(it.quantity || 1), xQty, y, { width: cols.qty - 6, align: "right" });
    doc.text(moneyBRL(it.totalCents), xTotal, y, { width: cols.total - 6, align: "right" });

    y += rowH;
  }

  const bottomY = Math.max(y + 12, maxTableY + 10);

  const obsW = 330;
  const valW = 175;
  const gap2 = 10;

  const obsX = x0;
  const valX = x0 + obsW + gap2;

  const bottomH = pageBottom - bottomY - 18;

  doc.lineWidth(0.9).strokeColor(BORDER).rect(obsX, bottomY, obsW, bottomH).stroke();
  doc.fillColor("#111").font("Helvetica-Bold").fontSize(10).text("Observações:", obsX + 8, bottomY + 8);

  const notesUser = clientNotes(budget.notes);

  const autoObs = [
    notesUser ? notesUser : "—",
    "",
    "• Validade sugerida: 7 dias.",
    "• Valores sujeitos a reajuste após esse período.",
  ]
    .filter(Boolean)
    .join("\n");

  doc.fillColor("#222").font("Helvetica").fontSize(9).text(autoObs, obsX + 8, bottomY + 24, {
    width: obsW - 16,
    height: bottomH - 32,
  });

  // ===== VALORES (ESTÁVEL + NOVAS REGRAS) =====
  doc.lineWidth(0.9).strokeColor(BORDER).rect(valX, bottomY, valW, bottomH).stroke();
  drawBar(doc, valX, bottomY, valW, 18, "VALORES", ORANGE);

  const mode = String(budget.paymentMode || "AVISTA").toUpperCase();
  const installmentsCount = Math.max(1, Number(budget.installmentsCount || 1));

  const baseTotal = Number(budget.subtotalCents || 0);
  const discountCents = Number(budget.discountCents || 0);
  const totalCents = Number(budget.totalCents || 0);

  const avistaTotal = Math.max(0, baseTotal - discountCents) || totalCents;

  let perInstallmentCents = 0;
  if (mode === "PARCELADO" && installmentsCount > 1) {
    if (Array.isArray(budget.installments) && budget.installments.length) {
      perInstallmentCents = Number(budget.installments[0].amountCents || 0);
    } else {
      perInstallmentCents = Math.round(totalCents / installmentsCount);
    }
  }

  const ref12xCents = Math.round(
    (mode === "PARCELADO" ? totalCents : avistaTotal) / 12
  );

  const lineY = bottomY + 30;
  const lineGap = 18;

  doc.fillColor("#111").font("Helvetica").fontSize(9);

  if (mode === "PARCELADO" && installmentsCount > 1) {
    doc.text("Valor total:", valX + 8, lineY, { width: valW - 16 });
    doc.font("Helvetica-Bold").text(moneyBRL(totalCents), valX + 8, lineY, {
      width: valW - 16,
      align: "right",
    });

    doc.font("Helvetica").text("Parcelas:", valX + 8, lineY + lineGap, {
      width: valW - 16,
    });
    doc.font("Helvetica-Bold").text(`${installmentsCount}x`, valX + 8, lineY + lineGap, {
      width: valW - 16,
      align: "right",
    });

    doc.font("Helvetica").text("Valor por parcela:", valX + 8, lineY + lineGap * 2, {
      width: valW - 16,
    });
    doc.font("Helvetica-Bold").text(moneyBRL(perInstallmentCents), valX + 8, lineY + lineGap * 2, {
      width: valW - 16,
      align: "right",
    });

    doc.font("Helvetica").text("Referência em 12x:", valX + 8, lineY + lineGap * 3, {
      width: valW - 16,
    });
    doc.font("Helvetica-Bold").text(moneyBRL(ref12xCents), valX + 8, lineY + lineGap * 3, {
      width: valW - 16,
      align: "right",
    });
  } else {
    doc.text("À vista:", valX + 8, lineY, { width: valW - 16 });
    doc.font("Helvetica-Bold").text(moneyBRL(avistaTotal), valX + 8, lineY, {
      width: valW - 16,
      align: "right",
    });

    doc.font("Helvetica").text("Referência em 12x:", valX + 8, lineY + lineGap, {
      width: valW - 16,
    });
    doc.font("Helvetica-Bold").text(moneyBRL(ref12xCents), valX + 8, lineY + lineGap, {
      width: valW - 16,
      align: "right",
    });
  }

  doc.end();
}

module.exports = { budgetPdf };