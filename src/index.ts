import { buildApp } from "./app.js";
import { resolveConfig } from "./config.js";

const config = resolveConfig();
const app = buildApp(config);

try {
  await app.listen({
    host: config.host,
    port: config.port,
  });
  console.log(`Greytrace backend listening on http://${config.host}:${config.port}`);
} catch (error) {
  await app.close();
  console.error(error);
  process.exit(1);
}
