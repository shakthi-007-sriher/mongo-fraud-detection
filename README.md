# Real-time fraud and anomaly detection in MongoDB

The detection logic lives in MongoDB: a **Change Stream** triggers an **aggregation pipeline** that scores each
transaction against the user's rolling statistics, a **time-series collection** holds the history, and the
dashboard only reads **views**. JavaScript is used as glue, in `mongosh` scripts, plus a 30-line Express server.

```
mongo/                      the system (run with mongosh)
  lib/pipelines.js          the scoring model as aggregation stages
  lib/synthetic.js          seeded random helpers for the generator
  01_setup.js               collections, validator, time-series, indexes, TTL, views, parameters
  02_detector.js            change stream on tx_inbox -> scoring pipeline -> tx_scores / tx_history
  03_generator.js           live labelled traffic into tx_inbox
  04_analytics.js           rolling statistics, percentiles, $merge, $bucket (all in-database)
  05_evaluate.js            precision / recall / latency from two aggregations
dashboard/                  server.js (reads views) and public/index.html (Chart.js)
reference/                  optional offline JavaScript model and simulation (no MongoDB needed)
test/                       pipeline test: runs the pipeline against the reference model
```

## Requirements

* MongoDB **7.0 or newer** running as a **replica set** (Change Streams need one; one node is enough).
* **mongosh** (the MongoDB Shell, separate from Compass). Windows: `winget install MongoDB.Shell`.
* Node.js 18+ for the dashboard and the tests.

## Start MongoDB as a replica set

Windows service (what you configured): in `mongod.cfg` set

```yaml
replication:
  replSetName: rs0
```

restart the **MongoDB Server** service, then run once in mongosh or Compass:

```js
rs.initiate()
```

or with Docker: `docker run -d --name mongo -p 27017:27017 mongo:7 --replSet rs0`, then
`docker exec mongo mongosh --eval "rs.initiate()"`.

## Run (PowerShell, from this folder)

```powershell
npm install          # once
npm run setup        # once: creates the collections, views and settings (safe to repeat)
npm run dashboard    # leave this running, then open http://localhost:3000
```

In the page, press **Start everything** (or **Guided demo** for a 2-minute automatic tour). The page starts the detector
and the demo traffic for you. The default connection is `mongodb://localhost:27017/?directConnection=true`;
set `MONGO_URI` only if your server is elsewhere. Database name: `DB_NAME` (default `fraudlab`).

Optional terminal commands: `npm run detector`, `npm run generator`, `npm run analytics`,
`$env:MINUTES=15; npm run evaluate`.

## Changing the scoring without touching code

The parameters are one document in the database:

```js
db.getSiblingDB("fraudlab").config.updateOne({ _id: "scoring" }, { $set: { scoreAlert: 70 } })
```

Restart the detector to pick it up.

## Using the dashboard

Nine tabs (keys 1 to 9): **Live monitor** (setup checklist, ticker, charts), **Radar** (live dots pushed from a change
stream), **Attack lab** (botnet, card testing, impossible travel), **Fraud rings** (`$graphLookup` graph of accounts sharing
a device), **Rule builder** (back-test your own rule), **Investigate**, **Try it yourself**, **Tune & what-if** and
**How to use**. Click any row, dot or alert to see why a transaction got its score. The header has **Start everything** and
the **Guided demo**. The Attack lab needs about 2 minutes of demo traffic first (a meter shows when it is ready).

## Offline checks (no MongoDB)

```powershell
npm test            # runs the scoring pipeline against the JavaScript reference model on 5,000 random histories
npm run simulate    # 443,803-event simulation used for Part A of the report (seed 42)
```

## Status

The scoring pipeline's logic is tested against the reference model, and the simulation reproduces the report's
Part A numbers. The mongosh scripts, the change stream, the time-series collection and the views have **not been
run against a real MongoDB server** by the author. If a step fails, the error text will name the line to fix.
Known points to check on first run: `$$NOW` inside the two `v_*` views (MongoDB 4.2+), and `$percentile` (7.0+).
