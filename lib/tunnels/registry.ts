import { demoTunnel } from "./demo";
import type { TunnelDefinition } from "./types";

// Adding a tunnel = adding its definition here (plus its action handlers in SQL). See docs/tunnels.md.

/** The demo tunnel never ships to production builds unless explicitly enabled. */
export const DEMO_ENABLED = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_TUNNEL_DEMO === "1";

const TUNNELS: readonly TunnelDefinition[] = [
  ...(DEMO_ENABLED ? [demoTunnel] : []),
];

export function listTunnels(): readonly TunnelDefinition[] { return TUNNELS; }

export function getTunnel(key: string): TunnelDefinition | null {
  return TUNNELS.find(t => t.key === key) || null;
}
