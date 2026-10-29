"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAppSession } from "@/components/app-session-context";
import { OsHome, type HomeBoardRow, type HomeDashboard as Dashboard } from "@/components/os-home";

const INITIAL: Dashboard = {
  localDate: "", closedOrdersToday: 0, salesRefToday: 0, collectedRefToday: 0,
  openOrders: 0, activeVehicles: 0, received: 0, diagnosis: 0, inProgress: 0,
  waitingParts: 0, ready: 0, postService: 0, maintenanceDue: 0, maintenanceSoon: 0,
  receivablesOpen: 0, receivablesOutstandingVes: 0, payrollPendingRef: 0,
  inventoryReview: 0, inventoryNegative: 0, bcv: 0, operative: 0,
};
export default function HomePage() {
  const { role, roleLoaded, locationName } = useAppSession();
  const owner = roleLoaded && (role === "OWNER" || role === "ADMIN");
  const [data, setData] = useState<Dashboard>(INITIAL);
  const [board, setBoard] = useState<HomeBoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    const [result, boardResult] = await Promise.all([
      supabase.rpc("dashboard_overview"),
      supabase.from("workshop_board_current")
        .select("id,order_number,workflow_status,workflow_updated_at,plate,make,model,is_walk_in,customer_name,service_areas")
        .order("workflow_updated_at", { ascending: true }).limit(80),
    ]);
    // Las placas del tablero son un adorno del inicio: si fallan, el resumen sigue.
    if (!boardResult.error) setBoard((boardResult.data ?? []) as HomeBoardRow[]);
    if (result.error) { setError(result.error.message); setLoading(false); return; }
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (row) setData({
      localDate: row.local_date ?? "",
      closedOrdersToday: Number(row.closed_orders_today ?? 0),
      salesRefToday: Number(row.sales_ref_today ?? 0),
      collectedRefToday: Number(row.collected_ref_today ?? 0),
      openOrders: Number(row.open_orders ?? 0),
      activeVehicles: Number(row.vehicles_active ?? row.active_vehicles ?? 0),
      received: Number(row.vehicles_received ?? 0),
      diagnosis: Number(row.vehicles_diagnosis ?? 0),
      inProgress: Number(row.vehicles_in_progress ?? 0),
      waitingParts: Number(row.vehicles_waiting_parts ?? 0),
      ready: Number(row.vehicles_ready ?? 0),
      postService: Number(row.post_service_action ?? 0),
      maintenanceDue: Number(row.maintenance_due ?? 0),
      maintenanceSoon: Number(row.maintenance_soon ?? 0),
      receivablesOpen: Number(row.receivables_open ?? 0),
      receivablesOutstandingVes: Number(row.receivables_outstanding_ves ?? 0),
      payrollPendingRef: Number(row.payroll_pending_ref ?? 0),
      inventoryReview: Number(row.inventory_review ?? 0),
      inventoryNegative: Number(row.inventory_negative ?? 0),
      bcv: Number(row.bcv_rate ?? 0),
      operative: Number(row.operative_rate ?? 0),
    });
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  return <OsHome data={data} board={board} owner={owner} locationName={locationName} loading={loading} error={error}
    onRefresh={() => void load()} />;
}
