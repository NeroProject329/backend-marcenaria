const { prisma } = require("../lib/prisma");

/**
 * Helpers
 */
function toInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`${field} inválido`);
  }
  return n;
}

/**
 * LISTAR SERVIÇOS
 * GET /api/services
 */
async function listServices(req, res) {
  try {
    const salonId = req.user.salonId;

    const services = await prisma.service.findMany({
      where: { salonId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        category: true,
        price: true,
        durationM: true, // campo real do Prisma
        isActive: true,
        createdAt: true,
      },
    });

    // mantém compatibilidade com o front (durationM)
    return res.json({
      services: services.map((s) => ({
        ...s,
        durationM: s.duration,
      })),
    });
  } catch (err) {
    console.error("[listServices]", err);
    return res.status(500).json({ message: "Erro ao listar serviços." });
  }
}

/**
 * CRIAR SERVIÇO
 * POST /api/services
 */
async function createService(req, res) {
  try {
    const salonId = req.user.salonId;
    const { name, category, price, durationM } = req.body;

    if (!name || price == null || durationM == null) {
      return res.status(400).json({ message: "Campos obrigatórios ausentes." });
    }

    const priceInt = toInt(price, "price");
    const durationInt = toInt(durationM, "durationM");

    if (priceInt < 0 || durationInt <= 0) {
      return res.status(400).json({ message: "Valores inválidos." });
    }

    const service = await prisma.service.create({
      data: {
        salonId,
        name: String(name).trim(),
        category: category ? String(category).trim() : null,
        price: priceInt,
        durationM: durationInt, // grava no campo real
      },
      select: {
        id: true,
        name: true,
        category: true,
        price: true,
        durationM: true,
        isActive: true,
        createdAt: true,
      },
    });

    return res.status(201).json({
      service: {
        ...service,
        durationM: service.duration,
      },
    });
  } catch (err) {
    console.error("[createService]", err);
    return res.status(500).json({ message: "Erro ao criar serviço." });
  }
}

/**
 * ATUALIZAR SERVIÇO
 * PATCH /api/services/:id
 */
async function updateService(req, res) {
  try {
    const salonId = req.user.salonId;
    const { id } = req.params;
    const { name, category, price, durationM, isActive } = req.body;

    const data = {};

    if (name !== undefined) data.name = String(name).trim();
    if (category !== undefined) data.category = category ? String(category).trim() : null;
    if (price !== undefined) data.price = toInt(price, "price");
    if (durationM !== undefined) data.duration = toInt(durationM, "durationM");
    if (isActive !== undefined) data.isActive = Boolean(isActive);

    const updatedCount = await prisma.service.updateMany({
      where: { id, salonId },
      data,
    });

    if (!updatedCount.count) {
      return res.status(404).json({ message: "Serviço não encontrado." });
    }

    const updated = await prisma.service.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        category: true,
        price: true,
        durationM: true,
        isActive: true,
        createdAt: true,
      },
    });

    return res.json({
      service: {
        ...updated,
        durationM: updated.duration,
      },
    });
  } catch (err) {
    console.error("[updateService]", err);
    return res.status(500).json({ message: "Erro ao atualizar serviço." });
  }
}

/**
 * ATIVAR / DESATIVAR SERVIÇO
 * PATCH /api/services/:id/toggle
 */
async function toggleService(req, res) {
  try {
    const salonId = req.user.salonId;
    const { id } = req.params;

    const service = await prisma.service.findFirst({
      where: { id, salonId },
      select: { isActive: true },
    });

    if (!service) {
      return res.status(404).json({ message: "Serviço não encontrado." });
    }

    const updated = await prisma.service.update({
      where: { id },
      data: { isActive: !service.isActive },
      select: {
        id: true,
        name: true,
        category: true,
        price: true,
        durationM: true,
        isActive: true,
        createdAt: true,
      },
    });

    return res.json({
      service: {
        ...updated,
        durationM: updated.duration,
      },
    });
  } catch (err) {
    console.error("[toggleService]", err);
    return res.status(500).json({ message: "Erro ao alterar status do serviço." });
  }
}

/**
 * DELETAR SERVIÇO
 * DELETE /api/services/:id
 */
async function deleteService(req, res) {
  try {
    const salonId = req.user.salonId;
    const { id } = req.params;

    // delete seguro por tenant
    const deleted = await prisma.service.deleteMany({
      where: { id, salonId },
    });

    if (!deleted.count) {
      return res.status(404).json({ message: "Serviço não encontrado." });
    }

    return res.status(204).send();
  } catch (err) {
    // Se tiver FK (ex: appointments referenciando service), Prisma pode jogar erro.
    console.error("[deleteService]", err);
    return res.status(409).json({
      message: "Não foi possível deletar: serviço está em uso. Desative em vez de excluir.",
    });
  }
}


module.exports = {
  listServices,
  createService,
  updateService,
  toggleService,
  deleteService,
};

