# buyer-agent

Local buyer agent (QVAC). Routes each request to a verifiable task type, or refuses it (`TASK_NOT_VERIFIABLE`), then proposes the spend intent.

Routing evaluation (real model, run on the Legion): `cd services/buyer-agent && ../../node_modules/.bin/tsx scripts/route-eval.ts`. It runs the 24 labelled requests in `eval/route-cases.json`, prints accuracy and the false-accept count. Ship bar: 20/24 and zero false accepts.
