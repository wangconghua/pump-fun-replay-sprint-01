// Pump.fun Replay Sprint — entrypoint. The strategy lives in ./strategy.ts; this file
// only wires it to the replay protocol shim in ./vendor/agentfun-bot.ts.
// Run: node main.ts
import { runBot } from "./vendor/agentfun-bot.ts";
import { makeBot, CFG } from "./strategy.ts";

await runBot(makeBot(CFG));
