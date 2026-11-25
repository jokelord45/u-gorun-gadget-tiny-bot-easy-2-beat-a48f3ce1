// Entrypoint: the grader runs `node /bot/main.ts`.
import { runBars } from './vendor/makefun-bars.ts';
import { createStrategy } from './strategy.ts';

await runBars(createStrategy());
