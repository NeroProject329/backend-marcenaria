const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  listPayables,
  getPayable,
  createPayable,
  updatePayable,
  updatePayableInstallment,
} = require("../controllers/payables.controller");

router.use(requireAuth);

router.get("/", listPayables);
router.get("/:id", getPayable);
router.post("/", createPayable);
router.patch("/:id", updatePayable);

// parcelas
router.patch("/installments/:installmentId", updatePayableInstallment);

module.exports = router;
