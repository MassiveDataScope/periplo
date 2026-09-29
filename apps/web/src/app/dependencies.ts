import { createLoomClient, createQueryController } from "@periplo/core/api";
import { createResultBuffer, type ResultBuffer } from "@periplo/core/arrow";
import type { QuerySession } from "@periplo/core/api/react";
import { createPeriploTransport, type PeriploClient } from "../api/periplo-transport";
import { createTableFactsStore, type TableFactsStore } from "../api/table-facts";
import type { paths } from "../api/schema";

export interface Dependencies {
  readonly client: PeriploClient;
  /** The lake's facts about tables (detail, stats, history), deduped and capped for the whole session. */
  readonly tableFacts: TableFactsStore;
  /** Builds a controller and the buffer it feeds; the caller disposes both, in that order. */
  createQuerySession(): QuerySession<ResultBuffer>;
}

export function createDependencies(options: { baseUrl: string; fetch?: typeof globalThis.fetch }): Dependencies {
  const client = createLoomClient<paths>(options);
  const transport = createPeriploTransport(client);
  const tableFacts = createTableFactsStore(client, { concurrency: 3, retain: 300 });
  return {
    client,
    tableFacts,
    createQuerySession() {
      const buffer = createResultBuffer();
      const controller = createQueryController({ transport, sink: buffer });
      return {
        controller,
        resource: buffer,
        dispose() {
          controller.destroy();
          buffer.dispose();
        },
      };
    },
  };
}
