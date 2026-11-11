// Worker entrypoint. Routes live in ./index; this module also exports the
// Workflow classes Wrangler binds, which need the `cloudflare:workers` runtime
// module and therefore stay out of the Node-based route tests.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import app from "./index";
import { type LiveEndParams, runLiveEnd } from "./live-end";
import type { Bindings } from "./types";

export class LiveEndWorkflow extends WorkflowEntrypoint<
  Bindings,
  LiveEndParams
> {
  override async run(
    event: Readonly<WorkflowEvent<LiveEndParams>>,
    step: WorkflowStep,
  ): Promise<void> {
    await runLiveEnd(this.env, event.payload, step);
  }
}

export default app;
