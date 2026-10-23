import { Router, type IRouter } from "express";
import healthRouter from "./health";
import capabilitiesRouter from "./capabilities";
import uploadsRouter from "./uploads";

const router: IRouter = Router();

router.use(healthRouter);
router.use(capabilitiesRouter);
router.use(uploadsRouter);

export default router;
