---
description: Split work across parallel workers (mirrors Buddy /swarm)
agent: build
---

Decompose the task into 2-4 independent workstreams that can proceed in
parallel. Implement each one, keeping changes isolated per file/area, then
integrate and verify with `npm run check`. $ARGUMENTS
