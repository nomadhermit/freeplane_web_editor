# Freeplane Web Editor

A lightweight Go web application that runs a localhost server for creating, viewing, editing, and saving **Freeplane / FreeMind `.mm` mind-map files**.

!! Not intended to be a freeplane replacement, only simple editor/viewer !!
!! for local use only, not for internet facing scenarios without proper security enhancements and review !!
!! vibe coded with Grok as experiment !!

## Features

- **Local web server** (default `http://localhost:8080`)
- **Create / Upload / Open / Save / Delete / Download** `.mm` files
- **Tree UI** with expand/collapse
- **Basic CRUD on nodes**:
  - Create child / sibling
  - Edit node text
  - Edit node notes (stored as Freeplane `<richcontent TYPE="NOTE">`)
  - Move node up / down among siblings (buttons or `Alt+↑` / `Alt+↓`)
  - **Move node under another parent** (reparent)
  - Sort children of selected node A–Z
  - **Connect nodes** with bidirectional links (Freeplane `<arrowlink>`)
  - Jump to a connected node from the editor panel
  - Delete node (and its subtree; links cleaned up)
- Round-trip compatible with Freeplane for basic maps (text + notes + hierarchy + folded state + arrow links)

## Requirements

- Go 1.22+ (only standard library used — no external dependencies)

## Quick start

```bash
cd freeplane-web
go build -o freeplane-web .
./freeplane-web
```

Then open **http://localhost:8080** in your browser.

Maps are stored as `.mm` files in the `maps/` directory next to the binary.

You can also set the port:

```bash
PORT=3000 ./freeplane-web
```

## API overview

| Method | Path                  | Description                                      |
|--------|-----------------------|--------------------------------------------------|
| GET    | `/api/maps`           | List map names                                   |
| POST   | `/api/maps`           | Create map `{ "name": "…" }`                     |
| POST   | `/api/upload`         | Upload `.mm` (multipart field `file`; optional `overwrite=1`) |
| GET    | `/api/map/{name}`     | Load map as JSON tree                            |
| PUT    | `/api/map/{name}`     | Save JSON tree → `.mm`                           |
| DELETE | `/api/map/{name}`     | Delete map file                                  |
| GET    | `/api/download/{name}`| Download raw `.mm`                               |

## Notes on format

- Files use Freeplane-compatible XML (`version="1.0.1"`).
- Node notes are written as simple XHTML inside `<richcontent TYPE="NOTE">`.
- Node connections are stored as Freeplane `<arrowlink DESTINATION="…">` (written on both ends for bidirectional links).
- Supported subset: TEXT, ID, FOLDED, notes, hierarchy, arrow links. Icons, attributes, styles, formulas, etc. are ignored on load and not written on save.

## Keyboard

- `Ctrl+S` / `Cmd+S` — save current map
- `Ctrl+L` / `Cmd+L` — start (or cancel) link mode
- `Ctrl+M` / `Cmd+M` — start (or cancel) reparent / move mode
- `Esc` — cancel link or reparent mode
- `Alt+↑` / `Alt+↓` — move selected node up / down among siblings
