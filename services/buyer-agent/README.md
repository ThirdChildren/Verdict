# buyer-agent

Local buyer agent (QVAC). Routes each request to a verifiable task type, or refuses it (`TASK_NOT_VERIFIABLE`), then proposes the spend intent.

Routing evaluation (real model, run on the Legion): `cd services/buyer-agent && ../../node_modules/.bin/tsx scripts/route-eval.ts`. It runs the 24 labelled requests in `eval/route-cases.json`, prints accuracy and the false-accept count. Ship bar: 20/24 and zero false accepts.

Authoring (E33): `POST /api/author {request}` drafts an acceptance test with one structured call (200 with the draft for `cli`/`reframe`, 422 `TASK_NOT_VERIFIABLE` for `none`, 422 `AUTHOR_FAILED` on invalid output or timeout). The engine validates and installs it; the buyer never writes files.

Authoring evaluation (real model, Legion): `cd services/buyer-agent && ../../node_modules/.bin/tsx scripts/author-eval.ts`. It runs the 24 labelled requests in `eval/author-cases.json` (8 cli, 8 reframe, 8 none). Ship bar: 20/24 and zero `none` labelled cli/reframe.
