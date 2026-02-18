"use client";

import { useRouter } from "next/navigation";

const sections = [
  {
    title: "1. What User Build Is",
    items: [
      "User Build is your personal build environment inside Kozmos.",
      "You can create subspaces, add files, write code/content, preview output, and publish a room manifest for world placement.",
      "The owner controls visibility and edit permissions.",
    ],
  },
  {
    title: "2. Quick Start",
    items: [
      "Create a subspace from the left panel.",
      "Select the subspace, add a file path (e.g. index.html, styles.css, app.js).",
      "Open the file, write content, then click Save File.",
      "Use Outcome Preview to test instantly. If needed, click Refresh or Open Tab.",
    ],
  },
  {
    title: "3. Subspaces and Visibility",
    items: [
      "Each subspace is an isolated workspace with its own files.",
      "Owner can set Make Public / Make Private.",
      "Public means visible to others for read access; edit still requires permission.",
      "Deleting a subspace removes its files and cannot be undone.",
    ],
  },
  {
    title: "4. Files and Editor",
    items: [
      "Use normalized paths (e.g. src/main.ts, docs/readme.md).",
      "Use language selector to label file type for better structure and AI context.",
      "Delete Selected File permanently removes the file.",
      "If a subspace is read-only for you, editing actions are blocked.",
    ],
  },
  {
    title: "5. Collaboration (In-Touch Access)",
    items: [
      "Only the subspace owner can manage editor access.",
      "From In Touch Access: Allow Edit grants write rights, Revoke Edit removes them.",
      "Non-owners can still view public/shared content but cannot change files without edit rights.",
    ],
  },
  {
    title: "6. Publish Room",
    items: [
      "Publish Room writes/updates space.room.json in the selected subspace.",
      "Manifest carries room metadata (title, aura, visibility, entry mode, icon, spawn).",
      "Visibility changes also try to sync the room manifest automatically.",
      "If sync fails, run Publish Room again.",
    ],
  },
  {
    title: "7. Outcome Preview",
    items: [
      "Preview renders from your current files.",
      "Best result: include index.html as entry point, then optional .css/.js files.",
      "Auto On injects current editor changes without leaving the page.",
      "Open Tab creates a standalone preview window for larger testing.",
    ],
  },
  {
    title: "8. Builder Axy",
    items: [
      "Use Builder Axy for architecture, debugging, and implementation guidance.",
      "Provide clear prompts: goal, stack, constraints, and current file path.",
      "Ask for small, testable increments (v1 first, then iterate).",
      "Axy responses are guidance; you control final file changes.",
    ],
  },
  {
    title: "9. Practical Workflow",
    items: [
      "Start with a minimal structure: index.html + one style + one script.",
      "Save and preview every small change.",
      "Commit to one feature at a time (layout, then interaction, then polish).",
      "Document key decisions in a README inside the subspace.",
    ],
  },
  {
    title: "10. Common Issues",
    items: [
      "Could not create subspace/file: check session and permissions.",
      "Read-only subspace: request owner to grant edit access.",
      "Preview empty: ensure an HTML entry file exists (preferably index.html).",
      "Publish failed: verify selected space + edit rights, then retry.",
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
