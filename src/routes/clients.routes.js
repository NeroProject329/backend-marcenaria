const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  listClients,
  createClient,
  updateClient,
  deleteClient,
  listClientsWithMetrics,
  listClientOrders, // ✅ NOVO
} = require("../controllers/clients.controller");
const { checkLimit } = require("../middlewares/plan.middleware"); 

router.use(requireAuth);

router.get("/metrics", listClientsWithMetrics);

// ✅ NOVO: histórico de pedidos do cliente
router.get("/:id/orders", listClientOrders);

router.get("/", listClients);
router.post("/", checkLimit("clients"), createClient);
router.patch("/:id", updateClient);
router.delete("/:id", deleteClient);

module.exports = router;
