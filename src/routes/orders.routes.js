const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  cancelOrder,
} = require("../controllers/orders.controller");

router.use(requireAuth);

router.get("/", listOrders);
router.get("/:id", getOrder);
router.post("/", createOrder);
router.patch("/:id", updateOrder);

// ação de negócio (melhor que DELETE)
router.post("/:id/cancel", cancelOrder);

module.exports = router;
