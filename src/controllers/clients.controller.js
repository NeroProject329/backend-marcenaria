const { prisma } = require("../lib/prisma");

function cleanPhone(v) {
  return String(v || "").replace(/\D/g, "");
}

async function listClients(req, res) {
  const { salonId } = req.user;
  const q = (req.query.q || "").trim();

  const where = { salonId };

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { phone: { contains: cleanPhone(q) } },
      { instagram: { contains: q, mode: "insensitive" } },
    ];
  }

  const clients = await prisma.client.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      phone: true,
      instagram: true,
      notes: true,
      createdAt: true,
    },
  });

  return res.json({ clients });
}

async function createClient(req, res) {
  const { salonId } = req.user;
  const { name, phone, instagram, notes } = req.body;

  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ message: "Nome do cliente é obrigatório." });
  }

  const phoneClean = cleanPhone(phone);
  if (!phoneClean || phoneClean.length < 8) {
    return res.status(400).json({ message: "Telefone inválido." });
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
      notes: notes ? String(notes).trim() : null,
      salonId,
    },
    select: {
      id: true,
      name: true,
      phone: true,
      instagram: true,
      notes: true,
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

  const { name, phone, instagram, notes } = req.body;

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

  const client = await prisma.client.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      phone: true,
      instagram: true,
      notes: true,
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
    const finalized = client.appointments.filter(
      (a) => a.status === "FINALIZADO"
    );

    const canceled = client.appointments.filter(
      (a) => a.status === "CANCELADO"
    );

    const totalSpent = finalized.reduce(
      (sum, a) => sum + (a.service?.price || 0),
      0
    );

    const lastVisit =
      finalized.length > 0
        ? finalized.reduce((latest, a) =>
            a.startAt > latest ? a.startAt : latest
          , finalized[0].startAt)
        : null;

    const monthsActive = finalized.length
      ? Math.max(
          1,
          Math.ceil(
            (Date.now() - new Date(finalized[0].startAt)) /
              (1000 * 60 * 60 * 24 * 30)
          )
        )
      : 1;

    const frequency = finalized.length
      ? Number((finalized.length / monthsActive).toFixed(1))
      : 0;

    return {
      id: client.id,
      name: client.name,
      phone: client.phone,
      totalSpent,
      visits: finalized.length,
      lastVisit,
      canceled: canceled.length,
      frequency,
    };
  });

  return res.json({ clients: result });
}


module.exports = {
  listClients,
  createClient,
  updateClient,
  deleteClient,
  listClientsWithMetrics,
};
