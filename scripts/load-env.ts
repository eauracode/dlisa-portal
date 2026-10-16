import { config } from "dotenv";

// Same precedence as Next.js: .env.local overrides .env. Variables already set win.
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
