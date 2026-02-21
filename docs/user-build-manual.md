# User Build Manual

## 1. What User Build Is
- User Build is your personal build environment inside Kozmos.
- You can create subspaces, add files, write code/content, preview output, and publish a room manifest for world placement.
- Build apps with a built-in backend (Starter API) — no server setup needed.
- The owner controls visibility, edit permissions, and starter mode.

## 2. Quick Start
1. Create a subspace from the left panel.
2. Select the subspace, add a file path (for example `index.html`, `styles.css`, `app.js`).
3. Open the file, write content, then click `save file`.
4. Use `outcome preview` to test instantly. If needed, click `refresh` or `open tab`.
5. Use `publish room` to enable Starter Mode and create a world room.

## 3. Subspaces and Visibility
- Each subspace is an isolated workspace with its own files, users, and data.
- Owner can set `make public` / `make private`.
- Public means visible to others for read access; edit still requires permission.
- Deleting a subspace removes its files and cannot be undone.

## 4. Files and Editor
- Use normalized paths (for example `src/main.ts`, `docs/readme.md`).
- Use language selector to label file type for better structure and AI context.
- `delete selected file` permanently removes the file.
- If a subspace is read-only for you, editing actions are blocked.

### Editor Search
- Use the search bar in the editor toolbar (between language selector and save button).
- Type to search, press Enter or use ▲/▼ buttons to navigate matches.
- Match count displayed (e.g., "3/7" shows you're on match 3 of 7).
- Search is case-insensitive.

## 5. Collaboration (In-Touch Access)
- Only the subspace owner can manage editor access.
- From `in touch access`: `allow edit` grants write rights, `revoke edit` removes them.
- Non-owners can still view public/shared content but cannot change files without edit rights.

## 6. Publish Room
- `publish room` writes/updates `space.room.json` in the selected subspace.
- Manifest carries room metadata (title, aura, visibility, entry mode, icon, spawn).
- **Publishing also enables Starter Mode** — activates the backend API for your space.
- Visibility changes also try to sync the room manifest automatically.
- If sync fails, run `publish room` again.

## 7. Outcome Preview
- Preview renders from your current files.
- Best result: include `index.html` as entry point, then optional `.css` / `.js` files.
- `auto: on` injects current editor changes without leaving the page.
- `open tab` creates a standalone preview window for larger testing.
- **Expand/Shrink**: Click `expand` to make preview larger, `shrink` to restore.
- Preview automatically injects the `KozmosRuntime` bridge for Starter API access.

## 8. Builder Axy (AI Assistant)

Builder Axy is your AI co-builder with enhanced capabilities:

### Capabilities
- **Tool Calling**: Axy can directly create and update files in your space.
- **Apply Code**: When Axy creates code, you'll see `▶ create filename` buttons — click to apply.
- **Starter API Awareness**: Axy knows all Starter APIs and can help you build with them.
- **GPT-4o Powered**: Uses advanced model for better code generation.

### Usage Tips
- Ask clearly: "build a todo app using KozmosRuntime"
- For social apps: "create a feed using posts API"
- For games: "make a simple snake game"
- Iterate: "add dark mode" or "fix the login button"

### File Actions
When Axy generates code:
1. File action buttons appear: `▶ create index.html` or `▶ update styles.css`
2. Click button to apply — file is created/updated and selected
3. Applied actions show `✓` checkmark
4. Preview updates automatically if auto-refresh is on

## 9. Starter API (Built-in Backend)

Your space has a complete backend available via `KozmosRuntime` in previews:

### Authentication
```javascript
// Register new user (scoped to your space)
await KozmosRuntime.auth.register("username", "password");

// Login
const result = await KozmosRuntime.auth.login("username", "password");
if (result.ok) console.log("Logged in:", result.data.username);

// Get current user
const me = await KozmosRuntime.auth.me();

// Logout
await KozmosRuntime.auth.logout();
```

### Posts (Social Feed)
```javascript
// List posts
const feed = await KozmosRuntime.posts.list(20, 0);  // limit, offset
feed.data.forEach(p => {
  console.log(p.authorUsername, p.body, p.createdAt, p.likesCount);
});

// Create post
await KozmosRuntime.posts.create("Hello world!");

// Like/unlike
await KozmosRuntime.posts.like(postId);
await KozmosRuntime.posts.unlike(postId);

// Delete own post
await KozmosRuntime.posts.delete(postId);
```

### Comments
```javascript
// List comments on a post
const comments = await KozmosRuntime.comments.list(postId, 20, 0);

// Add comment
await KozmosRuntime.comments.create(postId, "Great post!");

// Delete own comment
await KozmosRuntime.comments.delete(commentId);
```

### Direct Messages
```javascript
// List DM threads
const threads = await KozmosRuntime.dm.threads();

// Get messages in thread
const msgs = await KozmosRuntime.dm.messagesList(threadId, { limit: 20 });

// Send message
await KozmosRuntime.dm.messagesSend(threadId, "Hello!", { optional: "metadata" });
```

### Friends
```javascript
// List friends
const friends = await KozmosRuntime.friends.list();

// Add/remove friend
await KozmosRuntime.friends.add("username");
await KozmosRuntime.friends.remove("username");
```

### Response Format
All APIs return: `{ ok: boolean, data?: any, error?: string }`

### Important Notes
- Users are **scoped to your space** — not global Kozmos users.
- Publish room first to enable Starter Mode.
- All data (users, posts, etc.) is stored per-space.

## 10. Practical Workflow

### Simple App
1. Create `index.html` with inline CSS/JS (single file works best).
2. Save and preview.
3. Ask Axy: "add a dark theme toggle"
4. Apply Axy's changes with one click.

### Social App (Feed, Comments, etc.)
1. Ask Axy: "build a Twitter-style feed using Starter API"
2. Apply the generated `index.html`
3. Publish room to enable Starter Mode
4. Register/login in preview and test posting

### Game
1. Ask Axy: "make a snake game with canvas"
2. Apply and test in preview
3. Iterate: "add score display" or "make it faster"

### Iteration Tips
- Save and preview every small change.
- Commit to one feature at a time.
- Use Axy for debugging: "the like button doesn't work, here's my code..."
- Document key decisions in a README inside the subspace.

## 11. Common Issues

| Issue | Solution |
|-------|----------|
| Could not create subspace/file | Check session and permissions |
| Read-only subspace | Request owner to grant edit access |
| Preview empty | Ensure `index.html` exists |
| Publish failed | Verify selected space + edit rights, then retry |
| Starter API returns error | Run `publish room` to enable Starter Mode |
| "@anonim" author on posts | Use `p.authorUsername` (camelCase), not `p.author_username` |
| Apply button disabled | Check if you have edit permissions |
| Search not finding text | Search is case-insensitive; check spelling |

## 12. Best Practices

- **Single HTML file**: For simple apps, inline CSS/JS in one `index.html` works best in preview.
- **Use Axy**: Let Axy generate boilerplate, then customize.
- **Starter API**: Perfect for prototypes — no server setup needed.
- **Iterate small**: Build, test, refine. Don't write 500 lines before testing.
- **Read Axy's code**: Understand what it generates; don't blindly apply.
- **Version your work**: Keep old versions as `v1.html`, `v2.html` if needed.
