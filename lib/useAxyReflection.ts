"use client";

import { useState, useCallback, useRef } from "react";

export interface ReflectionState {
  [key: string]: string;
}

export interface UseAxyReflectionOptions {
  /** Animation duration for pulse effect in ms */
  pulseDuration?: number;
  /** Animation duration for fade effect in ms */
  fadeDuration?: number;
  /** API endpoint for reflection */
  endpoint?: string;
  /** Channel context for logging */
  channel?: "my-home" | "main" | "build";
}

export interface UseAxyReflectionReturn {
  /** Map of item ID to reflection text */
  reflections: ReflectionState;
  /** Currently pulsing item ID */
  pulseId: string | null;
  /** Currently fading item ID */
  fadeId: string | null;
  /** Request a reflection for an item */
  requestReflection: (itemId: string, content: string, contentType?: "note" | "message") => Promise<void>;
  /** Clear a specific reflection */
  clearReflection: (itemId: string) => void;
  /** Clear all reflections */
  clearAllReflections: () => void;
  /** Check if a reflection is loading */
  isLoading: (itemId: string) => boolean;
}

/**
 * Shared hook for Axy micro-reflections on notes and messages
 * Used in both my-home and main pages
 */
export function useAxyReflection(
  options: UseAxyReflectionOptions = {}
): UseAxyReflectionReturn {
  const {
    pulseDuration = 1800,
    fadeDuration = 12000,
    endpoint = "/api/axy",
    channel = "my-home",
  } = options;

  const [reflections, setReflections] = useState<ReflectionState>({});
  const [pulseId, setPulseId] = useState<string | null>(null);
  const [fadeId, setFadeId] = useState<string | null>(null);
  const loadingRef = useRef<Set<string>>(new Set());
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestReflection = useCallback(
    async (itemId: string, content: string, contentType: "note" | "message" = "note") => {
      // Skip if already loading or already has reflection
      if (loadingRef.current.has(itemId) || reflections[itemId]) {
        return;
      }

      // Skip empty content
      const trimmed = content.trim();
      if (!trimmed || trimmed.length < 3) {
        return;
      }

      loadingRef.current.add(itemId);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            mode: "reflect",
            context: {
              channel,
              contentType,
              itemId,
            },
          }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        const reply = data.reply || data.reflection || "";

        if (reply) {
          // Set the reflection
          setReflections((prev) => ({ ...prev, [itemId]: reply }));

          // Clear previous timers
          if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
          if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);

          // Start pulse animation
          setPulseId(itemId);
          setFadeId(null);

          // After pulse, start fade
          pulseTimerRef.current = setTimeout(() => {
            setPulseId(null);
            setFadeId(itemId);

            // After fade, clear
            fadeTimerRef.current = setTimeout(() => {
              setFadeId(null);
              setReflections((prev) => {
                const next = { ...prev };
                delete next[itemId];
                return next;
              });
            }, fadeDuration);
          }, pulseDuration);
        }
      } catch (err) {
        console.error("[useAxyReflection] Error:", err);
      } finally {
        loadingRef.current.delete(itemId);
      }
    },
    [endpoint, channel, reflections, pulseDuration, fadeDuration]
  );

  const clearReflection = useCallback((itemId: string) => {
    setReflections((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    if (pulseId === itemId) setPulseId(null);
    if (fadeId === itemId) setFadeId(null);
  }, [pulseId, fadeId]);

  const clearAllReflections = useCallback(() => {
    setReflections({});
    setPulseId(null);
    setFadeId(null);
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
  }, []);

  const isLoading = useCallback(
    (itemId: string) => loadingRef.current.has(itemId),
    []
  );

  return {
    reflections,
    pulseId,
    fadeId,
    requestReflection,
    clearReflection,
    clearAllReflections,
    isLoading,
  };
}

/**
 * CSS classes helper for reflection animations
 */
export function getReflectionClasses(
  itemId: string,
  pulseId: string | null,
  fadeId: string | null
): string {
  const classes: string[] = ["axy-reflection"];
  
  if (pulseId === itemId) {
    classes.push("axy-reflection-pulse");
  }
  
  if (fadeId === itemId) {
    classes.push("axy-reflection-fade");
  }
  
  return classes.join(" ");
}

/**
 * Default CSS for reflections (inject into globals.css or use directly)
 */
export const REFLECTION_CSS = `
.axy-reflection {
  font-size: 0.75rem;
  color: #888;
  font-style: italic;
  margin-top: 4px;
  transition: opacity 0.3s ease;
}

.axy-reflection-pulse {
  animation: axy-pulse 1.8s ease-in-out;
}

.axy-reflection-fade {
  animation: axy-fade 12s ease-out forwards;
}

@keyframes axy-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

@keyframes axy-fade {
  0% { opacity: 1; }
  70% { opacity: 0.8; }
  100% { opacity: 0; }
}
`;
