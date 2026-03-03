const { prisma } = require("../lib/prisma");

function cleanPhone(v) {
  return String(v || "").replace(/\D/g, "");
}

function cleanText(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function cleanCPF(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d ? d : null;
}

function cleanEmail(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s ? s : null;
}

function cleanCEP(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d ? d : null;
}

const VALID_CLIENT_TYPES = new Set(["CLIENTE", "FORNECEDOR", "BOTH"]);

function normalizeClientType(v) {
  if (v === undefined || v === null || v === "") return undefined; // não mexe (usa default do Prisma)
  const t = String(v).trim().toUpperCase();
  return VALID_CLIENT_TYPES.has(t) ? t : null;
}

async function listClients(req, res) {
  const { salonId } = req.user;
  const q = (req.query.q || "").trim();

  // opcional: filtro por tipo
  const typeParam = normalizeClientType(req.query.type);
  if (typeParam === null) {
    return res
      .status(400)
      .json({ message: "Tipo inválido. Use CLIENTE, FORNECEDOR ou BOTH." });
  }

  const where = { salonId };

  if (typeParam) where.type = typeParam;

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { phone: { contains: cleanPhone(q) } },
      { instagram: { contains: q, mode: "insensitive" } },
      { cpf: { contains: cleanCPF(q) || q } },
      { email: { contains: q.toLowerCase(), mode: "insensitive" } },
    ];
  }

  const clients = await prisma.client.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      phone: true,
      cpf: true,
      email: true,

      instagram: true,
      notes: true,
      type: true,

      cep: true,
      logradouro: true,
      numero: true,
      complemento: true,
      bairro: true,
      cidade: true,
      estado: true,

      createdAt: true,
    },
  });

  return res.json({ clients });
}

async function createClient(req, res) {
  const { salonId } = req.user;
  const {
    name,
    phone,
    instagram,
    notes,
    type,
    cpf,
    email,
    cep,
    logradouro,
    numero,
    complemento,
    bairro,
    cidade,
    estado,
  } = req.body;

  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ message: "Nome do cliente é obrigatório." });
  }

  const phoneClean = cleanPhone(phone);
  if (!phoneClean || phoneClean.length < 8) {
    return res.status(400).json({ message: "Telefone inválido." });
  }

  const typeNorm = normalizeClientType(type);
  if (typeNorm === null) {
    return res
      .status(400)
      .json({ message: "Tipo inválido. Use CLIENTE, FORNECEDOR ou BOTH." });
  }

  // opcional: evita duplicado por telefone no mesmo salão
  const exists = await prisma.client.findFirst({
    where: { salonId, phone: phoneClean },
    select: { id: true },
  });
  if (exists) {
    return res.status(409).json({ message: "Já existe um cliente com esse telefone." });
  }

  const client = await prisma.client.create({
    data: {
      name: String(name).trim(),
      phone: phoneClean,
      instagram: instagram ? String(instagram).trim() : null,
      cpf: cleanCPF(cpf),
      email: cleanEmail(email),
      cep: cleanCEP(cep),
      logradouro: cleanText(logradouro),
      numero: cleanText(numero),
      complemento: cleanText(complemento),
      bairro: cleanText(bairro),
      cidade: cleanText(cidade),
      estado: cleanText(estado),

      notes: notes ? String(notes).trim() : null,
      salonId,

      ...(typeNorm ? { type: typeNorm } : {}), // ✅ se não vier, Prisma usa default CLIENTE
    },
    select: {
      id: true,
      name: true,
      phone: true,
      instagram: true,
      notes: true,
      type: true,
      createdAt: true,
    },
  });

  return res.status(201).json({ client });
}

async function updateClient(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.client.findFirst({
    where: { id, salonId },
    select: { id: true },
  });
  if (!exists) return res.status(404).json({ message: "Cliente não encontrado." });

  const {
    name,
    phone,
    instagram,
    notes,
    type,
    cpf,
    email,
    cep,
    logradouro,
    numero,
    complemento,
    bairro,
    cidade,
    estado,
  } = req.body;

  const data = {};

  if (name !== undefined) {
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ message: "Nome inválido." });
    }
    data.name = String(name).trim();
  }

  if (phone !== undefined) {
    const phoneClean = cleanPhone(phone);
    if (!phoneClean || phoneClean.length < 8) {
      return res.status(400).json({ message: "Telefone inválido." });
    }

    // opcional: evita duplicado por telefone no mesmo salão
    const dup = await prisma.client.findFirst({
      where: { salonId, phone: phoneClean, NOT: { id } },
      select: { id: true },
    });
    if (dup) return res.status(409).json({ message: "Já existe um cliente com esse telefone." });

    data.phone = phoneClean;
  }

  if (instagram !== undefined) data.instagram = instagram ? String(instagram).trim() : null;
  if (notes !== undefined) data.notes = notes ? String(notes).trim() : null;

  if (cpf !== undefined) data.cpf = cleanCPF(cpf);
  if (email !== undefined) data.email = cleanEmail(email);

  if (cep !== undefined) data.cep = cleanCEP(cep);
  if (logradouro !== undefined) data.logradouro = cleanText(logradouro);
  if (numero !== undefined) data.numero = cleanText(numero);
  if (complemento !== undefined) data.complemento = cleanText(complemento);
  if (bairro !== undefined) data.bairro = cleanText(bairro);
  if (cidade !== undefined) data.cidade = cleanText(cidade);
  if (estado !== undefined) data.estado = cleanText(estado);

  if (type !== undefined) {
    const typeNorm = normalizeClientType(type);
    if (typeNorm === null) {
      return res
        .status(400)
        .json({ message: "Tipo inválido. Use CLIENTE, FORNECEDOR ou BOTH." });
    }
    if (typeNorm) data.type = typeNorm;
  }

  const client = await prisma.client.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      phone: true,
      instagram: true,
      notes: true,
      type: true,
      createdAt: true,
    },
  });

  return res.json({ client });
}

async function deleteClient(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.client.findFirst({
    where: { id, salonId },
    select: { id: true },
  });
  if (!exists) return res.status(404).json({ message: "Cliente não encontrado." });

  // Regra: não permitir deletar se tiver agendamentos
  const apCount = await prisma.appointment.count({
    where: { salonId, clientId: id },
  });
  if (apCount > 0) {
    return res.status(409).json({
      message: "Não é possível excluir: cliente possui agendamentos.",
    });
  }

  await prisma.client.delete({ where: { id } });
  return res.json({ ok: true });
}

async function listClientsWithMetrics(req, res) {
  const { salonId } = req.user;

  const clients = await prisma.client.findMany({
    where: { salonId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      phone: true,
      type: true,
      createdAt: true,
      appointments: {
        select: {
          status: true,
          startAt: true,
          service: { select: { price: true } },
        },
      },
    },
  });

  const result = clients.map((client) => {
    const finalized = client.appointments.filter((a) => a.status === "FINALIZADO");
    const canceled = client.appointments.filter((a) => a.status === "CANCELADO");

    const totalSpent = finalized.reduce((sum, a) => sum + (a.service?.price || 0), 0);

    const lastVisit =
      finalized.length > 0
        ? finalized.reduce((latest, a) => (a.startAt > latest ? a.startAt : latest), finalized[0].startAt)
        : null;

    const monthsActive = finalized.length
      ? Math.max(1, Math.ceil((Date.now() - new Date(finalized[0].startAt)) / (1000 * 60 * 60 * 24 * 30)))
      : 1;

    const frequency = finalized.length ? Number((finalized.length / monthsActive).toFixed(1)) : 0;

    return {
      id: client.id,
      name: client.name,
      phone: client.phone,
      type: client.type,
      totalSpent,
      visits: finalized.length,
      lastVisit,
      canceled: canceled.length,
      frequency,
    };
  });

  return res.json({ clients: result });
}

// GET /api/clients/:id/orders (mantido - não quebra nada)
async function listClientOrders(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const client = await prisma.client.findFirst({
    where: { id, salonId },
    select: { id: true, name: true, type: true },
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado." });

  const orders = await prisma.order.findMany({
    where: { salonId, clientId: id },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      status: true,
      totalCents: true,
      createdAt: true,
      expectedDeliveryAt: true,
      paymentMode: true,
      paymentMethod: true,
      installmentsCount: true,
      items: {
        select: {
          id: true,
          name: true,
          quantity: true,
          unitPriceCents: true,
          totalCents: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return res.json({ client, orders });
}

// ✅ NOVO: GET /api/clients/:id/history
// Retorna: pedidos + orçamentos + timeline (observações)
async function getClientHistory(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  // valida cliente do salão
  const client = await prisma.client.findFirst({
    where: { id, salonId },
    select: {
      id: true,
      name: true,
      phone: true,
      type: true,
      notes: true,
      createdAt: true,
    },
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado." });

  // pedidos
  const orders = await prisma.order.findMany({
    where: { salonId, clientId: id },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      status: true,
      totalCents: true,
      createdAt: true,
      updatedAt: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      paymentMode: true,
      paymentMethod: true,
      installmentsCount: true,
      notes: true,
      items: {
        select: {
          id: true,
          name: true,
          quantity: true,
          unitPriceCents: true,
          totalCents: true,
        },
        orderBy: { createdAt: "asc" },
      },
      deliveries: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          expectedAt: true,
          deliveredAt: true,
          address: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  // orçamentos (budgets)
  const budgets = await prisma.budget.findMany({
    where: { salonId, clientId: id },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      status: true,
      totalCents: true,
      createdAt: true,
      updatedAt: true,
      expectedDeliveryAt: true,
      paymentMode: true,
      paymentMethod: true,
      installmentsCount: true,
      firstDueDate: true,
      notes: true,
      approvedAt: true,
      approvedOrderId: true,
      items: {
        select: {
          id: true,
          name: true,
          quantity: true,
          unitPriceCents: true,
          totalCents: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  // timeline (observações) — sem criar tabela nova
  const timeline = [];

  function pushEvent(ev) {
    if (!ev || !ev.at) return;
    timeline.push({
      kind: ev.kind || "EVENT",
      at: ev.at,
      title: ev.title || "",
      text: ev.text || null,
      meta: ev.meta || null,
    });
  }

  // Observação do cliente (notes do cadastro)
  if (client.notes) {
    pushEvent({
      kind: "CLIENT_NOTE",
      at: client.createdAt,
      title: "Observação do cliente",
      text: client.notes,
      meta: { clientId: client.id },
    });
  }

  for (const b of budgets) {
    pushEvent({
      kind: "BUDGET_CREATED",
      at: b.createdAt,
      title: `Orçamento criado (${b.status})`,
      text: b.notes || null,
      meta: { budgetId: b.id, status: b.status, totalCents: b.totalCents },
    });

    // se teve update real
    if (b.updatedAt && b.updatedAt.getTime() > b.createdAt.getTime() + 1000) {
      pushEvent({
        kind: "BUDGET_UPDATED",
        at: b.updatedAt,
        title: `Orçamento atualizado (${b.status})`,
        text: b.notes || null,
        meta: { budgetId: b.id, status: b.status },
      });
    }

    if (b.status === "APROVADO" && b.approvedAt) {
      pushEvent({
        kind: "BUDGET_APPROVED",
        at: b.approvedAt,
        title: "Orçamento aprovado",
        text: b.approvedOrderId ? `Virou o pedido: ${b.approvedOrderId}` : null,
        meta: { budgetId: b.id, approvedOrderId: b.approvedOrderId || null },
      });
    }
  }

  for (const o of orders) {
    pushEvent({
      kind: "ORDER_CREATED",
      at: o.createdAt,
      title: `Pedido criado (${o.status})`,
      text: o.notes || null,
      meta: { orderId: o.id, status: o.status, totalCents: o.totalCents },
    });

    // se teve update real
    if (o.updatedAt && o.updatedAt.getTime() > o.createdAt.getTime() + 1000) {
      pushEvent({
        kind: "ORDER_UPDATED",
        at: o.updatedAt,
        title: `Pedido atualizado (${o.status})`,
        text: o.notes || null,
        meta: { orderId: o.id, status: o.status },
      });
    }

    if (o.deliveredAt) {
      pushEvent({
        kind: "ORDER_DELIVERED",
        at: o.deliveredAt,
        title: "Pedido entregue",
        text: null,
        meta: { orderId: o.id },
      });
    }

    // entregas (se tiver notas/endereços/status)
    const dels = Array.isArray(o.deliveries) ? o.deliveries : [];
    for (const d of dels) {
      const txtParts = [];
      if (d.address) txtParts.push(`Endereço: ${d.address}`);
      if (d.notes) txtParts.push(d.notes);
      const txt = txtParts.length ? txtParts.join(" • ") : null;

      pushEvent({
        kind: "DELIVERY_EVENT",
        at: d.updatedAt || d.createdAt,
        title: `Entrega (${d.status})`,
        text: txt,
        meta: { orderId: o.id, deliveryId: d.id, status: d.status },
      });

      if (d.deliveredAt) {
        pushEvent({
          kind: "DELIVERY_DELIVERED",
          at: d.deliveredAt,
          title: "Entrega concluída",
          text: null,
          meta: { orderId: o.id, deliveryId: d.id },
        });
      }
    }
  }

  // ordena (mais recente primeiro)
  timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return res.json({ client, orders, budgets, timeline });
}

module.exports = {
  listClients,
  createClient,
  updateClient,
  deleteClient,
  listClientsWithMetrics,
  listClientOrders,
  getClientHistory, // ✅ novo
};