"use client";

import { useRouter } from "next/navigation";

const sections = [
  {
    title: "1. What User Build Is",
    items: [
      "User Build is Kozmos inside-Kozmos builder workspace for shipping runnable subspace artifacts.",
      "Main capabilities: subspace management, file editor, live preview, runtime APIs, room manifest publish, ZIP export, and Builder Axy assistance.",
      "Current page is desktop-first; mobile shows a not-available message.",
    ],
  },
  {
    title: "2. Quick Start",
    items: [
      "Create a subspace with title + class.",
      "Add `index.html` first, then optional `*.css` and `*.js` files.",
      "Save file, test in Outcome Preview, iterate in small steps.",
      "When stable: publish room manifest and export ZIP.",
    ],
  },
  {
    title: "3. Subspaces and Class System",
    items: [
      "Each subspace is isolated and has metadata: title, owner, class, visibility, editability, update time.",
      "Global class set: Utility, Web App, Game, Data Viz, Dashboard, Simulation, Social, 3D Space, Integration, Template, Experimental.",
      "Class is shown under subspace name and drives visual tone in lists/space UI.",
      "Subspace row also shows owner line (`by username`) and access state (`mine/public`, `editable`, `shared`, etc.).",
    ],
  },
  {
    title: "4. Ownership, Access, Visibility",
    items: [
      "Only owner can delete subspace, change public/private visibility, and manage editor permissions.",
      "Public subspace: readable by others; edit still needs `can_edit` access.",
      "Shared editable subspace: non-owner can edit files but still cannot run owner-only actions.",
      "Read-only subspaces block create/save/delete/publish-edit operations in UI.",
    ],
  },
  {
    title: "5. Files and Editor",
    items: [
      "Use normalized paths like `index.html`, `src/main.ts`, `docs/readme.md`.",
      "Language selector supports: text, html, css, js, ts, tsx, json, md, sql, py.",
      "`save file` persists current editor content; `delete selected file` is permanent.",
      "Editing panel shows mode label (`editable` or `read-only`).",
    ],
  },
  {
    title: "6. Collaboration (In-Touch Access)",
    items: [
      "Owner can grant/revoke edit rights from `in touch access` block.",
      "`allow edit` gives write access; `revoke edit` removes it.",
      "Legacy editors may appear as `legacy editors` if they are not in current in-touch list.",
      "Non-owner users cannot manage this list.",
    ],
  },
  {
    title: "7. Outcome Preview",
    items: [
      "Preview prioritizes `index.html`; if absent, first html file is used.",
      "All `*.css` files are injected as `<style>`, all `*.js` files as `<script>`.",
      "Auto mode previews unsaved in-editor changes; `refresh` forces iframe reload.",
      "`open tab` opens standalone preview for larger testing.",
      "If you see `No HTML entry found`, create/save `index.html` first.",
    ],
  },
  {
    title: "8. KozmosRuntime Bridge (Inside Preview)",
    items: [
      "Injected object: `window.KozmosRuntime` scoped to selected `spaceId` and active auth token.",
      "KV API: `kvGet`, `kvList`, `kvSet`, `kvDelete`.",
      "Network relay: `proxy(input)` via `/api/build/runtime/proxy` (allowlist/policy applies).",
      "Starter API namespace: `starter.auth`, `starter.mode`, `starter.posts`, `starter.comments`, `starter.likes`, `starter.dm`, `starter.friends`.",
    ],
  },
  {
    title: "9. Publish Room Manifest",
    items: [
      "`publish room` writes/updates `space.room.json` (legacy names are also recognized on read).",
      "Manifest is v2 and includes room metadata + runtime contract `kozmos.room.runtime.v1`.",
      "Runtime block includes hooks (`onEnter`, `onLeave`, `onTick`, `onMessage`), starter backend flags/endpoints, preview entry, and export path.",
      "Changing space visibility also attempts manifest visibility sync; if it fails, run `publish room` again.",
    ],
  },
  {
    title: "10. ZIP Export",
    items: [
      "`export zip` downloads whole selected subspace file tree.",
      "Only subspace owner can export (non-owner gets permission error).",
      "Export response includes `.kozmos/starter-data.json` snapshot for starter backend data portability.",
      "Use ZIP for external hosting, custom backend integration, or GitHub handoff.",
    ],
  },
  {
    title: "11. Builder Axy",
    items: [
      "Builder Axy chat is embedded in User Build and uses current selected space/file context.",
      "Use Axy for architecture/debugging/iteration prompts; keep asks concrete and scoped.",
      "Axy responses are assistive text; final file operations remain user-controlled.",
      "For runtime mission output, Axy also writes publish notes into build channels (runtime config dependent).",
    ],
  },
  {
    title: "12. Recommended Build Workflow",
    items: [
      "Define one user need + one target outcome before coding.",
      "Ship minimal runnable `index.html` first, then add behavior/data.",
      "Validate in preview on every save and keep README/API-CONTRACT current.",
      "Before sharing: set visibility, publish room manifest, export ZIP, and log what changed.",
    ],
  },
  {
    title: "13. Common Issues and Fixes",
    items: [
      "`could not create subspace/file`: check auth session and edit permission.",
      "`read-only subspace`: request owner access or switch to your own subspace.",
      "`zip export failed`: ensure you are the owner of the selected subspace.",
      "`preview fetch failed` in blob/about views: use runtime bridge calls inside User Build preview context.",
      "`publish failed`: verify selected subspace + permissions, then retry.",
    ],
  },
];

export default function BuildManualPage() {
  const router = useRouter();

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#060a07",
        color: "#eaeaea",
        padding: "20px 18px 28px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 14,
          opacity: 0.74,
          userSelect: "none",
        }}
      >
        <div>
          <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
            main
          </span>
          {" / "}
          <span style={{ cursor: "pointer" }} onClick={() => router.push("/build")}>
            user build
          </span>
          {" / "}
          <span style={{ cursor: "default" }}>manual</span>
        </div>
      </div>

      <section
        style={{
          marginTop: 14,
          border: "1px solid rgba(121,193,255,0.28)",
          borderRadius: 12,
          background: "rgba(6,14,22,0.56)",
          padding: 14,
          maxWidth: 980,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18, letterSpacing: "0.08em" }}>
          User Build Manual
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: 12, opacity: 0.76 }}>
          Practical instructions for building, collaborating, and publishing from Kozmos User Build.
        </p>
      </section>

      <div
        style={{
          marginTop: 12,
          display: "grid",
          gap: 10,
          maxWidth: 980,
        }}
      >
        {sections.map((section) => (
          <section
            key={section.title}
            style={{
              border: "1px solid rgba(108,255,150,0.22)",
              borderRadius: 10,
              background: "rgba(5,14,9,0.64)",
              padding: 12,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 13,
                letterSpacing: "0.06em",
                opacity: 0.92,
              }}
            >
              {section.title}
            </h2>
            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {section.items.map((item, idx) => (
                <div key={`${section.title}-${idx}`} style={{ fontSize: 12, opacity: 0.76 }}>
                  {idx + 1}. {item}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
