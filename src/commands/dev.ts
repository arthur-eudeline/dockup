import { Effect } from "effect";

import { getContainerEnvVariables, listBackupEnabledContainers } from "../lib/docker";
import { effectRuntime } from "../lib/effect";

const program = Effect.gen(function* program() {
  const containers = yield* listBackupEnabledContainers();
  const container = containers.find((c) => c.type === "volumes");
  if (!container) {
    throw new Error("Aucun container volume");
  }

  yield* getContainerEnvVariables(container.id);
});

await effectRuntime.runPromise(program);
