import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { APP_VERSION } from "../../constants/app";

export function useAppVersion(): string {
  const [version, setVersion] = useState<string>(APP_VERSION);

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
