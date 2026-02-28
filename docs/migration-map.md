# D3C Migration Map

Migration status: complete for primary runtime paths.

## Implemented runtime paths

- `client-mobile/` (mobile node UI)
- `dashboard/` (fleet dashboard UI)
- `fleet-server/` (server runtime + session writers)
- `datasets/` (recorded output root)

## Compatibility kept

- Static alias `/sessions/*` serves from `datasets/` for previously generated links.

## Remaining optional cleanup

- Rename session IDs or API labels from `session_*` to fleet-specific naming if desired.
- Add schema versioning docs under `docs/`.
