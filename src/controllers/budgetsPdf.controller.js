const PDFDocument = require("pdfkit");
const https = require("https");
const { prisma } = require("../lib/prisma");

function moneyBRL(cents) {
  const v = (cents || 0) / 100;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtDate(d) {
  if (!d) return "-";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleDateString("pt-BR");
}

// baixa imagem por URL (pra logoUrl)
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https
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

async function budgetPdf(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const budget = await prisma.budget.findFirst({
    where: { id, salonId },
    include: {
      salon: { select: { name: true, phone: true, address: true, logoUrl: true } },
      client: { select: { name: true, phone: true, instagram: true } },
      items: { orderBy: { createdAt: "asc" } },
      installments: { orderBy: { number: "asc" } },
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

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(res);

  // ===== Cabeçalho =====
  const salon = budget.salon;
  const client = budget.client;

  // Logo (se tiver)
  if (salon?.logoUrl && /^https?:\/\//i.test(salon.logoUrl)) {
    try {
      const buf = await fetchBuffer(salon.logoUrl);
      doc.image(buf, 40, 35, { fit: [90, 90] });
    } catch {
      // se falhar, só ignora
    }
  }

  doc.fontSize(18).text(salon?.name || "Marcenaria", 140, 40, { align: "left" });
  doc.fontSize(10).fillColor("#333");
  if (salon?.phone) doc.text(`Telefone: ${salon.phone}`, 140, 62);
  if (salon?.address) doc.text(`Endereço: ${salon.address}`, 140, 76);

  doc.moveTo(40, 130).lineTo(555, 130).strokeColor("#DDD").stroke();

  // ===== Bloco cliente + dados do orçamento =====
  doc.fillColor("#000").fontSize(12).text("Dados do Cliente", 40, 145);
  doc.fontSize(10).fillColor("#333");
  doc.text(`Nome: ${client?.name || "-"}`, 40, 165);
  doc.text(`Telefone: ${client?.phone || "-"}`, 40, 180);
  if (client?.instagram) doc.text(`Instagram: ${client.instagram}`, 40, 195);

  doc.fillColor("#000").fontSize(12).text("Orçamento", 340, 145);
  doc.fontSize(10).fillColor("#333");
  doc.text(`Status: ${budget.status}`, 340, 165);
  doc.text(`Criado em: ${fmtDate(budget.createdAt)}`, 340, 180);
  doc.text(`Previsão entrega: ${fmtDate(budget.expectedDeliveryAt)}`, 340, 195);

  // ===== Itens =====
  let y = 230;
  doc.fillColor("#000").fontSize(12).text("Itens", 40, y);
  y += 18;

  // Cabeçalho tabela
  doc.fillColor("#555").fontSize(9);
  doc.text("Descrição", 40, y);
  doc.text("Qtd", 320, y, { width: 40, align: "right" });
  doc.text("Unit.", 380, y, { width: 70, align: "right" });
  doc.text("Total", 460, y, { width: 95, align: "right" });
  y += 10;
  doc.moveTo(40, y).lineTo(555, y).strokeColor("#EEE").stroke();
  y += 10;

  doc.fillColor("#333").fontSize(10);
  for (const it of budget.items) {
    const desc = it.description ? `${it.name} — ${it.description}` : it.name;

    doc.text(desc, 40, y, { width: 260 });
    doc.text(String(it.quantity), 320, y, { width: 40, align: "right" });
    doc.text(moneyBRL(it.unitPriceCents), 380, y, { width: 70, align: "right" });
    doc.text(moneyBRL(it.totalCents), 460, y, { width: 95, align: "right" });

    y += 18;
    if (y > 680) {
      doc.addPage();
      y = 60;
    }
  }

  y += 10;
  doc.moveTo(40, y).lineTo(555, y).strokeColor("#EEE").stroke();
  y += 15;

  // ===== Totais =====
  doc.fillColor("#000").fontSize(10);
  doc.text(`Subtotal: ${moneyBRL(budget.subtotalCents)}`, 360, y, { width: 195, align: "right" });
  y += 14;
  doc.text(`Desconto: ${moneyBRL(budget.discountCents)}`, 360, y, { width: 195, align: "right" });
  y += 14;
  doc.fontSize(12).text(`Total: ${moneyBRL(budget.totalCents)}`, 360, y, { width: 195, align: "right" });
  y += 25;

  // ===== Pagamento =====
  doc.fillColor("#000").fontSize(12).text("Pagamento", 40, y);
  y += 16;
  doc.fillColor("#333").fontSize(10);

  doc.text(`Modo: ${budget.paymentMode}`, 40, y); y += 14;
  doc.text(`Método: ${budget.paymentMethod || "-"}`, 40, y); y += 14;
  doc.text(`Parcelas: ${budget.installmentsCount || 1}`, 40, y); y += 14;
  doc.text(`1º vencimento: ${fmtDate(budget.firstDueDate)}`, 40, y); y += 18;

  if (budget.paymentMode === "PARCELADO" && budget.installments.length) {
    doc.fillColor("#555").fontSize(9).text("Parcelas", 40, y);
    y += 14;
    doc.fillColor("#333").fontSize(10);

    for (const p of budget.installments) {
      doc.text(
        `${p.number}ª — ${fmtDate(p.dueDate)} — ${moneyBRL(p.amountCents)}`,
        40,
        y
      );
      y += 14;
      if (y > 720) {
        doc.addPage();
        y = 60;
      }
    }
  }

  // ===== Observações / validade =====
  y += 20;
  doc.fillColor("#000").fontSize(12).text("Observações", 40, y);
  y += 16;
  doc.fillColor("#333").fontSize(10).text(budget.notes || "-", 40, y, { width: 515 });

  y += 60;
  doc.fillColor("#777").fontSize(9).text(
    "Validade sugerida: 7 dias. Valores sujeitos a reajuste após esse período.",
    40,
    y,
    { width: 515 }
  );

  doc.end();
}

module.exports = { budgetPdf };
