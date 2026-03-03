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

// Se no front você estava “colando” o resumo interno no notes,
// aqui a gente corta tudo que vier depois do separador (—) / “MATERIAIS”
function clientNotes(raw) {
  if (!raw) return "";
  let s = String(raw);

  // corta no separador usado no resumo
  const sep = s.indexOf("\n—");
  if (sep !== -1) s = s.slice(0, sep);

  // corta em marcadores comuns do resumo
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
    .join(" • ");

  const out = [line1, line2].filter(Boolean).join("\n");
  return out || "-";
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
  doc.fillColor("#fff").fontSize(10).font("Helvetica-Bold").text(text, x, y + 4, {
    width: w,
    align: "center",
  });
  doc.restore();
}

function drawField(doc, x, y, w, label, value) {
  doc.save();

  // label
  doc.fillColor("#444").fontSize(7).font("Helvetica").text(label, x, y);

  // value box
  const boxY = y + 10;
  const boxH = 16;
  doc
    .lineWidth(0.7)
    .strokeColor("#cfcfcf")
    .fillColor("#f2f2f2")
    .rect(x, boxY, w, boxH)
    .fillAndStroke();

  doc
    .fillColor("#111")
    .fontSize(9)
    .font("Helvetica")
    .text(String(value ?? "-"), x + 6, boxY + 3, { width: w - 12 });

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
    },
  });

  if (!budget) return res.status(404).json({ message: "Orçamento não encontrado." });

  const download = String(req.query.download || "") === "1";
  const filename = `orcamento-${budget.id}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${filename}"`
  );

  const doc = new PDFDocument({ size: "A4", margin: 0 });
  doc.pipe(res);

  // ===== Tema / medidas =====
  const ORANGE = "#d85a2a";
  const BORDER = "#9f9f9f";

  const x0 = 40;
  const y0 = 30;
  const w0 = 515;
  const h0 = 780;
  const pageBottom = y0 + h0;

  // borda externa (igual “folha modelo”)
  doc.lineWidth(1).strokeColor(BORDER).rect(x0, y0, w0, h0).stroke();

  // ===== Cabeçalho =====
  const salon = budget.salon || {};
  const client = budget.client || {};

  const headerH = 95;
  const headerY = y0;

  // logo
  const logoX = x0 + 10;
  const logoY = headerY + 12;
  const logoSize = 55;

  if (salon.logoUrl && /^https?:\/\//i.test(salon.logoUrl)) {
    try {
      const buf = await fetchBuffer(salon.logoUrl);
      doc.image(buf, logoX, logoY, { fit: [logoSize, logoSize] });
    } catch {
      // ignora se falhar
    }
  }

  // título central
  doc
    .fillColor("#111")
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(String(salon.name || "MARCENARIA").toUpperCase(), x0 + 80, headerY + 12, {
      width: w0 - 170,
      align: "center",
    });

  // box número orçamento (top right)
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

  // campos no cabeçalho (abaixo do box)
  const hfY1 = headerY + 50;
  drawField(doc, x0 + 80, hfY1, 160, "Telefone", salon.phone || "-");
  drawField(doc, x0 + 80 + 170, hfY1, 120, "Data orçamento", fmtDate(budget.createdAt));
  drawField(doc, x0 + 80 + 170 + 130, hfY1, 135, "Previsão entrega", fmtDate(budget.expectedDeliveryAt));

  drawField(
    doc,
    x0 + 80,
    hfY1 + 30,
    w0 - 90,
    "Endereço",
    salon.address || "-"
  );

  // ===== CLIENTE =====
  const clientBarY = headerY + headerH + 12;
  drawBar(doc, x0, clientBarY, w0, 18, "CLIENTE", ORANGE);

  const cY = clientBarY + 26;
  // linha 1: nome / cpf / telefone
  const gap = 8;
  const wNome = 250;
  const wCpf = 120;
  const wTel = w0 - wNome - wCpf - gap * 2;

  drawField(doc, x0, cY, wNome, "Nome", client.name || "-");
  drawField(doc, x0 + wNome + gap, cY, wCpf, "CPF/CNPJ", client.cpf || "-");
  drawField(doc, x0 + wNome + gap + wCpf + gap, cY, wTel, "Telefone", client.phone || "-");

  // linha 2: endereço / email
  const cY2 = cY + 38;
  const wAddr = 360;
  const wEmail = w0 - wAddr - gap;

  drawField(doc, x0, cY2, wAddr, "Endereço", buildClientAddress(client));
  drawField(doc, x0 + wAddr + gap, cY2, wEmail, "E-mail", client.email || "-");

  // ===== ORÇAMENTO =====
  const budgetBarY = cY2 + 52;
  drawBar(doc, x0, budgetBarY, w0, 18, "ORÇAMENTO", ORANGE);

  // ===== Tabela itens =====
  const tableY = budgetBarY + 28;

  // Cabeçalho da tabela (cinza claro)
  doc
    .fillColor("#efefef")
    .rect(x0, tableY, w0, 20)
    .fill();
  doc.lineWidth(0.8).strokeColor("#d0d0d0").rect(x0, tableY, w0, 20).stroke();

  doc.fillColor("#111").font("Helvetica-Bold").fontSize(9);
  doc.text("N°", x0 + 6, tableY + 6, { width: 24 });
  doc.text("Descrição", x0 + 35, tableY + 6, { width: 250 });
  doc.text("Valor unitário", x0 + 295, tableY + 6, { width: 90, align: "right" });
  doc.text("Quantidade", x0 + 395, tableY + 6, { width: 70, align: "right" });
  doc.text("Total do item", x0 + 470, tableY + 6, { width: 85, align: "right" });

  let y = tableY + 26;
  doc.font("Helvetica").fontSize(9).fillColor("#111");

  const rowH = 18;

  // reserva espaço pro bloco “Observações + Valores”
  const reserveBottom = 170;
  const maxTableY = pageBottom - reserveBottom;

  const items = Array.isArray(budget.items) ? budget.items : [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];

    // se estourar a área, quebra página (simples)
    if (y + rowH > maxTableY) break;

    // linha
    doc.lineWidth(0.5).strokeColor("#e1e1e1").moveTo(x0, y + 14).lineTo(x0 + w0, y + 14).stroke();

    const desc = it.description ? `${it.name} — ${it.description}` : it.name;

    doc.fillColor("#111").font("Helvetica").fontSize(9);
    doc.text(String(i + 1), x0 + 6, y, { width: 24 });
    doc.text(clipText(desc, 55), x0 + 35, y, { width: 250 });
    doc.text(moneyBRL(it.unitPriceCents), x0 + 295, y, { width: 90, align: "right" });
    doc.text(String(it.quantity || 1), x0 + 395, y, { width: 70, align: "right" });
    doc.text(moneyBRL(it.totalCents), x0 + 470, y, { width: 85, align: "right" });

    y += rowH;
  }

  // ===== Observações + Valores (como seu modelo) =====
  const bottomY = Math.max(y + 12, maxTableY + 10);

  const obsW = 330;
  const valW = 175;
  const gap2 = 10;

  const obsX = x0;
  const valX = x0 + obsW + gap2;

  const bottomH = pageBottom - bottomY - 18;

  // OBSERVAÇÕES (caixa)
  doc.lineWidth(0.9).strokeColor(BORDER).rect(obsX, bottomY, obsW, bottomH).stroke();
  doc.fillColor("#111").font("Helvetica-Bold").fontSize(10).text("Observações:", obsX + 8, bottomY + 8);

  const notesUser = clientNotes(budget.notes);
  const discountCents = Number(budget.discountCents || 0);
  const baseTotal = Number(budget.subtotalCents || 0);
  const avistaTotal = Math.max(0, baseTotal - discountCents);

  const discountPct =
    baseTotal > 0 ? Math.round((discountCents / baseTotal) * 1000) / 10 : 0;

  const autoObs = [
    notesUser ? notesUser : "—",
    "",
    "• Validade sugerida: 7 dias.",
    "• Valores sujeitos a reajuste após esse período.",
    discountCents > 0
      ? `• À vista com desconto de ${budget.discountType === "PERCENT" && budget.discountPercent ? `${budget.discountPercent}%` : `${discountPct}%`}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  doc.fillColor("#222").font("Helvetica").fontSize(9).text(autoObs, obsX + 8, bottomY + 24, {
    width: obsW - 16,
    height: bottomH - 32,
  });

  // VALORES (caixa + barra)
  doc.lineWidth(0.9).strokeColor(BORDER).rect(valX, bottomY, valW, bottomH).stroke();
  drawBar(doc, valX, bottomY, valW, 18, "VALORES", ORANGE);

  // padrão “em até 12x”
  const maxX = 12;
  const per12 = Math.round(baseTotal / maxX);

  const lineY = bottomY + 28;
  doc.fillColor("#111").font("Helvetica").fontSize(9);

  // 1) Valor em até 12x (total sem desconto à vista)
  doc.text("Valor em até 12x:", valX + 8, lineY, { width: valW - 16 });
  doc.font("Helvetica-Bold").text(moneyBRL(baseTotal), valX + 8, lineY, { width: valW - 16, align: "right" });

  // 2) 12x
  doc.font("Helvetica").text("12x:", valX + 8, lineY + 16, { width: valW - 16 });
  doc.font("Helvetica-Bold").text(moneyBRL(per12), valX + 8, lineY + 16, { width: valW - 16, align: "right" });

  // 3) À vista
  const avistaLabel =
    discountCents > 0
      ? `À vista ${budget.discountType === "PERCENT" && budget.discountPercent ? `${budget.discountPercent}%` : `${discountPct}%`} Desc:`
      : "À vista:";

  doc.font("Helvetica").text(avistaLabel, valX + 8, lineY + 34, { width: valW - 16 });
  doc.font("Helvetica-Bold").text(moneyBRL(avistaTotal), valX + 8, lineY + 34, {
    width: valW - 16,
    align: "right",
  });

  doc.end();
}

module.exports = { budgetPdf };