"use client";
import { useEffect } from "react";
import { SERVICE_WORKER_URL } from "@/lib/sw-url";

export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    navigator.serviceWorker
      .register(SERVICE_WORKER_URL, { updateViaCache: "none" })
      .then(registration => registration.update())
      .catch(console.error);

    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, []);

  return null;
}
