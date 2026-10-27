const PDFDocument = require("pdfkit");
const { prisma } = require("../lib/prisma");

const COLORS = {
  ink: "#24324A",
  brand: "#FFD23F",
  coral: "#FF7043",
  sky: "#54C7EC",
  paper: "#FFFDF7",
  muted: "#69758A",
  line: "#D9DDE5",
  success: "#16A34A",
};

function money(cents) {
  return ((Number(cents) || 0) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function dateBR(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("pt-BR");
}

function paymentLabel(order) {
  const method = String(order.paymentMethod || "").replaceAll("_", " ");
  if (order.paymentMode === "PARCELADO") {
    return `${order.installmentsCount || 1}x • ${method || "Não informado"}`;
  }
  return `À vista • ${method || "Não informado"}`;
}

async function orderReceiptPdf(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const order = await prisma.order.findFirst({
    where: { id, salonId },
    include: {
      salon: { select: { name: true, address: true, phone: true } },
      client: {
        select: {
          name: true,
          cpf: true,
          email: true,
          phone: true,
          logradouro: true,
          numero: true,
          bairro: true,
          cidade: true,
          estado: true,
        },
      },
      items: { orderBy: { createdAt: "asc" } },
      receivables: { include: { installments: { orderBy: { number: "asc" } } } },
    },
  });

  if (!order) return res.status(404).json({ message: "Pedido não encontrado." });

  const download = String(req.query.download || "") === "1";
  const ref = String(order.id).slice(-6).toUpperCase();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="comprovante-pedido-${ref}.pdf"`
  );

  const doc = new PDFDocument({ size: "A4", margin: 0 });
  doc.pipe(res);

  const pageW = doc.page.width;
  const margin = 40;
  const contentW = pageW - margin * 2;

  doc.rect(0, 0, pageW, doc.page.height).fill(COLORS.paper);
  doc.rect(0, 0, pageW, 22).fill(COLORS.brand);
  doc.roundedRect(margin, 44, contentW, 92, 20).fill(COLORS.ink);
  doc.roundedRect(margin + contentW - 116, 61, 96, 54, 14).fill(COLORS.brand);

  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(22)
    .text(order.salon?.name || "Gestão Marcenaria", margin + 22, 65, { width: contentW - 170 });
  doc.fillColor("#DDE7F5").font("Helvetica").fontSize(10)
    .text("COMPROVANTE DO PEDIDO", margin + 22, 98);
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(15)
    .text(`#${ref}`, margin + contentW - 116, 78, { width: 96, align: "center" });

  let y = 156;
  const card = (x, width, label, value, fill = "#FFFFFF") => {
    doc.roundedRect(x, y, width, 58, 14).fillAndStroke(fill, COLORS.line);
    doc.fillColor(COLORS.muted).font("Helvetica-Bold").fontSize(8).text(label, x + 12, y + 11);
    doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(11).text(String(value || "—"), x + 12, y + 29, {
      width: width - 24,
      ellipsis: true,
    });
  };

  card(margin, 158, "CLIENTE", order.client?.name);
  card(margin + 170, 158, "DATA DO PEDIDO", dateBR(order.createdAt));
  card(margin + 340, contentW - 340, "ENTREGA PREVISTA", dateBR(order.expectedDeliveryAt), "#FFF4C7");
  y += 78;

  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(13).text("Itens do pedido", margin, y);
  y += 24;
  doc.roundedRect(margin, y, contentW, 28, 10).fill(COLORS.ink);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9);
  doc.text("Descrição", margin + 12, y + 9, { width: 260 });
  doc.text("Qtd.", margin + 296, y + 9, { width: 52, align: "right" });
  doc.text("Unitário", margin + 358, y + 9, { width: 68, align: "right" });
  doc.text("Total", margin + 436, y + 9, { width: contentW - 448, align: "right" });
  y += 34;

  order.items.slice(0, 12).forEach((item, index) => {
    const fill = index % 2 === 0 ? "#FFFFFF" : "#FFF9E7";
    doc.roundedRect(margin, y, contentW, 30, 8).fill(fill);
    doc.fillColor(COLORS.ink).font("Helvetica").fontSize(9);
    doc.text(item.name, margin + 12, y + 10, { width: 260, ellipsis: true });
    doc.text(String(item.quantity), margin + 296, y + 10, { width: 52, align: "right" });
    doc.text(money(item.unitPriceCents), margin + 358, y + 10, { width: 68, align: "right" });
    doc.font("Helvetica-Bold").text(money(item.totalCents), margin + 436, y + 10, {
      width: contentW - 448,
      align: "right",
    });
    y += 32;
  });

  y += 14;
  const summaryY = y;
  doc.roundedRect(margin, summaryY, contentW, 126, 18).fillAndStroke("#FFFFFF", COLORS.line);
  doc.roundedRect(margin, summaryY, 184, 126, 18).fill(COLORS.coral);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(11).text("PAGAMENTO", margin + 16, summaryY + 18);
  doc.fontSize(15).text(paymentLabel(order), margin + 16, summaryY + 43, { width: 150 });
  doc.font("Helvetica").fontSize(9).text(`Status: ${order.status}`, margin + 16, summaryY + 86, { width: 150 });

  const valueX = margin + 210;
  const valueW = contentW - 228;
  const rows = [
    ["Subtotal", money(order.subtotalCents)],
    ["Desconto", `- ${money(order.discountCents)}`],
    ["TOTAL", money(order.totalCents)],
  ];
  rows.forEach(([label, value], index) => {
    const rowY = summaryY + 16 + index * 34;
    doc.fillColor(index === 2 ? COLORS.ink : COLORS.muted)
      .font(index === 2 ? "Helvetica-Bold" : "Helvetica")
      .fontSize(index === 2 ? 12 : 10)
      .text(label, valueX, rowY, { width: 110 });
    doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(index === 2 ? 16 : 11)
      .text(value, valueX + 110, rowY, { width: valueW - 110, align: "right" });
  });

  y = summaryY + 148;
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8)
    .text(
      `${order.salon?.phone || ""}${order.salon?.address ? ` • ${order.salon.address}` : ""}` || "Gestão Marcenaria",
      margin,
      y,
      { width: contentW, align: "center" }
    );
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(9)
    .text(`Gerado em ${dateBR(new Date())} • Documento referente ao pedido #${ref}`, margin, y + 16, {
      width: contentW,
      align: "center",
    });

  doc.end();
}

module.exports = { orderReceiptPdf };
