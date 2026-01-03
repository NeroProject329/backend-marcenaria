const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  listAppointments,
  createAppointment,
  updateAppointment,
  deleteAppointment,
} = require("../controllers/appointments.controller");

router.use(requireAuth);

router.get("/", listAppointments);
router.post("/", requireAuth, checkLimit("appointmentsMonth"), createAppointment);
router.patch("/:id", updateAppointment);
router.delete("/:id", deleteAppointment);

module.exports = router;
