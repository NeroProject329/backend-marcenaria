const PDFDocument = require("pdfkit");
const http = require("http");
const https = require("https");
const { prisma } = require("../lib/prisma");

const HEADER_START_Y = 74;
const IMAGE_TIMEOUT_MS = 1500;

function moneyBRL(cents) {
  return (Number(cents || 0) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function clipText(s, max = 160) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t;
}

function textEllipsis(doc, text, x, y, w, opts = {}) {
  doc.text(String(text ?? ""), x, y, {
    width: w,
    lineBreak: false,
    ellipsis: true,
    ...opts,
  });
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

function fetchBuffer(url, timeoutMs = IMAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    try {
      const lib = /^https:/i.test(url) ? https : http;

      const req = lib.get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 PDFKit",
            Accept: "*/*",
          },
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            clearTimeout(timer);
            return resolve(fetchBuffer(res.headers.location, timeoutMs));
          }

          if (res.statusCode !== 200) {
            res.resume();
            clearTimeout(timer);
            return reject(new Error(`HTTP ${res.statusCode}`));
          }

          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            clearTimeout(timer);
            resolve(Buffer.concat(chunks));
          });
        }
      );

      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      const timer = setTimeout(() => {
        req.destroy(new Error("Image fetch timeout"));
      }, timeoutMs);
    } catch (err) {
      reject(err);
    }
  });
}

async function tryDrawLogo(doc, url, x, y, opts = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const buf = await fetchBuffer(url, IMAGE_TIMEOUT_MS);
    doc.image(buf, x, y, opts);
    return true;
  } catch {
    return false;
  }
}

function drawHeader(doc, budget) {
  const pageW = doc.page.width;
  const margin = doc.page.margins.left;
  const salon = budget.salon || {};

  doc.rect(0, 0, pageW, 58).fill("#0b1220");

  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(15)
    .text("Orçamento", margin, 14, {
      width: pageW - margin * 2,
    });

  doc
    .fillColor("#cbd5e1")
    .font("Helvetica")
    .fontSize(9)
    .text(
      `${String(salon.name || "Marcenaria")} • Nº ${String(budget.id || "")
        .slice(-6)
        .toUpperCase()}`,
      margin,
      34,
      {
        width: pageW - margin * 2,
      }
    );

  return HEADER_START_Y;
}

function ensureSpace(doc, y, needed, budget) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (y + needed <= bottom) return y;
  doc.addPage();
  return drawHeader(doc, budget);
}

function sectionBox(doc, x, y, w, h, title) {
  doc.roundedRect(x, y, w, h, 12).fillAndStroke("#ffffff", "#e6eaf2");

  if (title) {
    doc
      .fillColor("#0f172a")
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(title, x + 12, y + 10, {
        width: w - 24,
      });
  }

  return {
    x: x + 12,
    y: y + (title ? 34 : 12),
    w: w - 24,
    h: h - (title ? 46 : 24),
  };
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
      textEllipsis(doc, c.foot, x + 12, y + 49, w - 24);
    }
  });

  return y + h + 18;
}

function drawKeyValueRows(doc, x, y, w, rows) {
  const rowH = 17;

  rows.forEach((r, idx) => {
    const yy = y + idx * rowH;

    doc.fillColor("#0f172a").font("Helvetica").fontSize(10.5);
    textEllipsis(doc, r.label, x, yy, w - 180);

    doc
      .fillColor("#0f172a")
      .font(r.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(10.5);
    doc.text(String(r.value ?? "—"), x + (w - 170), yy, {
      width: 170,
      align: "right",
      lineBreak: false,
      ellipsis: true,
    });
  });

  return y + rows.length * rowH;
}

function drawTableHeader(doc, x, y, cols, colW) {
  const totalW = colW.reduce((a, b) => a + b, 0);

  doc.rect(x, y, totalW, 22).fill("#f8fafc");
  doc.strokeColor("#e6eaf2").lineWidth(1).rect(x, y, totalW, 22).stroke();

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
  const totalW = colW.reduce((a, b) => a + b, 0);

  doc
    .strokeColor("#eef2f7")
    .lineWidth(1)
    .moveTo(x, y + rowH)
    .lineTo(x + totalW, y + rowH)
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

  let y = drawHeader(doc, budget);

  const salon = budget.salon || {};
  const client = budget.client || {};
  const notesUser = clientNotes(budget.notes);

  await tryDrawLogo(doc, salon.logoUrl, pageW - margin - 46, 10, {
    fit: [34, 34],
    align: "right",
  });

  y = drawCardsRow(doc, y, [
    {
      title: "Cliente",
      value: clipText(client.name || "—", 34),
      foot: clipText(client.phone || client.email || "Sem contato", 32),
    },
    {
      title: "Data do orçamento",
      value: fmtDate(budget.createdAt),
      foot: `Entrega: ${fmtDate(budget.expectedDeliveryAt)}`,
    },
    {
      title: "Status",
      value: String(budget.status || "RASCUNHO"),
      foot: payLabelSafe(budget),
    },
  ]);

  y = ensureSpace(doc, y, 168, budget);

  const topGap = 10;
  const halfW = (contentW - topGap) / 2;

  const leftBox = sectionBox(doc, margin, y, halfW, 138, "Cliente");
  drawKeyValueRows(doc, leftBox.x, leftBox.y, leftBox.w, [
    { label: "Nome", value: client.name || "—", bold: true },
    { label: "CPF/CNPJ", value: client.cpf || "—" },
    { label: "Telefone", value: client.phone || "—" },
    { label: "E-mail", value: client.email || "—" },
    { label: "Endereço", value: clipText(buildClientAddress(client), 72) },
  ]);

  const rightBox = sectionBox(
    doc,
    margin + halfW + topGap,
    y,
    halfW,
    138,
    "Empresa"
  );
  drawKeyValueRows(doc, rightBox.x, rightBox.y, rightBox.w, [
    { label: "Nome", value: salon.name || "—", bold: true },
    { label: "Telefone", value: salon.phone || "—" },
    { label: "Endereço", value: clipText(salon.address || "—", 72) },
    {
      label: "Nº orçamento",
      value: String(budget.id || "").slice(-6).toUpperCase(),
    },
    { label: "Previsão de entrega", value: fmtDate(budget.expectedDeliveryAt) },
  ]);

  y += 156;

  const items = Array.isArray(budget.items) ? budget.items : [];

  y = ensureSpace(doc, y, 120, budget);
  doc
    .fillColor("#0f172a")
    .font("Helvetica-Bold")
    .fontSize(14)
    .text("Itens do orçamento", margin, y);
  y += 12;

  const tableCols = ["#", "Descrição", "Valor unit.", "Qtd", "Total"];
  const tableW = [40, 255, 90, 55, 75];
  y = drawTableHeader(doc, margin, y, tableCols, tableW);

  if (!items.length) {
    y = drawTableRow(
      doc,
      margin,
      y,
      ["—", "Nenhum item cadastrado", moneyBRL(0), "0", moneyBRL(0)],
      tableW,
      18,
      [2, 3, 4]
    );
  } else {
    for (let i = 0; i < items.length; i++) {
      const nextY = ensureSpace(doc, y, 28, budget);

      if (nextY !== y) {
        y = nextY;
        doc
          .fillColor("#0f172a")
          .font("Helvetica-Bold")
          .fontSize(14)
          .text("Itens do orçamento", margin, y);
        y += 12;
        y = drawTableHeader(doc, margin, y, tableCols, tableW);
      } else {
        y = nextY;
      }

      const it = items[i];
      const desc = it.description ? `${it.name} — ${it.description}` : it.name;

      y = drawTableRow(
        doc,
        margin,
        y,
        [
          String(i + 1),
          clipText(desc || "—", 80),
          moneyBRL(it.unitPriceCents),
          String(it.quantity || 1),
          moneyBRL(it.totalCents),
        ],
        tableW,
        18,
        [2, 3, 4]
      );
    }
  }

  y += 16;

  y = ensureSpace(doc, y, 210, budget);

  const gapBottom = 10;
  const obsW = 320;
  const valW = contentW - obsW - gapBottom;

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
    margin + obsW + gapBottom,
    y,
    valW,
    152,
    "Valores"
  );

  const mode = String(budget.paymentMode || "AVISTA").toUpperCase();
  const installmentsCount = Math.max(1, Number(budget.installmentsCount || 1));
  const baseTotal = Number(budget.subtotalCents || 0);
  const totalCents = Number(budget.totalCents || 0);
  const discountCents = Number(budget.discountCents || 0);
  const avistaTotal = Math.max(0, baseTotal - discountCents) || totalCents;

  let parcelValue = 0;
  if (mode === "PARCELADO" && installmentsCount > 1) {
    if (Array.isArray(budget.installments) && budget.installments.length) {
      parcelValue = Number(budget.installments[0].amountCents || 0);
    } else {
      parcelValue = Math.round(totalCents / installmentsCount);
    }
  }

  const ref12x = Math.round(
    (mode === "PARCELADO" ? totalCents : avistaTotal) / 12
  );

  const valueRows =
    mode === "PARCELADO" && installmentsCount > 1
      ? [
          { label: "Valor total", value: moneyBRL(totalCents), bold: true },
          { label: "Nº de parcelas", value: `${installmentsCount}x` },
          {
            label: "Valor por parcela",
            value: moneyBRL(parcelValue),
            bold: true,
          },
          { label: "Referência em 12x", value: moneyBRL(ref12x) },
        ]
      : [
          { label: "À vista", value: moneyBRL(avistaTotal), bold: true },
          { label: "Referência em 12x", value: moneyBRL(ref12x) },
          { label: "Forma de pagamento", value: budget.paymentMethod || "—" },
        ];

  drawKeyValueRows(doc, valBox.x, valBox.y, valBox.w, valueRows);

  y += 170;

  y = ensureSpace(doc, y, 70, budget);
  doc
    .strokeColor("#e6eaf2")
    .lineWidth(1)
    .moveTo(margin, y)
    .lineTo(pageW - margin, y)
    .stroke();

  y += 10;

  doc.fillColor("#64748b").font("Helvetica").fontSize(9);
  doc.text(
    "Documento gerado automaticamente pelo sistema. Este orçamento pode sofrer ajustes conforme materiais, prazo e condições comerciais.",
    margin,
    y,
    {
      width: contentW,
      align: "left",
    }
  );

  doc.end();
}

module.exports = { budgetPdf };