"use client";

import { OsIcon } from "@/components/os-icon";
import {
  confidenceForForecast, forecastConfidenceLabel, forecastMethodNote, forecastReasonLabel,
  type VehicleOilForecast
} from "@/lib/oil-forecast";

function fmtDate(value:string|null|undefined){
  if(!value)return "—";
  return new Date(value+"T12:00:00").toLocaleDateString("es-VE",{day:"2-digit",month:"short",year:"numeric"});
}

export function VehicleOilForecastCard({forecast,compact=false}:{
  forecast:VehicleOilForecast|null|undefined;
  compact?:boolean;
}){
  if(!forecast)return null;
  const confidence=confidenceForForecast(forecast);
  const historical=Number(forecast.service_count??0);
  const daily=Number(forecast.km_per_day??0);
  const days=Number(forecast.days_per_5000km??0);
  const interval=Number(forecast.typical_visit_days??0);
  const predictive=confidence!=="INSUFFICIENT" && daily>0;
  return <section className={"vof"+(compact?" is-compact":"")} aria-label="Pronóstico personalizado de mantenimiento">
    <div className="vof-heading">
      <div className="vof-title"><OsIcon name="car" size={17}/> <strong>Ritmo de uso de este vehículo</strong></div>
      <span className={"vof-confidence is-"+confidence.toLowerCase()}>{forecastConfidenceLabel(confidence)}</span>
    </div>
    <div className="vof-metrics">
      <div><small>Cambios anteriores</small><strong>{historical}</strong></div>
      <div><small>Uso diario estimado</small><strong>{predictive?daily.toLocaleString("es-VE",{maximumFractionDigits:1})+" km":"—"}</strong></div>
      <div><small>Tiempo para 5.000 km</small><strong>{predictive&&days>0?"≈ "+days+" días":"—"}</strong></div>
      <div><small>Intervalo entre visitas</small><strong>{interval>0?"≈ "+interval+" días":"—"}</strong></div>
    </div>
    <div className="vof-recommendation">
      <div><small>Próximo contacto recomendado</small>
        <strong>{fmtDate(forecast.recommended_due_date)}</strong></div>
      <span>{forecastReasonLabel(forecast.due_reason)}</span>
    </div>
    {!compact&&<div className="vof-projections">
      <span>5.000 km: <strong>{fmtDate(forecast.projected_km_due_date)}</strong></span>
      <span>Hábito de cambios: <strong>{fmtDate(forecast.projected_habit_due_date)}</strong></span>
      <span>Límite por calendario: <strong>{fmtDate(forecast.calendar_due_date)}</strong></span>
    </div>}
    <p className="vof-explanation"><OsIcon name="shield" size={15}/>{forecastMethodNote(forecast)}</p>
  </section>;
}
