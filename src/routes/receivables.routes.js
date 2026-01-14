const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  listReceivables,
  getReceivable,
  createReceivable,
  updateReceivable,
  updateReceivableInstallment,
} = require("../controllers/receivables.controller");

router.use(requireAuth);

router.get("/", listReceivables);
router.get("/:id", getReceivable);
router.post("/", createReceivable);
router.patch("/:id", updateReceivable);

// parcelas
router.patch("/installments/:installmentId", updateReceivableInstallment);

module.exports = router;
