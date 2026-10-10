import path from "node:path";
import { pathToFileURL } from "node:url";
import { Menu, Tray, app, dialog, nativeImage, net, protocol, safeStorage } from "electron";
import { Controller } from "./controller.js";
import { Storage } from "./storage.js";
import { TRAY_ICON_PNG_B64 } from "./icon.js";

// Assets (the bundled MobileNet model) are served from a private scheme so the sandboxed
// renderer can fetch them without file:// access.
protocol.registerSchemesAsPrivileged([{ scheme: "ptu-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

// Tests (and power users) can run an isolated instance with its own data directory.
if (process.env.PTU_USER_DATA) app.setPath("userData", process.env.PTU_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let controller: Controller | null = null;
  let tray: Tray | null = null;

  app.on("second-instance", () => controller?.showDashboard());

  const modelsDir = app.isPackaged ? path.join(process.resourcesPath, "models") : path.join(__dirname, "..", "..", "assets", "models");

  app.whenReady().then(async () => {
    protocol.handle("ptu-asset", (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
      const file = path.resolve(modelsDir, rel);
      if (!file.startsWith(path.resolve(modelsDir) + path.sep)) return new Response("forbidden", { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });

    const storage = new Storage(app.getPath("userData"), safeStorage);
    controller = new Controller(storage, {
      preload: path.join(__dirname, "..", "preload", "preload.cjs"),
      renderer: path.join(__dirname, "..", "renderer"),
      wasmDir: __dirname,
      modelUrl: "ptu-asset://models/mobilenet_v2/model.json",
    });
    try {
      await controller.init();
    } catch (e) {
      dialog.showErrorBox("Prove to Unlock couldn't start", String((e as Error).stack ?? e));
      app.exit(1);
      return;
    }

    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_B64}`);
    if (process.platform === "darwin") icon.setTemplateImage(true);
    tray = new Tray(icon.resize({ width: 18, height: 18 }));
    tray.setToolTip("Prove to Unlock");
    const c = controller;
    const menu = Menu.buildFromTemplate([
      { label: "Open Prove to Unlock", click: () => c.showDashboard() },
      { label: "Show lock screen", click: () => c.showLockScreen() },
      { type: "separator" },
      {
        label: "Emergency unlock…",
        click: async () => {
          const r = await dialog.showMessageBox({
            type: "warning",
            buttons: ["Cancel", "Emergency unlock"],
            defaultId: 0,
            cancelId: 0,
            message: "Use an emergency unlock?",
            detail: "Everything unlocks for a short time on all your linked devices. It's logged and resets your streak.",
          });
          if (r.response === 1) await c.emergency("tray");
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          if (!c.canQuit()) {
            void dialog.showMessageBox({ type: "info", message: "You're locked right now.", detail: "Prove your commitment or use the emergency unlock first. (Test mode can always quit.)" });
            return;
          }
          c.allowQuit();
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => c.showDashboard());
  });

  // Keep running in the tray when windows close.
  app.on("window-all-closed", () => undefined);

  let shuttingDown = false;
  app.on("before-quit", (e) => {
    if (!controller) return;
    if (!controller.canQuit()) {
      e.preventDefault();
      return;
    }
    if (shuttingDown) return;
    shuttingDown = true;
    e.preventDefault();
    void controller.shutdown().finally(() => app.exit(0));
  });

  app.on("activate", () => controller?.showDashboard());
}
