const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { checkLimit } = require("../middlewares/plan.middleware");

const {
  listClients,
  createClient,
  updateClient,
  deleteClient,
  listClientsWithMetrics,
  listClientOrders,
  getClientHistory, // ✅ NOVO
} = require("../controllers/clients.controller");

router.use(requireAuth);

router.get("/metrics", listClientsWithMetrics);

// ✅ NOVO: histórico completo do cliente (pedidos + orçamentos + timeline)
router.get("/:id/history", getClientHistory);

// Mantido: histórico só de pedidos (não quebra nada existente)
router.get("/:id/orders", listClientOrders);

router.get("/", listClients);
router.post("/", checkLimit("clients"), createClient);
router.patch("/:id", updateClient);
router.delete("/:id", deleteClient);

module.exports = router;