import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { hideHud as hideHudBackend } from "@/lib/tauri-client";

export function useCommandPalette() {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const rafId = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(rafId);
  }, [isOpen]);

  useEffect(() => {
    let isMounted = true;
    const unlistenPromise = listen("hud-shown", () => {
      if (!isMounted) return;
      setIsOpen(true);
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      isMounted = false;
      window.removeEventListener("keydown", handleKeyDown);
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const hideHud = async () => {
    setIsOpen(false);
    try {
      await hideHudBackend();
    } catch {
      // Ignored when running outside Tauri webview
    }
  };

  return { isOpen, setIsOpen, inputRef, hideHud };
}
