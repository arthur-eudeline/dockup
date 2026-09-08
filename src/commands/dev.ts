import { Effect } from "effect";

import { runStandalone } from "../lib/cli";
import { getContainerEnvVariables, listBackupEnabledContainers } from "../lib/docker";
import { UndefinedVariableError } from "../lib/errors";

// Scratch script — not wired into the CLI. Run with `bun src/commands/dev.ts`.
const program = Effect.gen(function* _dev() {
  const { containers } = yield* listBackupEnabledContainers();
  const container = containers.find((c) => c.type === "volumes");
  if (!container) {
    return yield* Effect.fail(new UndefinedVariableError({ variable: "a volumes-type container" }));
  }

  yield* getContainerEnvVariables(container.id);
});

await runStandalone(program);
