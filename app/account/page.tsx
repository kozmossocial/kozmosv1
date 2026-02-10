import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export default async function AccountPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies,
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: 40,
        background: "#0b0b0b",
        color: "#eaeaea",
      }}
    >
      <h1 style={{ fontSize: 14, opacity: 0.6, marginBottom: 24 }}>
        account
      </h1>

      <div style={{ maxWidth: 420 }}>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, opacity: 0.5 }}>email</div>
          <div style={{ fontSize: 14 }}>{user.email}</div>
        </div>

        <form
          action="/auth/change-password"
          method="post"
        >
          <button
            type="submit"
            style={{
              fontSize: 13,
              opacity: 0.7,
              cursor: "pointer",
            }}
          >
            change password
          </button>
        </form>
      </div>
    </main>
  );
}
