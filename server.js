import './src/logger.js';
import express from 'express';
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
import { registerControlAuthRoutes } from './src/control-auth.js';
import { registerVmixRoutes } from './src/vmix/server.js';
import { registerRosterRoutes } from './src/roster-routes.js';
import { registerEvent } from './src/vmix/event-registry.js';
import { initializeState } from './src/vmix/state.js';
import { getEventIdFilter } from './src/config.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize State Store (clean slate on startup)
initializeState();

// Initialize Event Registry: auto-register the configured event filter if present
const eventIdFilter = getEventIdFilter();
if (eventIdFilter !== null) {
  registerEvent(eventIdFilter);
  console.log(
    `Event Registry: auto-registered event ${eventIdFilter} from config`,
  );
}

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
