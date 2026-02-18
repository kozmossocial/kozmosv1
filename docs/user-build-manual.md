# User Build Manual

## 1. What User Build Is
- User Build is your personal build environment inside Kozmos.
- You can create subspaces, add files, write code/content, preview output, and publish a room manifest for world placement.
- The owner controls visibility and edit permissions.

## 2. Quick Start
1. Create a subspace from the left panel.
2. Select the subspace, add a file path (for example `index.html`, `styles.css`, `app.js`).
3. Open the file, write content, then click `save file`.
4. Use `outcome preview` to test instantly. If needed, click `refresh` or `open tab`.

## 3. Subspaces and Visibility
- Each subspace is an isolated workspace with its own files.
- Owner can set `make public` / `make private`.
- Public means visible to others for read access; edit still requires permission.
- Deleting a subspace removes its files and cannot be undone.

## 4. Files and Editor
- Use normalized paths (for example `src/main.ts`, `docs/readme.md`).
- Use language selector to label file type for better structure and AI context.
- `delete selected file` permanently removes the file.
- If a subspace is read-only for you, editing actions are blocked.

## 5. Collaboration (In-Touch Access)
- Only the subspace owner can manage editor access.
- From `in touch access`: `allow edit` grants write rights, `revoke edit` removes them.
- Non-owners can still view public/shared content but cannot change files without edit rights.

## 6. Publish Room
- `publish room` writes/updates `space.room.json` in the selected subspace.
- Manifest carries room metadata (title, aura, visibility, entry mode, icon, spawn).
- Visibility changes also try to sync the room manifest automatically.
- If sync fails, run `publish room` again.

## 7. Outcome Preview
- Preview renders from your current files.
- Best result: include `index.html` as entry point, then optional `.css` / `.js` files.
- `auto: on` injects current editor changes without leaving the page.
- `open tab` creates a standalone preview window for larger testing.

## 8. Builder Axy
- Use Builder Axy for architecture, debugging, and implementation guidance.
- Provide clear prompts: goal, stack, constraints, and current file path.
- Ask for small, testable increments (v1 first, then iterate).
- Axy responses are guidance; you control final file changes.

## 9. Practical Workflow
1. Start with a minimal structure: `index.html` + one style + one script.
2. Save and preview every small change.
3. Commit to one feature at a time (layout, then interaction, then polish).
4. Document key decisions in a README inside the subspace.

## 10. Common Issues
- Could not create subspace/file: check session and permissions.
- Read-only subspace: request owner to grant edit access.
- Preview empty: ensure an HTML entry file exists (preferably `index.html`).
- Publish failed: verify selected space + edit rights, then retry.
