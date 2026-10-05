import { main } from './cli.ts';

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`agento: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
