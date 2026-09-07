# @robo/web

The React workbench, a client of the coordinator only. Compose here; the shared value types come from `@robo/domain`. It never reaches a package outside the graph in `tools/graph.ts`. A visible change is incomplete until the page builds and `scripts/browser_check.py` exercises the changed interaction.
