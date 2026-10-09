export type ForecastConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
export type ForecastReason = "KM_USAGE" | "VISIT_PATTERN" | "CALENDAR_LIMIT";

export type VehicleOilForecast = {
  vehicle_id?: string;
  service_count: number | null;
  mileage_points: number | null;
  slope_pairs: number | null;
  odometer_regressions?: number | null;
  km_per_day: number | null;
  days_per_5000km: number | null;
  typical_visit_days: number | null;
  projected_km_due_date: string | null;
  projected_habit_due_date: string | null;
  calendar_due_date: string | null;
  forecast_confidence?: ForecastConfidence | null;
  confidence?: ForecastConfidence | null;
  due_reason: ForecastReason | null;
  recommended_due_date?: string | null;
};

export function confidenceForForecast(f: VehicleOilForecast): ForecastConfidence {
  return f.forecast_confidence ?? f.confidence ?? "INSUFFICIENT";
}

export function forecastConfidenceLabel(confidence: ForecastConfidence) {
  switch (confidence) {
    case "HIGH": return "Confianza alta";
    case "MEDIUM": return "Confianza media";
    case "LOW": return "Estimación preliminar";
    default: return "Sin datos suficientes";
  }
}

export function forecastReasonLabel(reason: ForecastReason | null) {
  switch (reason) {
    case "KM_USAGE": return "Por uso estimado del vehículo";
    case "VISIT_PATTERN": return "Por frecuencia habitual de cambios";
    default: return "Por límite de tiempo recomendado";
  }
}

export function forecastMethodNote(f: VehicleOilForecast): string {
  const count=Number(f.mileage_points??0);
  if (count >= 4 && confidenceForForecast(f)==="HIGH")
    return "Estimación robusta a partir de varios cambios de aceite del mismo carro.";
  if (count >= 3 && confidenceForForecast(f)==="MEDIUM")
    return "Estimación basada en varios registros; el uso del vehículo puede cambiar.";
  if (confidenceForForecast(f)==="LOW")
    return "Estimación preliminar: todavía hay pocos cambios de aceite con kilometraje confiable.";
  if (Number(f.service_count??0)>=2)
    return "Hay visitas previas, pero faltan lecturas consistentes de kilometraje para pronosticar los próximos 5.000 km.";
  return "El próximo mantenimiento se programa por calendario hasta registrar otro cambio de aceite con kilometraje.";
}

export function canMentionUsageForecast(f: VehicleOilForecast) {
  return confidenceForForecast(f)!=="INSUFFICIENT"
    && Number.isFinite(Number(f.km_per_day))
    && Number(f.km_per_day)>0
    && f.projected_km_due_date!==null;
}
