const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  cancelOrder,
   deleteOrder,
   updateOrderFull,
} = require("../controllers/orders.controller");

router.use(requireAuth);

router.get("/", listOrders);
router.get("/:id", getOrder);
router.post("/", createOrder);

// update (já existe e funciona)
router.patch("/:id", updateOrder);

// ação de negócio (melhor que DELETE)
router.post("/:id/cancel", cancelOrder);

router.delete("/:id", deleteOrder);

router.patch("/:id/full", updateOrderFull);

module.exports = router;
