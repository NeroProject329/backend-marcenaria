const PDFDocument = require("pdfkit");
const { prisma } = require("../lib/prisma");

const moneyBRL = (cents) =>
  (Number(cents || 0) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

const pad = (n) => String(n).padStart(2, "0");

function fmtBR(date) {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function clipText(s, max = 160) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t;
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
    cityUF || "",
    c?.cep ? `CEP ${onlyDigits(c.cep)}` : "",
  ]
    .filter(Boolean)
    .join(" - ");

  return [line1, line2].filter(Boolean).join(" - ") || "—";
}

function drawMiniHeader(doc, ctx) {
  const pageW = doc.page.width;
  const margin = doc.page.margins.left;

  doc.rect(0, 0, pageW, 46).fill("#0b1220");
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(`Orçamento • ${ctx.ref}`, margin, 14, { width: pageW - margin * 2 });

  doc
    .fillColor("#cbd5e1")
    .font("Helvetica")
    .fontSize(9)
    .text(`${ctx.clientName} • ${ctx.paymentLabel}`, margin, 30, {
      width: pageW - margin * 2,
    });

  return 60;
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

  return {
    x: x + 12,
    y: y + (title ? 32 : 12),
    w: w - 24,
    h: h - (title ? 44 : 24),
  };
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

    doc.fillColor("#0f172a").font("Helvetica").fontSize(10.5);
    textEllipsis(doc, r.label, x, yy, w - 190);

    doc
      .fillColor("#0f172a")
      .font(r.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(10.5);
    doc.text(String(r.value ?? "—"), x + (w - 180), yy, {
      width: 180,
      align: "right",
      lineBreak: false,
      ellipsis: true,
    });
  });

  return y + rows.length * rowH;
}

function drawTableHeader(doc, x, y, cols, colW) {
  doc.rect(x, y, colW.reduce((a, b) => a + b, 0), 22).fill("#f8fafc");
  doc
    .strokeColor("#e6eaf2")
    .lineWidth(1)
    .rect(x, y, colW.reduce((a, b) => a + b, 0), 22)
    .stroke();

  doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(10);

  let xx = x;
  cols.forEach((c, i) => {
    const w = colW[i];
    doc.text(c, xx + 8, y + 6, {
      width: w - 16,
      lineBreak: false,
      ellipsis: true,
    });
    xx += w;
  });

  return y + 22;
}

function drawTableRow(doc, x, y, cells, colW, rowH = 18, rightAlignIdx = []) {
  doc
    .strokeColor("#eef2f7")
    .lineWidth(1)
    .moveTo(x, y + rowH)
    .lineTo(x + colW.reduce((a, b) => a + b, 0), y + rowH)
    .stroke();

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

function payLabelSafe(budget) {
  const mode = String(budget?.paymentMode || "AVISTA");
  const method = budget?.paymentMethod ? ` • ${budget.paymentMethod}` : "";
  const inst =
    budget?.installmentsCount && Number(budget.installmentsCount) > 1
      ? ` • ${budget.installmentsCount}x`
      : "";
  return `${mode}${method}${inst}`;
}

async function budgetPdf(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const budget = await prisma.budget.findFirst({
    where: { id, salonId },
    include: {
      salon: {
        select: {
          name: true,
          phone: true,
          address: true,
          logoUrl: true,
        },
      },
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

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(res);

  const pageW = doc.page.width;
  const margin = doc.page.margins.left;
  const contentW = pageW - margin * 2;

  const salon = budget.salon || {};
  const client = budget.client || {};
  const ref = String(budget.id || "").slice(-6).toUpperCase();
  const paymentLabel = payLabelSafe(budget);
  const ctx = {
    ref,
    clientName: client?.name || "Cliente",
    paymentLabel,
  };

  const subtotalCents = Number(budget.subtotalCents || 0);
  const discountCents = Number(budget.discountCents || 0);
  const totalCents = Number(budget.totalCents || 0);
  const mode = String(budget.paymentMode || "AVISTA").toUpperCase();
  const installmentsCount = Math.max(1, Number(budget.installmentsCount || 1));
  const avistaTotal = Math.max(0, subtotalCents - discountCents) || totalCents;

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

  const notesUser = clientNotes(budget.notes);

  // Header principal
  doc.rect(0, 0, pageW, 92).fill("#0866ff");
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(20)
    .text("Orçamento", margin, 28, { width: pageW - margin * 2 });

  doc
    .fillColor("#dbeafe")
    .font("Helvetica")
    .fontSize(11)
    .text(`Cliente: ${client?.name || "—"} • Nº ${ref}`, margin, 58, {
      width: pageW - margin * 2,
    });

  doc.fillColor("#0f172a");
  let y = 110;

  // Cards
  y = drawCardsRow(doc, y, [
    {
      title: "Cliente",
      value: clipText(client?.name || "—", 34),
      foot: clipText(client?.phone || client?.email || "Sem contato", 34),
    },
    {
      title: "Data do orçamento",
      value: fmtBR(budget.createdAt),
      foot: `Entrega: ${fmtBR(budget.expectedDeliveryAt)}`,
    },
    {
      title: "Pagamento",
      value: clipText(paymentLabel || "—", 28),
      foot: `Status: ${String(budget.status || "RASCUNHO")}`,
    },
  ]);

  // Cliente + Empresa
  y = ensureSpace(doc, y, 165, ctx, false);

  const gapTop = 10;
  const halfW = (contentW - gapTop) / 2;

  const leftBox = sectionBox(doc, margin, y, halfW, 138, "Cliente");
  drawKeyValueRows(doc, leftBox.x, leftBox.y, leftBox.w, [
    { label: "Nome", value: client?.name || "—", bold: true },
    { label: "CPF/CNPJ", value: client?.cpf || "—" },
    { label: "Telefone", value: client?.phone || "—" },
    { label: "E-mail", value: client?.email || "—" },
    { label: "Endereço", value: clipText(buildClientAddress(client), 74) },
  ]);

  const rightBox = sectionBox(
    doc,
    margin + halfW + gapTop,
    y,
    halfW,
    138,
    "Empresa"
  );
  drawKeyValueRows(doc, rightBox.x, rightBox.y, rightBox.w, [
    { label: "Nome", value: salon?.name || "—", bold: true },
    { label: "Telefone", value: salon?.phone || "—" },
    { label: "Endereço", value: clipText(salon?.address || "—", 74) },
    { label: "Nº orçamento", value: ref },
    { label: "Previsão de entrega", value: fmtBR(budget.expectedDeliveryAt) },
  ]);

  y += 156;

  // Resumo financeiro
  y = ensureSpace(doc, y, 120, ctx, false);

  doc
    .fillColor("#0f172a")
    .font("Helvetica-Bold")
    .fontSize(14)
    .text("Resumo financeiro", margin, y);
  y += 16;

  y = drawCardsRow(doc, y, [
    { title: "Subtotal", value: moneyBRL(subtotalCents) },
    { title: "Desconto", value: moneyBRL(discountCents) },
    { title: "Total", value: moneyBRL(totalCents) },
  ]);

  // Itens
  const items = Array.isArray(budget.items) ? budget.items : [];

  y = ensureSpace(doc, y, 100, ctx, false);
  doc
    .fillColor("#0f172a")
    .font("Helvetica-Bold")
    .fontSize(14)
    .text("Itens do orçamento", margin, y);
  y += 12;

  const itemCols = ["#", "Descrição", "Valor unit.", "Qtd", "Total"];
  const itemW = [40, 255, 90, 55, 75];
  y = drawTableHeader(doc, margin, y, itemCols, itemW);

  if (!items.length) {
    y = drawTableRow(
      doc,
      margin,
      y,
      ["—", "Nenhum item cadastrado", moneyBRL(0), "0", moneyBRL(0)],
      itemW,
      18,
      [2, 3, 4]
    );
  } else {
    for (let i = 0; i < items.length; i++) {
      let nextY = ensureSpace(doc, y, 28, ctx, true);

      if (nextY === 60) {
        doc
          .fillColor("#0f172a")
          .font("Helvetica-Bold")
          .fontSize(14)
          .text("Itens do orçamento", margin, 74);
        nextY = drawTableHeader(doc, margin, 98, itemCols, itemW);
      }

      y = nextY;

      const it = items[i];
      const desc = it.description ? `${it.name} — ${it.description}` : it.name;

      y = drawTableRow(
        doc,
        margin,
        y,
        [
          String(i + 1),
          clipText(desc || "—", 78),
          moneyBRL(it.unitPriceCents),
          String(it.quantity || 1),
          moneyBRL(it.totalCents),
        ],
        itemW,
        18,
        [2, 3, 4]
      );
    }
  }

  y += 18;

  // Observações + Valores
  y = ensureSpace(doc, y, 210, ctx, false);

  const bottomGap = 10;
  const obsW = 320;
  const valW = contentW - obsW - bottomGap;

  const obsBox = sectionBox(doc, margin, y, obsW, 152, "Observações");
  const obsText = [
    notesUser || "—",
    "",
    "• Validade sugerida: 7 dias.",
    "• Valores sujeitos a reajuste após esse período.",
  ].join("\n");

  doc
    .fillColor("#0f172a")
    .font("Helvetica")
    .fontSize(10)
    .text(obsText, obsBox.x, obsBox.y, {
      width: obsBox.w,
      height: obsBox.h,
    });

  const valBox = sectionBox(
    doc,
    margin + obsW + bottomGap,
    y,
    valW,
    152,
    "Valores"
  );

  const valueRows =
    mode === "PARCELADO" && installmentsCount > 1
      ? [
          { label: "Valor total", value: moneyBRL(totalCents), bold: true },
          { label: "Nº de parcelas", value: `${installmentsCount}x` },
          {
            label: "Valor por parcela",
            value: moneyBRL(perInstallmentCents),
            bold: true,
          },
          { label: "Referência em 12x", value: moneyBRL(ref12xCents) },
          { label: "Forma de pagamento", value: budget.paymentMethod || "—" },
        ]
      : [
          { label: "À vista", value: moneyBRL(avistaTotal), bold: true },
          { label: "Referência em 12x", value: moneyBRL(ref12xCents) },
          { label: "Forma de pagamento", value: budget.paymentMethod || "—" },
          { label: "Status", value: String(budget.status || "RASCUNHO") },
        ];

  drawKeyValueRows(doc, valBox.x, valBox.y, valBox.w, valueRows);

  y += 170;

  // Footer
  const footerY = doc.page.height - doc.page.margins.bottom - 12;
  doc
    .fillColor("#94a3b8")
    .font("Helvetica")
    .fontSize(9)
    .text(`Gerado em ${fmtBR(new Date())} • Marcenaria SaaS`, margin, footerY, {
      width: pageW - margin * 2,
      align: "center",
    });

  doc.end();
}

module.exports = { budgetPdf };