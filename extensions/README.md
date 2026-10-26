# extensions/

Empty in the upstream repo. A company fork puts its own code here: source adapters for its systems, or rules that exist only at that company. Core (`backend/`, `frontend/`) is never edited in a fork.

Name each extension `<company>.<name>` (for example `extensions/acme.tag-mapping`), give it its own tests, and keep recorded fixtures beside it. What an extension can implement is listed under "Extension points" in [AGENTS.md](../AGENTS.md).

Start an adapter from [templates/adapter](../templates/adapter) and read [docs/write-an-adapter.md](../docs/write-an-adapter.md). The kit for its tests is `backend/src/ObservabilityCity.AdapterKit`.
