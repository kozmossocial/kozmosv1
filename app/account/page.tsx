"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import {
  getMyHomeAttentionPending,
  refreshMyHomeAttention,
} from "@/lib/myHomeAttention";

const CROP_PREVIEW_SIZE = 220;
const AVATAR_OUTPUT_SIZE = 1024;

export default function AccountPage() {
  const router = useRouter();

  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [username, setUsername] = useState("user");
  const [spiceBalance, setSpiceBalance] = useState(0);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const [avatarInputKey, setAvatarInputKey] = useState(0);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordChangeVerificationCode, setPasswordChangeVerificationCode] = useState("");
  const [passwordChangeCodeBusy, setPasswordChangeCodeBusy] = useState(false);
  const [passwordChangeCodeSent, setPasswordChangeCodeSent] = useState(false);
  const [inTouchUsers, setInTouchUsers] = useState<Array<{ id: string; username: string }>>(
    []
  );
  const [showTransferSection, setShowTransferSection] = useState(false);
  const [transferTargetUserId, setTransferTargetUserId] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [deleteEmailConfirm, setDeleteEmailConfirm] = useState("");
  const [deleteVerificationCode, setDeleteVerificationCode] = useState("");
  const [deleteCodeBusy, setDeleteCodeBusy] = useState(false);
  const [deleteCodeSent, setDeleteCodeSent] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [showDeleteSection, setShowDeleteSection] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropSourceUrl, setCropSourceUrl] = useState<string | null>(null);
  const [cropNaturalSize, setCropNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [cropScale, setCropScale] = useState(1);
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const [myHomeAttentionPending, setMyHomeAttentionPending] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadAccount = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.replace("/login");
        return;
      }

      setUserId(user.id);
      setEmail(user.email ?? null);

      const { data } = await supabase
        .from("profileskozmos")
        .select("*")
        .eq("id", user.id)
        .maybeSingle();

      const dbUsername =
        typeof data?.username === "string" ? data.username.trim() : "";
      setUsername(dbUsername || "user");
      setAvatarUrl(
        typeof data?.avatar_url === "string" ? data.avatar_url : null
      );

      const { data: wallet } = await supabase
        .from("spice_wallets")
        .select("balance")
        .eq("user_id", user.id)
        .maybeSingle();

      const rawBalance = (wallet as { balance?: number | string } | null)?.balance;
      const parsedBalance =
        typeof rawBalance === "number" ? rawBalance : Number(rawBalance ?? 0);
      setSpiceBalance(Number.isFinite(parsedBalance) ? parsedBalance : 0);

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session?.access_token) {
        const touchRes = await fetch("/api/keep-in-touch", {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });
        const touchBody = (await touchRes.json().catch(() => ({}))) as {
          inTouch?: Array<{ id?: string; username?: string }>;
        };

        if (touchRes.ok) {
          const nextUsers = (touchBody.inTouch || [])
            .map((row) => ({
              id: String(row.id || "").trim(),
              username: String(row.username || "").trim(),
            }))
            .filter((row) => row.id && row.username);

          setInTouchUsers(nextUsers);
        }
      }

      setLoading(false);
    };

    loadAccount();
  }, [router]);

  useEffect(() => {
    if (inTouchUsers.length === 0) {
      setTransferTargetUserId("");
      return;
    }

    setTransferTargetUserId((prev) => {
      if (prev && inTouchUsers.some((row) => row.id === prev)) {
        return prev;
      }
      return inTouchUsers[0].id;
    });
  }, [inTouchUsers]);

  useEffect(() => {
    if (!userId) return;

    setMyHomeAttentionPending(getMyHomeAttentionPending(userId));

    let cancelled = false;

    const checkAttention = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token || cancelled) return;
      const nextPending = await refreshMyHomeAttention(userId, session.access_token);
      if (!cancelled) {
        setMyHomeAttentionPending(nextPending);
      }
    };

    void checkAttention();
    const poll = window.setInterval(() => {
      void checkAttention();
    }, 12000);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [userId]);

  useEffect(() => {
    return () => {
      if (cropSourceUrl) {
        URL.revokeObjectURL(cropSourceUrl);
      }
    };
  }, [cropSourceUrl]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/");
  }

  async function handleAvatarUpload(file: File | null) {
    if (!file || !userId || avatarBusy) return false;
    setAvatarBusy(true);
    setAvatarMessage(null);

    if (!file.type.startsWith("image/")) {
      setAvatarMessage("please choose an image file");
      setAvatarBusy(false);
      setAvatarInputKey((prev) => prev + 1);
      return false;
    }

    const normalizedAvatar = await normalizeAvatarFile(file, {
      scale: cropScale,
      x: cropX,
      y: cropY,
      naturalSize: cropNaturalSize,
    });

    const uploadFile = normalizedAvatar ?? file;
    const uploadContentType = normalizedAvatar
      ? "image/jpeg"
      : file.type || "application/octet-stream";
    const uploadExtension = normalizedAvatar
      ? "jpg"
      : inferUploadExtension(file.name, uploadContentType);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setAvatarMessage("session missing, please login again");
      setAvatarBusy(false);
      setAvatarInputKey((prev) => prev + 1);
      return false;
    }

    const formData = new FormData();
    formData.append(
      "file",
      uploadFile,
      `avatar.${uploadExtension}`
    );
    formData.append("contentType", uploadContentType);

    const res = await fetch("/api/account/avatar", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      body: formData,
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      avatarUrl?: string;
    };

    if (!res.ok || !body.avatarUrl) {
      setAvatarMessage(`upload failed: ${body.error ?? "request failed"}`);
      setAvatarBusy(false);
      setAvatarInputKey((prev) => prev + 1);
      return false;
    }

    setAvatarUrl(body.avatarUrl);
    setAvatarMessage(
      normalizedAvatar ? "avatar updated" : "avatar updated (original format)"
    );
    setAvatarBusy(false);
    setAvatarInputKey((prev) => prev + 1);
    return true;
  }

  async function handleAvatarPick(file: File | null) {
    if (!file || avatarBusy) return;
    setAvatarMessage(null);

    if (!file.type.startsWith("image/")) {
      setAvatarMessage("please choose an image file");
      setAvatarInputKey((prev) => prev + 1);
      return;
    }

    if (cropSourceUrl) {
      URL.revokeObjectURL(cropSourceUrl);
    }

    const sourceUrl = URL.createObjectURL(file);
    setCropFile(file);
    setCropSourceUrl(sourceUrl);
    setCropScale(1);
    setCropX(0);
    setCropY(0);
    setCropNaturalSize(null);
    setCropOpen(true);
    setAvatarInputKey((prev) => prev + 1);

    const natural = await readImageSize(sourceUrl);
    if (natural) {
      setCropNaturalSize(natural);
    }
  }

  function closeCropper() {
    if (cropSourceUrl) {
      URL.revokeObjectURL(cropSourceUrl);
    }
    setCropOpen(false);
    setCropFile(null);
    setCropSourceUrl(null);
    setCropNaturalSize(null);
    setCropScale(1);
    setCropX(0);
    setCropY(0);
    dragRef.current = null;
  }

  async function applyCropAndUpload() {
    if (!cropFile) {
      setAvatarMessage("no photo selected");
      return;
    }
    const uploaded = await handleAvatarUpload(cropFile);
    if (uploaded) {
      closeCropper();
    }
  }

  function updateCropPosition(nextX: number, nextY: number, scale = cropScale) {
    const clamped = clampCropPosition({
      x: nextX,
      y: nextY,
      scale,
      naturalSize: cropNaturalSize,
      frameSize: CROP_PREVIEW_SIZE,
    });
    setCropX(clamped.x);
    setCropY(clamped.y);
  }

  function onCropPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!cropSourceUrl || avatarBusy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: cropX,
      originY: cropY,
    };
  }

  function onCropPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    updateCropPosition(drag.originX + deltaX, drag.originY + deltaY);
  }

  function onCropPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  async function handleRemoveAvatar() {
    if (!userId || avatarBusy) return;
    setAvatarBusy(true);
    setAvatarMessage(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setAvatarMessage("session missing, please login again");
      setAvatarBusy(false);
      return;
    }

    const res = await fetch("/api/account/avatar", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      ok?: boolean;
    };

    if (!res.ok || !body.ok) {
      setAvatarMessage(`could not remove avatar: ${body.error ?? "failed"}`);
      setAvatarBusy(false);
      return;
    }

    setAvatarUrl(null);
    setAvatarMessage("avatar removed");
    setAvatarBusy(false);
  }

  async function handleSendPasswordChangeCode() {
    if (passwordChangeCodeBusy || passwordBusy) return;
    setPasswordChangeCodeBusy(true);
    setPasswordMessage(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setPasswordMessage("session missing, please login again");
      setPasswordChangeCodeBusy(false);
      return;
    }

    const res = await fetch("/api/account/password/code", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
    if (!res.ok || !body.ok) {
      setPasswordMessage(body.error || "code send failed");
      setPasswordChangeCodeBusy(false);
      return;
    }

    setPasswordChangeCodeSent(true);
    setPasswordMessage("verification code sent to your email");
    setPasswordChangeCodeBusy(false);
  }

  async function handleChangePassword() {
    const nextPassword = newPassword.trim();
    if (passwordBusy) return;

    if (!nextPassword) {
      setPasswordMessage("enter new password");
      return;
    }

    if (nextPassword.length < 8) {
      setPasswordMessage("password must be at least 8 characters");
      return;
    }

    if (nextPassword !== confirmPassword.trim()) {
      setPasswordMessage("passwords do not match");
      return;
    }

    if (!/^\d{6}$/.test(passwordChangeVerificationCode.trim())) {
      setPasswordMessage("enter 6-digit verification code");
      return;
    }

    setPasswordBusy(true);
    setPasswordMessage(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setPasswordMessage("session missing, please login again");
      setPasswordBusy(false);
      return;
    }

    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        newPassword: nextPassword,
        verificationCode: passwordChangeVerificationCode.trim(),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };

    if (!res.ok || !body.ok) {
      setPasswordMessage(body.error || "password change failed");
      setPasswordBusy(false);
      return;
    }

    setNewPassword("");
    setConfirmPassword("");
    setPasswordChangeVerificationCode("");
    setPasswordChangeCodeSent(false);
    setPasswordMessage("password updated");
    setPasswordBusy(false);
  }

  async function handleDeleteAccount() {
    const emailValue = String(email || "").trim().toLowerCase();
    const confirmValue = deleteEmailConfirm.trim().toLowerCase();
    if (deleteBusy) return;
    if (!emailValue) {
      setDeleteMessage("account email unavailable");
      return;
    }
    if (!confirmValue) {
      setDeleteMessage("type your email to confirm");
      return;
    }
    if (confirmValue !== emailValue) {
      setDeleteMessage("email confirm mismatch");
      return;
    }
    if (!/^\d{6}$/.test(deleteVerificationCode.trim())) {
      setDeleteMessage("enter 6-digit verification code");
      return;
    }

    const sure = window.confirm(
      "This will permanently delete your account and data. Continue?"
    );
    if (!sure) return;

    setDeleteBusy(true);
    setDeleteMessage(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setDeleteMessage("session missing, please login again");
      setDeleteBusy(false);
      return;
    }

    const res = await fetch("/api/account/delete", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        emailConfirm: deleteEmailConfirm.trim(),
        verificationCode: deleteVerificationCode.trim(),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };

    if (!res.ok || !body.ok) {
      setDeleteMessage(body.error || "account delete failed");
      setDeleteBusy(false);
      return;
    }

    await supabase.auth.signOut({ scope: "local" });
    router.replace("/login");
  }

  async function handleTransferSpc() {
    if (transferBusy) return;

    const amountValue = Number(transferAmount);
    if (!transferTargetUserId) {
      setTransferMessage("select an in touch user");
      return;
    }
    if (!Number.isInteger(amountValue) || amountValue <= 0) {
      setTransferMessage("enter a positive SPC amount");
      return;
    }
    if (amountValue > spiceBalance) {
      setTransferMessage("insufficient SPC balance");
      return;
    }

    setTransferBusy(true);
    setTransferMessage(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      setTransferMessage("session missing, please login again");
      setTransferBusy(false);
      return;
    }

    const res = await fetch("/api/spice/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetUserId: transferTargetUserId,
        amount: amountValue,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      ok?: boolean;
      balance?: number;
    };

    if (!res.ok || !body.ok) {
      setTransferMessage(body.error || "SPC transfer failed");
      setTransferBusy(false);
      return;
    }

    const targetUsername =
      inTouchUsers.find((row) => row.id === transferTargetUserId)?.username || "user";

    if (typeof body.balance === "number" && Number.isFinite(body.balance)) {
      setSpiceBalance(body.balance);
    } else {
      setSpiceBalance((prev) => Math.max(0, prev - amountValue));
    }

    setTransferAmount("");
    setTransferMessage(`sent ${amountValue.toLocaleString("en-US")} SPC to ${targetUsername}`);
    setTransferBusy(false);
  }

  async function handleSendDeleteCode() {
    if (deleteCodeBusy || deleteBusy) return;
    setDeleteCodeBusy(true);
    setDeleteMessage(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setDeleteMessage("session missing, please login again");
      setDeleteCodeBusy(false);
      return;
    }

    const res = await fetch("/api/account/delete/code", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
    if (!res.ok || !body.ok) {
      setDeleteMessage(body.error || "code send failed");
      setDeleteCodeBusy(false);
      return;
    }

    setDeleteCodeSent(true);
    setDeleteMessage("verification code sent to your email");
    setDeleteCodeBusy(false);
  }

  async function normalizeAvatarFile(
    file: File,
    crop: {
      scale: number;
      x: number;
      y: number;
      naturalSize: { width: number; height: number } | null;
    }
  ) {
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("image decode failed"));
        img.src = objectUrl;
      });

      const naturalSize = crop.naturalSize ?? {
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
      const previewClamped = clampCropPosition({
        x: crop.x,
        y: crop.y,
        scale: crop.scale,
        naturalSize,
        frameSize: CROP_PREVIEW_SIZE,
      });
      const outputX = previewClamped.x * (AVATAR_OUTPUT_SIZE / CROP_PREVIEW_SIZE);
      const outputY = previewClamped.y * (AVATAR_OUTPUT_SIZE / CROP_PREVIEW_SIZE);

      const targetSizes = [AVATAR_OUTPUT_SIZE, 768, 640, 512];
      const qualitySteps = [0.92, 0.84, 0.76, 0.68];
      const maxBytes = 1_600_000;
      let bestBlob: Blob | null = null;

      for (const size of targetSizes) {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;

        const ctx = canvas.getContext("2d");
        if (!ctx) continue;

        const cover = getCoverSize(naturalSize.width, naturalSize.height, size);
        const scaledWidth = cover.width * crop.scale;
        const scaledHeight = cover.height * crop.scale;
        const relativeFactor = size / AVATAR_OUTPUT_SIZE;
        const dx = (size - scaledWidth) / 2 + outputX * relativeFactor;
        const dy = (size - scaledHeight) / 2 + outputY * relativeFactor;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.fillStyle = "#0b0b0b";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(image, dx, dy, scaledWidth, scaledHeight);

        for (const quality of qualitySteps) {
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", quality)
          );
          if (!blob) continue;
          if (!bestBlob || blob.size < bestBlob.size) {
            bestBlob = blob;
          }
          if (blob.size <= maxBytes) {
            return new File([blob], "avatar.jpg", { type: "image/jpeg" });
          }
        }
      }

      if (bestBlob) {
        return new File([bestBlob], "avatar.jpg", { type: "image/jpeg" });
      }

      return null;
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  if (loading) {
    return null;
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        padding: "200px 40px 80px 300px",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <a
        href="/"
        aria-label="Kozmos"
        className="mother-logo-simple-anchor"
        style={{
          position: "absolute",
          top: 32,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 30,
          display: "block",
        }}
      >
        <Image
          src="/kozmos-logomother.png"
          alt="Kozmos"
          width={80}
          height={60}
          className="mother-logo-simple-image"
          style={{
            display: "block",
          }}
        />
      </a>

      {/* TOP LEFT NAV */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          fontSize: 12,
          opacity: 0.6,
          letterSpacing: "0.12em",
          cursor: "default",
          userSelect: "none",
        }}
      >
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.push("/main")}
        >
          main
        </span>{" "}
        /{" "}
        <span
          className={myHomeAttentionPending ? "my-home-attention-glow" : undefined}
          style={{ cursor: "pointer" }}
          onClick={() => router.push("/my-home")}
        >
          my home
        </span>
      </div>

      {/* TOP RIGHT NAV */}
      <div
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          fontSize: 12,
          opacity: 0.6,
          letterSpacing: "0.12em",
          cursor: "default",
          userSelect: "none",
        }}
      >
        <span style={{ opacity: 0.8 }}>{username}</span>
        {" "}
        /
        {" "}
        <span
          style={{ cursor: "pointer", opacity: 0.6 }}
          onClick={handleLogout}
        >
          logout
        </span>
      </div>

      {/* CONTENT */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 40,
          maxWidth: 420,
          width: "100%",
          margin: "0 auto",
        }}
        className="account-content-grid"
      >
        <div style={{ marginBottom: 36 }}>
          <div style={label}>profile picture</div>
          <div style={avatarRow}>
            <div style={avatarCircle}>
              {avatarUrl ? (
                <img src={avatarUrl} alt="profile" style={avatarImage} />
              ) : (
                <span style={avatarFallback}>
                  {(username[0] ?? "?").toUpperCase()}
                </span>
              )}
            </div>

            <div style={avatarActionsWrap}>
              <label style={avatarActionButton}>
                {avatarBusy ? "uploading..." : "upload photo"}
                <input
                  key={avatarInputKey}
                  type="file"
                  accept="image/*"
                  onChange={(event) =>
                    handleAvatarPick(event.target.files?.[0] ?? null)
                  }
                  style={{ display: "none" }}
                  disabled={avatarBusy}
                />
              </label>

              <button
                type="button"
                style={{
                  ...avatarActionButton,
                  opacity: avatarUrl && !avatarBusy ? 1 : 0.45,
                  cursor: avatarUrl && !avatarBusy ? "pointer" : "default",
                }}
                onClick={handleRemoveAvatar}
                disabled={!avatarUrl || avatarBusy}
              >
                remove
              </button>
            </div>
          </div>

          {avatarMessage ? (
            <div style={avatarMessageStyle}>{avatarMessage}</div>
          ) : null}
        </div>

        <div style={{ marginBottom: 2 }}>
          <div style={label}>username</div>
          <div>{username}</div>
        </div>

        <div style={{ marginBottom: 2 }}>
          <div style={label}>email</div>
          <div>{email}</div>
        </div>

        <div style={{ marginBottom: 2 }}>
          <div style={label}>spice</div>
          <div>{spiceBalance.toLocaleString("en-US")} SPC</div>
        </div>

        <div style={{ marginBottom: 2 }}>
          <div
            style={{
              ...label,
              cursor: "pointer",
              opacity: 0.7,
              userSelect: "none",
              transition: "none",
            }}
            onClick={() => setShowTransferSection((prev) => !prev)}
          >
            send spice
          </div>
          {showTransferSection ? (
            <>
              {inTouchUsers.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.66 }}>no in touch users</div>
              ) : (
                <>
                  <select
                    value={transferTargetUserId}
                    onChange={(event) => setTransferTargetUserId(event.target.value)}
                    style={{ ...passwordInput, background: "#0b0b0b" }}
                    disabled={transferBusy}
                  >
                    {inTouchUsers.map((row) => (
                      <option
                        key={row.id}
                        value={row.id}
                        style={{ background: "#0b0b0b", color: "#eaeaea" }}
                      >
                        {row.username}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={transferAmount}
                    onChange={(event) =>
                      setTransferAmount(
                        event.target.value.replace(/[^0-9]/g, "").slice(0, 12)
                      )
                    }
                    placeholder="SPC amount"
                    style={{ ...passwordInput, marginTop: 10 }}
                    disabled={transferBusy}
                  />
                  <button
                    type="button"
                    onClick={handleTransferSpc}
                    disabled={transferBusy}
                    style={{
                      ...avatarActionButton,
                      marginTop: 10,
                      minWidth: 130,
                      opacity: transferBusy ? 0.5 : 0.9,
                      cursor: transferBusy ? "default" : "pointer",
                    }}
                  >
                    {transferBusy ? "sending..." : "send"}
                  </button>
                </>
              )}

              {transferMessage ? (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 12,
                    opacity: 0.72,
                    color: transferMessage.startsWith("sent")
                      ? "#b8ffd1"
                      : "#ff9d9d",
                  }}
                >
                  {transferMessage}
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div style={{ marginBottom: 2 }}>
          <div
            style={{
              ...label,
              cursor: "pointer",
              opacity: 0.7,
              userSelect: "none",
              transition: "none",
            }}
            onClick={() => setShowPasswordSection(!showPasswordSection)}
          >
            change password
          </div>
          {showPasswordSection && (
            <>
              <div style={{ fontSize: 12, opacity: 0.66, marginBottom: 8 }}>
                confirm with a verification code sent to your email
              </div>
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="new password"
                style={passwordInput}
                disabled={passwordBusy}
              />
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="confirm new password"
                style={{ ...passwordInput, marginTop: 10 }}
                disabled={passwordBusy}
              />
              <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={handleSendPasswordChangeCode}
                  disabled={passwordChangeCodeBusy || passwordBusy}
                  style={{
                    ...avatarActionButton,
                    minWidth: 140,
                    opacity: passwordChangeCodeBusy || passwordBusy ? 0.5 : 0.9,
                    cursor: passwordChangeCodeBusy || passwordBusy ? "default" : "pointer",
                  }}
                >
                  {passwordChangeCodeBusy ? "sending..." : "send code"}
                </button>
                {passwordChangeCodeSent ? (
                  <span style={{ fontSize: 12, opacity: 0.66 }}>code sent</span>
                ) : null}
              </div>
              <input
                type="text"
                inputMode="numeric"
                value={passwordChangeVerificationCode}
                onChange={(event) =>
                  setPasswordChangeVerificationCode(
                    event.target.value.replace(/[^0-9]/g, "").slice(0, 6)
                  )
                }
                placeholder="6-digit verification code"
                style={{ ...passwordInput, marginTop: 10, letterSpacing: "0.24em" }}
                disabled={passwordBusy}
              />
              <button
                type="button"
                onClick={handleChangePassword}
                disabled={passwordBusy}
                style={{
                  ...avatarActionButton,
                  marginTop: 10,
                  opacity: passwordBusy ? 0.5 : 0.9,
                  cursor: passwordBusy ? "default" : "pointer",
                  minWidth: 140,
                }}
              >
                {passwordBusy ? "saving..." : "save password"}
              </button>
              {passwordMessage ? (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 12,
                    opacity: 0.72,
                    color: passwordMessage.includes("updated")
                      ? "#b8ffd1"
                      : "#ff9d9d",
                  }}
                >
                  {passwordMessage}
                </div>
              ) : null}
            </>
          )}
        </div>

        <div
          style={{
            marginBottom: -16,
            paddingTop: 0,
          }}
        >
          <div
            style={{
              ...label,
              color: "#ffb3b3",
              opacity: 0.86,
              cursor: "pointer",
              userSelect: "none",
              transition: "none",
            }}
            onClick={() => setShowDeleteSection(!showDeleteSection)}
          >
            delete account
          </div>
          {showDeleteSection && (
            <>
              <div style={{ fontSize: 12, opacity: 0.66, marginBottom: 8 }}>
                confirm by typing your email and verification code
              </div>
              <input
                type="email"
                value={deleteEmailConfirm}
                onChange={(event) => setDeleteEmailConfirm(event.target.value)}
                placeholder="type your email"
                autoComplete="off"
                style={passwordInput}
                disabled={deleteBusy}
              />
              <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={handleSendDeleteCode}
                  disabled={deleteCodeBusy || deleteBusy}
                  style={{
                    ...avatarActionButton,
                    minWidth: 140,
                    opacity: deleteCodeBusy || deleteBusy ? 0.5 : 0.9,
                    cursor: deleteCodeBusy || deleteBusy ? "default" : "pointer",
                  }}
                >
                  {deleteCodeBusy ? "sending..." : "send code"}
                </button>
                {deleteCodeSent ? (
                  <span style={{ fontSize: 12, opacity: 0.66 }}>code sent</span>
                ) : null}
              </div>
              <input
                type="text"
                inputMode="numeric"
                value={deleteVerificationCode}
                onChange={(event) =>
                  setDeleteVerificationCode(
                    event.target.value.replace(/[^0-9]/g, "").slice(0, 6)
                  )
                }
                placeholder="6-digit verification code"
                style={{ ...passwordInput, marginTop: 10, letterSpacing: "0.24em" }}
                disabled={deleteBusy}
              />
              <button
                type="button"
                onClick={handleDeleteAccount}
                disabled={deleteBusy}
                style={{
                  ...avatarActionButton,
                  marginTop: 10,
                  minWidth: 170,
                  border: "1px solid rgba(255,120,120,0.46)",
                  color: "#ffd2d2",
                  opacity: deleteBusy ? 0.5 : 0.92,
                  cursor: deleteBusy ? "default" : "pointer",
                }}
              >
                {deleteBusy ? "deleting..." : "delete account"}
              </button>
              {deleteMessage ? (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 12,
                    opacity: 0.74,
                    color: "#ffb3b3",
                  }}
                >
                  {deleteMessage}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {cropOpen && cropSourceUrl ? (
        <div style={cropOverlay}>
          <div style={cropDialog}>
            <div style={label}>adjust photo</div>

            <div
              style={cropPreview}
              onPointerDown={onCropPointerDown}
              onPointerMove={onCropPointerMove}
              onPointerUp={onCropPointerUp}
              onPointerCancel={onCropPointerUp}
            >
              <img
                src={cropSourceUrl}
                alt="crop preview"
                draggable={false}
                style={getCropImageStyle({
                  x: cropX,
                  y: cropY,
                  scale: cropScale,
                })}
              />
            </div>

            <div style={cropHint}>
              drag to move, zoom to fit the circular frame
            </div>

            {avatarMessage ? (
              <div style={{ ...cropHint, marginTop: 8 }}>{avatarMessage}</div>
            ) : null}

            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={cropScale}
              onChange={(event) => {
                const nextScale = Number(event.target.value);
                setCropScale(nextScale);
                updateCropPosition(cropX, cropY, nextScale);
              }}
              style={cropRange}
            />

            <div style={cropActions}>
              <button
                type="button"
                style={cropButton}
                onClick={closeCropper}
                disabled={avatarBusy}
              >
                cancel
              </button>
              <button
                type="button"
                style={cropButton}
                onClick={applyCropAndUpload}
                disabled={avatarBusy}
              >
                {avatarBusy ? "saving..." : "save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

async function readImageSize(url: string) {
  return new Promise<{ width: number; height: number } | null>((resolve) => {
    const image = new window.Image();
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function inferUploadExtension(fileName: string, contentType: string) {
  const nameExt = fileName.split(".").pop()?.toLowerCase() ?? "";
  const cleanNameExt = nameExt.replace(/[^a-z0-9]/g, "");
  if (cleanNameExt) return cleanNameExt;

  const fromMime = contentType.split("/")[1]?.toLowerCase() ?? "";
  const cleanMimeExt = fromMime.replace(/[^a-z0-9]/g, "");
  return cleanMimeExt || "bin";
}

function getCoverSize(imageWidth: number, imageHeight: number, frameSize: number) {
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { width: frameSize, height: frameSize };
  }
  const imageRatio = imageWidth / imageHeight;
  if (imageRatio >= 1) {
    return { width: frameSize * imageRatio, height: frameSize };
  }
  return { width: frameSize, height: frameSize / imageRatio };
}

function clampCropPosition({
  x,
  y,
  scale,
  naturalSize,
  frameSize,
}: {
  x: number;
  y: number;
  scale: number;
  naturalSize: { width: number; height: number } | null;
  frameSize: number;
}) {
  if (!naturalSize) return { x, y };

  const cover = getCoverSize(naturalSize.width, naturalSize.height, frameSize);
  const scaledWidth = cover.width * scale;
  const scaledHeight = cover.height * scale;
  const maxX = Math.max(0, (scaledWidth - frameSize) / 2);
  const maxY = Math.max(0, (scaledHeight - frameSize) / 2);

  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

function getCropImageStyle({
  x,
  y,
  scale,
}: {
  x: number;
  y: number;
  scale: number;
}) {
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${scale})`,
    transformOrigin: "center center",
    userSelect: "none",
    pointerEvents: "none",
  } as React.CSSProperties;
}

const label: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.5,
  letterSpacing: "0.12em",
  marginBottom: 6,
};

const action: React.CSSProperties = {
  fontSize: 13,
  opacity: 0.7,
  cursor: "pointer",
};

const avatarRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
};

const avatarCircle: React.CSSProperties = {
  width: 88,
  height: 88,
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,0.28)",
  overflow: "hidden",
  background: "rgba(255,255,255,0.05)",
  display: "grid",
  placeItems: "center",
};

const avatarImage: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

const avatarFallback: React.CSSProperties = {
  fontSize: 24,
  opacity: 0.72,
};

const avatarActionsWrap: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const avatarActionButton: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.2)",
  background: "transparent",
  color: "#eaeaea",
  padding: "7px 10px",
  borderRadius: 999,
  fontSize: 12,
  letterSpacing: "0.07em",
  opacity: 0.9,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 112,
};

const avatarMessageStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  opacity: 0.68,
};

const passwordInput: React.CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.2)",
  background: "transparent",
  color: "#eaeaea",
  borderRadius: 8,
  padding: "9px 11px",
  fontSize: 12,
  outline: "none",
};

const cropOverlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.72)",
  display: "grid",
  placeItems: "center",
  zIndex: 60,
  padding: 20,
};

const cropDialog: React.CSSProperties = {
  width: "min(420px, 100%)",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 16,
  background: "rgba(11,11,11,0.96)",
  padding: 18,
};

const cropPreview: React.CSSProperties = {
  width: CROP_PREVIEW_SIZE,
  height: CROP_PREVIEW_SIZE,
  borderRadius: "50%",
  overflow: "hidden",
  border: "1px solid rgba(255,255,255,0.3)",
  position: "relative",
  margin: "8px auto 0",
  background: "rgba(255,255,255,0.06)",
  touchAction: "none",
  cursor: "grab",
};

const cropHint: React.CSSProperties = {
  marginTop: 10,
  textAlign: "center",
  fontSize: 12,
  opacity: 0.68,
};

const cropRange: React.CSSProperties = {
  width: "100%",
  marginTop: 14,
};

const cropActions: React.CSSProperties = {
  marginTop: 14,
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const cropButton: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.26)",
  background: "transparent",
  color: "#eaeaea",
  borderRadius: 999,
  padding: "7px 12px",
  fontSize: 12,
  cursor: "pointer",
};



