import './src/logger.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerHealthRoute,
  registerRootRoute,
  registerTestRoute,
  registerWebhookRoutes,
  registerCacheRoutes,
  registerConfigRoutes,
  registerControlWebhookRoutes,
} from './src/webhooks.js';
import { registerDocs } from './src/docs.js';
import {
  registerControlAuthRoutes,
  requireControlSession,
} from './src/control-auth.js';
import {
  registerVmixRoutes,
  resolveClassIdsForAllActiveEvents,
} from './src/vmix/server.js';
import { registerRosterRoutes } from './src/roster-routes.js';
import { registerEvent, hydrateFromStore } from './src/vmix/event-registry.js';
import { initializeState } from './src/vmix/state.js';
import { getEventIdFilter } from './src/config.js';
import { runMigrations } from './src/db/migrate.js';
import { isDbConfigured } from './src/db/client.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize State Store (clean slate on startup)
initializeState();

// Hydrate the Event Registry from the database, then fall back to the
// configured event filter if nothing was restored.
async function initializeRegistry() {
  let restored = 0;
  if (isDbConfigured()) {
    try {
      await runMigrations();
      restored = await hydrateFromStore();
      if (restored > 0) {
        console.log(
          `Event Registry: restored ${restored} slot(s) from database`,
        );
        // Re-resolve competition classIds from Sportfengur in the background
        resolveClassIdsForAllActiveEvents().catch((err) => {
          console.error(
            'Event Registry: failed to re-resolve classIds after hydration:',
            err.message,
          );
        });
      }
    } catch (error) {
      console.error(
        'Event Registry: failed to restore from database:',
        error.message,
      );
    }
  }

  if (restored === 0) {
    const eventIdFilter = getEventIdFilter();
    if (eventIdFilter !== null) {
      registerEvent(eventIdFilter);
      console.log(
        `Event Registry: auto-registered event ${eventIdFilter} from config`,
      );
    }
  }
}

initializeRegistry();

registerRootRoute(app);
registerWebhookRoutes(app);
registerTestRoute(app);
registerHealthRoute(app);
registerCacheRoutes(app);
registerConfigRoutes(app);
registerControlWebhookRoutes(app);
registerDocs(app);
registerControlAuthRoutes(app);
registerVmixRoutes(app);
registerRosterRoutes(app);

// --- Serve the built Vite React control app at /app ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(__dirname, 'web', 'dist');

// Require a valid control session before serving the app (any role).
// Assets (JS/CSS) are allowed through so the login redirect page can't break,
// but the HTML entry points are gated.
function requireAppSession(req, res, next) {
  if (requireControlSession(req, res, false)) {
    return next();
  }
  // requireControlSession already redirected to /control/login
}

app.use('/app', requireAppSession, express.static(webDist));

// SPA fallback: any /app/* route that isn't a static file serves index.html
app.get('/app/{*splat}', requireAppSession, (req, res, next) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) next();
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`███████╗██╗██████╗ ███████╗ █████╗ ██╗  ██╗██╗████████╗██╗   ██╗
██╔════╝██║██╔══██╗██╔════╝██╔══██╗╚██╗██╔╝██║╚══██╔══╝██║   ██║
█████╗  ██║██║  ██║█████╗  ███████║ ╚███╔╝ ██║   ██║   ██║   ██║
██╔══╝  ██║██║  ██║██╔══╝  ██╔══██║ ██╔██╗ ██║   ██║   ╚██╗ ██╔╝
███████╗██║██████╔╝██║     ██║  ██║██╔╝ ██╗██║   ██║    ╚████╔╝ 
╚══════╝╚═╝╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝   ╚═╝     ╚═══╝  
                                                                `);
  console.log('SportFengur Webhooks er ræst');
  console.log(`Vefþjónn keyrir á porti ${port}`);
  console.log('vMix routes are ready (/event/*, /control)');
});
