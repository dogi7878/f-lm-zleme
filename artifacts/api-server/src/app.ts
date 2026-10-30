import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getAdminSettings } from "./lib/admin-store";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Maintenance gate: keep the admin API and health check available so maintenance can be disabled.
app.use("/api", (req, res, next) => {
  void getAdminSettings().then((settings) => {
    const allowedDuringMaintenance = req.path.startsWith("/admin") || req.path === "/health";
    if (settings.maintenanceMode && !allowedDuringMaintenance) {
      res.setHeader("Retry-After", "120");
      res.status(503).json({ error: settings.maintenanceMessage, maintenance: true });
      return;
    }
    next();
  }).catch(next);
});

app.use("/api", router);

export default app;
