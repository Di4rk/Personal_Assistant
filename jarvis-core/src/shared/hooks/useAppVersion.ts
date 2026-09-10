import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";

export function useAppVersion(): string {
  const [version, setVersion] = useState<string>("v0.3.3");

  useEffect(() => {
    let isMounted = true;
    getVersion()
      .then((ver) => {
        if (isMounted) setVersion(`v${ver}`);
      })
      .catch((err) => {
        console.warn("Failed to read runtime version via Tauri IPC, falling back:", err);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  return version;
}
